import crypto from 'node:crypto';
import { decode, encode, type Message } from './codec.js';
import { envelope, FrameReader, type Frame } from './connect.js';
import { needsHttp2, postHttp2 } from './h2.js';

/**
 * A two-way conversation with Cursor's agent, over one-way requests.
 *
 * `agent.v1.AgentService/Run` is bidirectional: the client keeps sending messages — tool
 * results, blobs, heartbeats — while the server streams updates back on the same stream.
 * That needs HTTP/2 request streaming, which `fetch` cannot express and which would not
 * survive the audit proxy in front of it either.
 *
 * Cursor's own client ships the way out, because it has the same problem behind a corporate
 * proxy: the same turn can be driven with two ordinary calls that share an id.
 *
 *   BidiAppend  unary, to the API host. One `AgentClientMessage` per call, under a sequence
 *               number, so the server can put them back in order. HTTP/1.1 is fine here.
 *   RunSSE      server-streaming, to the agent host. Takes nothing but the id and answers
 *               with the whole turn. The host is HTTP/2 only — `fetch` cannot speak it, so
 *               that half goes through `postHttp2`. A local test or the audit proxy is still
 *               HTTP/1.1, and stays on `fetch`.
 *
 * The id is a uuid this end makes up and puts on both, `x-request-id` included — which is
 * where Cursor's own client reads it from, so that is where it is sent from here too.
 *
 * Neither call is anything but a POST with a protobuf body, so the audit proxy, the egress
 * gate and the abort signal all work the way they do for every other upstream. The proxy
 * speaks HTTP/2 to the agent host on its own, once h1 gets h2 frames back.
 */

/** The bidirectional RPC, and the server-streaming stand-in that carries it */
export const RUN_SSE_RPC = '/agent.v1.AgentService/RunSSE';

/** Where each client message is posted, on the API host rather than the agent one */
export const APPEND_RPC = '/aiserver.v1.BidiService/BidiAppend';

const CLIENT_MESSAGE = 'agent.v1.AgentClientMessage';
const REQUEST_ID = 'aiserver.v1.BidiRequestId';
const APPEND_REQUEST = 'aiserver.v1.BidiAppendRequest';

/** Where a request actually goes: the audit proxy when one is in use. null means refuse to send. */
export type Egress = (url: string) => { url: string; headers: Record<string, string> } | null;

export interface BidiOptions {
  /** The API host, where BidiAppend lives */
  apiBase: string;
  /** The agent host, where RunSSE lives */
  agentBase: string;
  /** The access token, already exchanged */
  token: string;
  /** The `x-cursor-*` set this client presents with, given the id these two calls share */
  headers: (requestId: string) => Record<string, string>;
  /**
   * The turn this stream is carrying, which is not the stream's own id.
   *
   * Cursor's client keeps the two apart, and a capture of it shows why: when a stream drops
   * and the turn is retried, the bidi id changes and this one does not. It goes out as
   * `x-original-request-id` and is the same value as the run request's `run_id`.
   */
  turnId: string;
  egress: Egress;
  signal: AbortSignal;
}

export class BidiError extends Error {
  constructor(message: string, readonly status = 502) {
    super(message);
  }
}

export class BidiStream {
  /** The id the two calls are joined by, and the one they both report as `x-request-id` */
  readonly requestId = crypto.randomUUID();

  private seqno = 0;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private readonly frames = new FrameReader();
  /** Appends are awaited in order, so seqno n is never posted before n-1 */
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly opts: BidiOptions) {}

  /**
   * Start the turn.
   *
   * Both calls go out before either is awaited, which is the order Cursor's own client uses:
   * the pair is a rendezvous on the id, and neither half can be said to come first.
   */
  async open(first: Message): Promise<void> {
    const run = this.runSSE();
    const appended = this.send(first);
    const res = await run;
    await appended;

    if (!res.ok || !res.body) {
      const detail = (await res.text().catch(() => '')).slice(0, 500);
      throw new BidiError(detail || `Cursor returned ${res.status}`, res.status || 502);
    }
    this.reader = res.body.getReader();
  }

  /** One client message, posted under the next sequence number */
  send(message: Message): Promise<void> {
    const seqno = this.seqno++;
    const body = encode(APPEND_REQUEST, {
      request_id: { request_id: this.requestId },
      append_seqno: seqno,
      /*
       * Hex in `data`, rather than bytes in `data_binary`.
       *
       * Both fields exist and the binary one is the obvious choice — but a capture of the
       * real client shows it sending hex, and the bundle puts the binary encoding behind a
       * feature flag (`bidi_append_binary_encoding`) that was off. Which means binary is the
       * path being rolled out and hex is the one every server is known to accept. Doubling
       * the bytes of a tool result is worth not being the first client to try the other.
       */
      data: Buffer.from(encode(CLIENT_MESSAGE, message)).toString('hex'),
    });

    /*
     * Chained rather than fired: the server puts the messages back in sequence order, and two
     * appends racing means a tool result can be posted before the blob write that has to
     * precede it. The cost is one round trip per message, which a turn spends anyway waiting
     * for whatever it asked for.
     */
    const done = this.tail.then(() => this.append(body, seqno));
    this.tail = done.catch(() => {});
    return done;
  }

  private async append(body: Uint8Array, seqno: number): Promise<void> {
    const out = this.opts.egress(`${this.opts.apiBase}${APPEND_RPC}`);
    if (!out) throw new BidiError('This upstream has no audit proxy configured, so the request was refused', 503);

    const res = await fetch(out.url, {
      method: 'POST',
      headers: {
        ...this.opts.headers(this.requestId),
        'x-original-request-id': this.opts.turnId,
        'content-type': 'application/proto',
        ...out.headers,
      },
      body,
      signal: this.opts.signal,
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      throw new BidiError(
        `Cursor refused message ${seqno} of this turn (HTTP ${res.status}${detail ? `: ${detail}` : ''})`,
        res.status,
      );
    }
    // The response body is an empty message, but it still has to be drained or the socket
    // is held until the garbage collector gets to it
    await res.arrayBuffer().catch(() => undefined);
  }

  private async runSSE(): Promise<Response> {
    const out = this.opts.egress(`${this.opts.agentBase}${RUN_SSE_RPC}`);
    if (!out) throw new BidiError('This upstream has no audit proxy configured, so the request was refused', 503);

    const headers = {
      ...this.opts.headers(this.requestId),
      'x-original-request-id': this.opts.turnId,
      'content-type': 'application/connect+proto',
      'connect-accept-encoding': 'gzip',
      ...out.headers,
    };
    // A server-streaming call still frames its one request message
    const body = envelope(encode(REQUEST_ID, { request_id: this.requestId }));

    if (needsHttp2(out.url)) {
      try {
        return await postHttp2(out.url, { headers, body, signal: this.opts.signal });
      } catch (e) {
        if (this.opts.signal.aborted) throw e;
        throw new BidiError(
          `Could not open Cursor's agent stream over HTTP/2 (${(e as Error).message})`,
          502,
        );
      }
    }

    return fetch(out.url, {
      method: 'POST',
      headers,
      body,
      signal: this.opts.signal,
    });
  }

  /** The turn, frame by frame, as the bytes arrive */
  async *read(): AsyncGenerator<Frame> {
    if (!this.reader) throw new BidiError('this stream has not been opened');
    for (;;) {
      const { done, value } = await this.reader.read();
      if (done || !value) return;
      for (const frame of this.frames.push(value)) yield frame;
    }
  }

  /** Whatever was held back when the stream stopped, which is a truncated frame */
  get pending(): number {
    return this.frames.pending;
  }

  async close(): Promise<void> {
    await this.reader?.cancel().catch(() => {});
    this.reader = undefined;
  }
}

/**
 * A decoded client message, for a test or a probe that wants to see what went out.
 *
 * Reads either carrier: hex in `data`, which is what this sends and what the real client
 * sends, or bytes in `data_binary` for whoever is on the other encoding.
 */
export function decodeAppend(body: Uint8Array): { seqno: number; requestId: string; message: Message } {
  const outer = decode(APPEND_REQUEST, body);
  const id = outer['request_id'] as Message | undefined;
  const hex = typeof outer['data'] === 'string' ? outer['data'] : '';
  const binary = outer['data_binary'];
  const payload = hex
    ? new Uint8Array(Buffer.from(hex, 'hex'))
    : binary instanceof Uint8Array
      ? binary
      : new Uint8Array(0);
  return {
    seqno: Number(outer['append_seqno'] ?? 0),
    requestId: String(id?.['request_id'] ?? ''),
    message: decode(CLIENT_MESSAGE, payload),
  };
}

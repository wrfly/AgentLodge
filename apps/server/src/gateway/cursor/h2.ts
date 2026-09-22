import http2 from 'node:http2';
import { Readable } from 'node:stream';
import zlib from 'node:zlib';

/**
 * A POST over HTTP/2, as a `fetch` Response.
 *
 * Cursor's agent host (`agentn.us.api5.cursor.sh`) does not speak HTTP/1.1: a `fetch` against
 * it dies with `Response does not match the HTTP/1.1 protocol`, because the server answers
 * the TLS handshake with HTTP/2 frames and undici is still reading for `HTTP/`. `BidiAppend`
 * on the API host is fine on HTTP/1.1; this is only the streaming half.
 *
 * `fetch` cannot ask for HTTP/2, so this is `node:http2` wrapped to look like the one call
 * `bidi.ts` already knew how to consume. The audit proxy and the tests stay on `fetch`: they
 * listen over HTTP/1.1, and the proxy — when it is in front — switches the agent host to
 * HTTP/2 on its own the first time h1 gets h2 frames back.
 */

/** Headers HTTP/2 refuses, which a leftover from an HTTP/1.1 client would otherwise send */
const FORBIDDEN = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
  'host',
  'http2-settings',
]);

export interface Http2Post {
  headers: Record<string, string>;
  body: Uint8Array;
  signal: AbortSignal;
}

export async function postHttp2(url: string, opts: Http2Post): Promise<Response> {
  if (opts.signal.aborted) throw abortError(opts.signal);

  const target = new URL(url);
  const session = http2.connect(target.origin);
  // A parked turn can sit here for minutes; the default is already off, and saying so keeps
  // a future Node default from killing the stream the tool result has to come back on
  session.setTimeout(0);

  return new Promise<Response>((resolve, reject) => {
    let settled = false;
    let closed = false;

    const finish = (err?: Error) => {
      if (closed) return;
      closed = true;
      opts.signal.removeEventListener('abort', onAbort);
      if (!session.closed && !session.destroyed) {
        if (err) session.destroy(err);
        else session.close();
      }
    };

    const onAbort = () => {
      const err = abortError(opts.signal);
      finish(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };
    opts.signal.addEventListener('abort', onAbort, { once: true });

    const fail = (err: Error) => {
      finish(err);
      if (!settled) {
        settled = true;
        reject(err);
      }
    };

    session.once('error', fail);

    const outgoing: http2.OutgoingHttpHeaders = {
      ':method': 'POST',
      ':path': `${target.pathname}${target.search}`,
      ':authority': target.host,
      ':scheme': target.protocol.replace(':', ''),
    };
    for (const [name, value] of Object.entries(opts.headers)) {
      const key = name.toLowerCase();
      if (FORBIDDEN.has(key) || key.startsWith(':')) continue;
      outgoing[key] = value;
    }

    const req = session.request(outgoing);
    req.once('error', fail);

    req.once('response', (incoming) => {
      const status = Number(incoming[':status'] ?? 0);
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming)) {
        if (name.startsWith(':') || value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else {
          headers.set(name, String(value));
        }
      }

      /*
       * `fetch` inflates `content-encoding` before the caller sees the body; `http2.request`
       * does not. Connect's own per-message gzip is a frame flag, not this header — this is
       * only the HTTP layer, and only when the server actually compressed the stream.
       */
      const encoding = (headers.get('content-encoding') ?? '').toLowerCase();
      const node: Readable = encoding.includes('gzip')
        ? req.pipe(zlib.createGunzip())
        : encoding.includes('deflate')
          ? req.pipe(zlib.createInflate())
          : req;

      node.once('error', fail);

      /*
       * The session has to outlive this Response: a parked turn keeps reading it after the
       * request that opened it has ended. Close only when the consumer is done, not when
       * the HTTP/2 stream's `close` fires — that can race the last buffered chunk.
       */
      const upstream = Readable.toWeb(node) as ReadableStream<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          const reader = upstream.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) {
                controller.close();
                break;
              }
              if (value) controller.enqueue(value);
            }
          } catch (e) {
            controller.error(e);
          } finally {
            finish();
          }
        },
        cancel() {
          void upstream.cancel().catch(() => {});
          finish();
        },
      });

      settled = true;
      resolve(new Response(body, { status, headers }));
    });

    req.end(opts.body);
  });
}

/**
 * Whether this URL is the one that has to go over HTTP/2.
 *
 * TLS to a real host, not a local test and not the audit proxy: both of those listen over
 * HTTP/1.1, and `http2.connect` at them would send a preface they cannot answer.
 */
export const needsHttp2 = (url: string): boolean => {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
};

const abortError = (signal: AbortSignal): Error =>
  (signal.reason instanceof Error ? signal.reason : new Error('This operation was aborted'));

import crypto from 'node:crypto';
import { accessToken, CursorAuthError } from './auth.js';
import { decode, encode } from './codec.js';
import { envelope } from './connect.js';
import { buildChatRequest, type ChatRequest } from './request.js';
import { CursorToChat, PLAIN } from './stream.js';
import { BUNDLE_VERSION } from './schema.generated.js';

/**
 * The Cursor upstream.
 *
 * Cursor has no HTTP API to point an `ANTHROPIC_BASE_URL` at: its clients speak
 * Connect-RPC with protobuf bodies to api2.cursor.sh, over a schema that is published
 * nowhere and read out of the client instead (scripts/extract-cursor-schema.mjs). This
 * module is the whole of that conversation — build the request, frame it, read the stream
 * back — and it hands the rest of the gateway something it already knows how to handle: a
 * Chat Completions SSE response.
 *
 * That last part is the design. `resolveUpstream` gives a Cursor provider `wire: 'chat'`,
 * so gateway/translate.ts has already turned Claude Code's Messages or Codex's Responses
 * into Chat Completions on the way in, and turns the stream back on the way out. Both CLIs
 * work against Cursor without either of them, or the relay between them, knowing it.
 *
 * ## What this is not
 *
 * Not the `cursor-agent` CLI's protocol. That one (`agent.v1.AgentService`) runs the agent
 * loop on Cursor's side and calls back for tool execution — the opposite of what a client
 * holding its own tools needs. This uses the IDE's chat RPC, where the model answers and
 * the caller keeps its loop.
 */

/** Where Cursor's API lives when a provider does not say otherwise */
export const CURSOR_API = 'https://api2.cursor.sh';

/** The plain server-streaming chat RPC: one POST, one stream back */
export const CHAT_RPC = '/aiserver.v1.ChatService/StreamUnifiedChat';

/** The model list, a unary call on the same service family */
const MODELS_RPC = '/aiserver.v1.AiService/AvailableModels';

/**
 * How this client describes itself.
 *
 * The CLI's own shape, not the IDE's: the credential behind this is an account API key,
 * which is what the CLI authenticates with, and the IDE additionally sends an
 * `x-cursor-checksum` built from a machine identity this process does not have and should
 * not invent.
 */
function clientHeaders(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'connect-protocol-version': '1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': `cli-${BUNDLE_VERSION}`,
    'x-request-id': crypto.randomUUID(),
    // Cursor's own switch for "do not keep this". A gateway relaying other people's work
    // has no standing to opt their code into anything, so it is on and not configurable.
    'x-ghost-mode': 'true',
  };
}

/** Where a request actually goes: the audit proxy when one is in use. null means refuse to send. */
export type Egress = (url: string) => { url: string; headers: Record<string, string> } | null;

const direct: Egress = (url) => ({ url, headers: {} });

export interface FetchOptions {
  /** The provider's base url, or CURSOR_API when it is blank */
  baseUrl?: string;
  /** The credential as configured: a Cursor API key, or an access token already */
  secret: string;
  /** The request, already in Chat Completions shape */
  body: ChatRequest;
  /** What this upstream calls the model */
  model: string;
  conversationId?: string;
  signal: AbortSignal;
  egress?: Egress;
}

/**
 * One turn against Cursor, as a Chat Completions response.
 *
 * Returns a Response rather than a stream so the relay in gateway/index.ts needs no branch
 * of its own: a stream comes back as `text/event-stream` and a refusal as the JSON error
 * body that the same code path already knows how to relay and translate.
 */
export async function fetchCursor(opts: FetchOptions): Promise<Response> {
  const base = (opts.baseUrl || CURSOR_API).replace(/\/+$/, '');
  const route = opts.egress ?? direct;

  let token: string;
  try {
    token = await accessToken(opts.secret, base, { signal: opts.signal });
  } catch (e) {
    // An authentication problem is the deployment's, not the model's: a 401 so the client
    // stops rather than retrying, carrying the sentence an administrator has to read
    return jsonError(e instanceof CursorAuthError ? 401 : 502, (e as Error).message);
  }

  const message = buildChatRequest(opts.body, {
    model: opts.model,
    conversationId: opts.conversationId,
  });
  const payload = envelope(encode('aiserver.v1.StreamUnifiedChatRequest', message));
  const promptChars = JSON.stringify(opts.body ?? {}).length;

  const send = async (bearer: string): Promise<Response> => {
    const out = route(`${base}${CHAT_RPC}`);
    if (!out) return jsonError(503, 'This upstream has no audit proxy configured, so the request was refused');
    return fetch(out.url, {
      method: 'POST',
      headers: {
        ...clientHeaders(bearer),
        'content-type': 'application/connect+proto',
        ...out.headers,
      },
      body: payload,
      signal: opts.signal,
    });
  };

  let res: Response;
  try {
    res = await send(token);
    /*
     * A token that was refused. It may have been revoked rather than aged out — the cache
     * cannot tell the difference — so the one retry mints a new one and tries again. Only
     * once: a key that is genuinely invalid would otherwise be exchanged on every request.
     */
    if (res.status === 401 || res.status === 403) {
      const fresh = await accessToken(opts.secret, base, { force: true, signal: opts.signal });
      if (fresh !== token) res = await send(fresh);
    }
  } catch (e) {
    if (opts.signal.aborted) throw e; // the caller's own abort, which it reports its own way
    return jsonError(502, `Could not reach Cursor: ${(e as Error).message}`);
  }

  if (!res.ok || !res.body) {
    const detail = (await res.text().catch(() => '')).slice(0, 500);
    return jsonError(res.status || 502, detail || `Cursor returned ${res.status}`);
  }

  const conv = new CursorToChat({ model: opts.model, promptChars, responseType: PLAIN });
  const reader = res.body.getReader();
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      let chunk: { done?: boolean; value?: Uint8Array };
      try {
        chunk = await reader.read();
      } catch (e) {
        // The connection died mid-answer. end() says so in band, which is the only way
        // left to tell a client that has already had its 200
        controller.enqueue(encoder.encode(conv.end() || sseError((e as Error).message)));
        controller.close();
        return;
      }
      if (chunk.done || !chunk.value) {
        const tail = conv.end();
        if (tail) controller.enqueue(encoder.encode(tail));
        controller.close();
        return;
      }
      const out = conv.push(chunk.value);
      if (out) controller.enqueue(encoder.encode(out));
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

/** A refusal in the shape the relay reads: JSON, under a status, with the upstream's words */
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'upstream_error' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The same thing once a stream has begun and there is no status left to say it with */
function sseError(message: string): string {
  return `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`;
}

/**
 * What models this account can use.
 *
 * A unary Connect call — `application/proto`, the bare message, no envelopes — which is
 * the one shape on this protocol that is not framed.
 */
export async function fetchCursorModels(
  secret: string,
  baseUrl: string | undefined,
  egress: Egress = direct,
): Promise<{ models: string[]; error?: string }> {
  const base = (baseUrl || CURSOR_API).replace(/\/+$/, '');
  const out = egress(`${base}${MODELS_RPC}`);
  if (!out) return { models: [], error: 'This provider has no audit proxy configured, so the request was refused' };

  try {
    const token = await accessToken(secret, base);
    const res = await fetch(out.url, {
      method: 'POST',
      headers: { ...clientHeaders(token), 'content-type': 'application/proto', ...out.headers },
      body: encode('aiserver.v1.AvailableModelsRequest', { is_nightly: false }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 200);
      return { models: [], error: `Cursor returned ${res.status}${detail ? `: ${detail}` : ''}` };
    }
    const body = decode('aiserver.v1.AvailableModelsResponse', new Uint8Array(await res.arrayBuffer()));
    /*
     * Two lists, and the structured one is the better answer: `model_names` is the flat
     * legacy field, while `models[]` carries what each name actually is. Falling back to
     * the flat one keeps this working if the structured field goes away.
     */
    const detailed = Array.isArray(body['models']) ? (body['models'] as Array<Record<string, unknown>>) : [];
    const names = detailed
      .map((m) => m['name'])
      .filter((n): n is string => typeof n === 'string' && n.length > 0);
    const flat = Array.isArray(body['model_names'])
      ? (body['model_names'] as unknown[]).filter((n): n is string => typeof n === 'string')
      : [];
    const models = names.length ? names : flat;
    return models.length ? { models } : { models: [], error: 'Cursor returned an empty model list' };
  } catch (e) {
    return { models: [], error: `Could not reach Cursor: ${(e as Error).message}` };
  }
}

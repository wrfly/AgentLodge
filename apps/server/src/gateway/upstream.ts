import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { config } from '../core/config.js';
import * as models from '../core/db/models.js';
import * as providers from '../core/db/providers.js';
import type { Wire } from './usage-parser.js';

/**
 * Resolving the upstream: turning the model a request asks for into where it goes and
 * whether it needs translating.
 *
 * The model decides, not a global switch. A name selects a row in the models table, that
 * row names a provider, and the provider says how to connect. Two upstreams offering the
 * same model are two rows; the one with the lowest priority wins.
 *
 * The gateway knows no vendor names, only four kinds. Adding a new third-party API is a
 * row in the console, not a code change.
 */

export interface Resolved {
  /** The real upstream address. With the audit proxy on this is not what we fetch, but where the proxy should relay to. */
  url: string;
  /** The protocol the upstream actually speaks, which decides how usage is parsed */
  wire: Wire;
  /** Request and response need translating between the two protocols */
  translate: boolean;
  apiKey: string;
  provider: providers.Provider;
  /**
   * The name to put in the outgoing body, when the upstream calls this model something
   * else. Undefined leaves what the client sent alone.
   */
  upstreamModel?: string;
}

/**
 * Which row serves this request.
 *
 * An exact name is routed by its row. Anything else — no model at all, an alias the CLI
 * expands on its own, a name nobody configured — falls back to the first enabled row,
 * forwarded with the name the client sent. That fallback is what keeps a deployment
 * working when a CLI asks for `sonnet` and the model list is written in full names.
 */
function route(model?: string): { model?: models.Model; rename: boolean } | undefined {
  const name = (model ?? '').trim();
  if (name) {
    const [match] = models.candidates(name);
    if (match) return { model: match, rename: Boolean(match.upstreamName) };
  }
  const [fallback] = models.candidates(models.names()[0] ?? '');
  return fallback ? { model: fallback, rename: false } : undefined;
}

export async function resolveUpstream(
  wire: Wire,
  originalUrl: string,
  model?: string,
): Promise<Resolved | undefined> {
  const chosen = route(model);
  if (!chosen?.model) return undefined;
  const p = providers.findById(chosen.model.providerId);
  if (!p) return undefined;

  const upstreamModel = chosen.rename ? chosen.model.upstreamName : undefined;
  const base = p.baseUrl.replace(/\/+$/, '');
  // Awaited because a credential may live in the credential manager, one socket call
  // away (core/db/providers.ts). A key in the database or in a file answers without
  // suspending at all.
  const apiKey = (await providers.secretOf(p.id)) ?? '';

  // An upstream that only speaks chat: requests from both CLIs need translating
  if (p.kind === 'openai-chat') {
    return { url: `${base}/chat/completions`, wire: 'chat', translate: wire !== 'chat', apiKey, provider: p, upstreamModel };
  }

  // The mock upstream and the local agent never use HTTP; the URL is a placeholder
  if (p.kind === 'mock' || p.kind === 'local-agent') {
    return { url: `internal:${p.kind}`, wire, translate: false, apiKey, provider: p, upstreamModel };
  }

  /*
   * anthropic-native: an endpoint that speaks Anthropic Messages natively. Two shapes
   * qualify:
   *
   *   official or your own gateway   base = https://api.anthropic.com
   *   DeepSeek's compatibility layer   base = https://api.deepseek.com/anthropic
   *
   * The prefix used to be hardcoded here as `${base}/anthropic${path}`, so an official
   * base URL produced `api.anthropic.com/anthropic/v1/messages` — a 404. That prefix is
   * DeepSeek's own routing, not part of the protocol, and it now belongs in base_url;
   * this layer knows no vendors. For the official endpoint, write
   * `https://api.anthropic.com` with no prefix.
   *
   * The other two wires use the root path rather than the compatibility layer, so the
   * prefix is stripped for them.
   */
  const root = base.replace(/\/anthropic$/, '');
  if (wire === 'anthropic') {
    const qs = originalUrl.includes('?') ? originalUrl.slice(originalUrl.indexOf('?')) : '';
    const path = originalUrl.split('?')[0] ?? '/v1/messages';
    return { url: `${base}${path}${qs}`, wire, translate: false, apiKey, provider: p, upstreamModel };
  }
  if (wire === 'chat') {
    return { url: `${root}/chat/completions`, wire, translate: false, apiKey, provider: p, upstreamModel };
  }
  return { url: `${root}/responses`, wire, translate: false, apiKey, provider: p, upstreamModel };
}

/* ---------------- The built-in mock upstream ---------------- */

/**
 * No network, no cost: a valid response built inside the gateway.
 *
 * Semantically the same as scripts/mock-upstream.mjs, except this one needs no extra
 * process — switching the provider to the mock is enough, which suits working on the
 * interface.
 */
export function mockStream(wire: Wire, body: unknown, override?: string): string {
  const prompt = lastUserText(body);
  const text =
    override ??
    (prompt
      ? `[MOCK] This is the built-in mock upstream. No tokens were spent.\n\nYou said: ${prompt}`
      : '[MOCK] This is the built-in mock upstream. No tokens were spent.');

  const size = JSON.stringify(body ?? {}).length;
  const input = Math.max(Math.round(size / 3), 12);
  const u = {
    input: Math.round(input * 0.1),
    cacheRead: Math.round(input * 0.8),
    cacheWrite: Math.round(input * 0.1),
    output: Math.max(Math.round(text.length / 3), 4),
  };

  const ev = (event: string, data: unknown) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

  if (wire === 'anthropic') {
    return (
      ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock', type: 'message', role: 'assistant', model: 'mock',
          content: [], stop_reason: null, stop_sequence: null,
          usage: {
            input_tokens: u.input,
            cache_read_input_tokens: u.cacheRead,
            cache_creation_input_tokens: u.cacheWrite,
            output_tokens: 1,
          },
        },
      }) +
      ev('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }) +
      ev('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }) +
      ev('content_block_stop', { type: 'content_block_stop', index: 0 }) +
      ev('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: u.output },
      }) +
      ev('message_stop', { type: 'message_stop' })
    );
  }

  if (wire === 'chat') {
    const base = { id: 'chatcmpl_mock', object: 'chat.completion.chunk', model: 'mock' };
    return (
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] })}\n\n` +
      `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n` +
      `data: ${JSON.stringify({ ...base, choices: [], usage: { prompt_tokens: u.input + u.cacheRead, completion_tokens: u.output, prompt_tokens_details: { cached_tokens: u.cacheRead } } })}\n\n` +
      'data: [DONE]\n\n'
    );
  }

  const item = {
    type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
    content: [{ type: 'output_text', text, annotations: [] }],
  };
  return (
    ev('response.created', { type: 'response.created', response: { id: 'resp_mock', model: 'mock', status: 'in_progress', output: [] } }) +
    ev('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } }) +
    ev('response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_mock', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } }) +
    ev('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0, delta: text }) +
    ev('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_mock', output_index: 0, content_index: 0, text }) +
    ev('response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_mock', output_index: 0, content_index: 0, part: { type: 'output_text', text, annotations: [] } }) +
    ev('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item }) +
    ev('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_mock', model: 'mock', status: 'completed', output: [item],
        usage: {
          input_tokens: u.input + u.cacheRead + u.cacheWrite,
          output_tokens: u.output,
          total_tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
          input_tokens_details: { cached_tokens: u.cacheRead },
        },
      },
    })
  );
}

/* ---------------- A CLI on the host, for testing only ---------------- */

/**
 * Replace the upstream hop with a codex on the host, taking **only the final text**.
 *
 * ⚠️ The boundary that matters: that outer codex is a complete agent of its own, and its
 * tool loop would run on the host. So it is forced into a read-only sandbox and told
 * explicitly not to touch files, which degrades it to a plain text model. The consequence
 * is that the agent in the container never receives tool_calls, so the tool path cannot be
 * exercised this way.
 *
 * Smoke tests only. Pointing multi-user production traffic here would not work — one
 * process at a time — and would exceed what a personal subscription covers.
 */
export async function localAgentText(body: unknown, signal: AbortSignal): Promise<string> {
  const prompt = lastUserText(body) || 'Hello';

  return new Promise((resolve, reject) => {
    const child = spawn(
      config.codexBin,
      [
        'exec',
        '--skip-git-repo-check',
        '-c', 'sandbox_mode="read-only"',
        '--json',
        prompt,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let out = '';
    let err = '';
    const onAbort = () => child.kill('SIGINT');
    signal.addEventListener('abort', onAbort);

    child.stdout.on('data', (c: Buffer) => (out += c.toString()));
    child.stderr.on('data', (c: Buffer) => (err += c.toString()));

    child.on('error', (e) => {
      signal.removeEventListener('abort', onAbort);
      reject(e);
    });

    child.on('close', () => {
      signal.removeEventListener('abort', onAbort);
      const text = lastAgentMessage(out);
      if (text) return resolve(text);
      reject(new Error(err.slice(0, 300) || 'The local agent produced no text'));
    });
  });
}

/**
 * Take the last agent message from the event stream of `codex exec --json`.
 *
 * The event shape is the same one agents/codex.ts parses:
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 */
function lastAgentMessage(stdout: string): string {
  let text = '';
  for (const line of stdout.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const ev = JSON.parse(t) as { type?: string; item?: { type?: string; text?: string } };
      if (ev.type !== 'item.completed' && ev.type !== 'item.updated') continue;
      if (ev.item?.type === 'agent_message' && typeof ev.item.text === 'string') text = ev.item.text;
    } catch {
      /* Not a JSON line: skip it */
    }
  }
  return text.trim();
}

/* ---------------- Small shared helpers ---------------- */

/** Dig out what the user said this turn, from a request body in any of the protocols */
export function lastUserText(body: unknown): string {
  const b = (body ?? {}) as {
    messages?: { role?: string; content?: unknown }[];
    input?: { type?: string; role?: string; content?: { text?: string }[] }[];
  };

  const strip = (s: string) => s.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

  for (let i = (b.messages?.length ?? 0) - 1; i >= 0; i--) {
    const m = b.messages![i]!;
    if (m.role && m.role !== 'user') continue;
    const c = m.content;
    if (typeof c === 'string') {
      const t = strip(c);
      if (t) return t.slice(0, 4000);
    } else if (Array.isArray(c)) {
      for (let j = c.length - 1; j >= 0; j--) {
        const part = c[j] as { type?: string; text?: string };
        if (part.type !== 'text' && part.type !== 'input_text') continue;
        const t = strip(String(part.text ?? ''));
        if (t) return t.slice(0, 4000);
      }
    }
  }

  for (let i = (b.input?.length ?? 0) - 1; i >= 0; i--) {
    const item = b.input![i]!;
    if (item.type && item.type !== 'message') continue;
    if (item.role && item.role !== 'user') continue;
    const t = strip((item.content ?? []).map((c) => c.text ?? '').join('\n'));
    if (t) return t.slice(0, 4000);
  }

  return '';
}

/* ---------------- Outbound request headers ---------------- */

/** The beta flag an OAuth token requires against the official endpoint */
const OAUTH_BETA = 'oauth-2025-04-20';

/**
 * Whether this credential is an OAuth access token or an API key.
 *
 * What Claude Code writes to ~/.claude/.credentials.json after signing in is an **OAuth
 * access token** (sk-ant-oat…), a different thing from a console-issued API key
 * (sk-ant-api…), and the official endpoint accepts them through different channels:
 *
 *   API key      x-api-key: sk-ant-api...
 *   OAuth token  Authorization: Bearer sk-ant-oat...  ＋ anthropic-beta: oauth-2025-04-20
 *
 * So putting an oat token in x-api-key is not a harmless extra header — it is **sending an
 * invalid API key**.
 */
export function isOAuthToken(apiKey: string): boolean {
  return apiKey.startsWith('sk-ant-oat');
}

/**
 * Merge anthropic-beta.
 *
 * It is a comma-separated list, so it has to be merged rather than overwritten: writing it
 * flat would drop the prompt caching and fine-grained tool streaming the client asked for,
 * without an error — those features would simply stop working.
 */
export function mergeBeta(fromClient: string | string[] | undefined, extra?: string): string | undefined {
  const raw = Array.isArray(fromClient) ? fromClient.join(',') : (fromClient ?? '');
  // `extra` can be a list too, and pushing it whole would hide a duplicate inside it
  const parts = [...raw.split(','), ...(extra ? extra.split(',') : [])]
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.length ? [...new Set(parts)].join(',') : undefined;
}

/**
 * Client headers that may go upstream unchanged: the ones that only say who sent this.
 *
 * The test is **could this header change where the request goes or who it claims to be**.
 * Anything that could, stays out:
 *   x-forwarded-*            decides where the audit proxy relays to; changing it is SSRF
 *   authorization/x-api-key  the credential itself, which has to become the upstream's
 *   host/content-length/connection/accept-encoding/transfer-encoding
 *                            hop-by-hop, recomputed by the outbound layer
 *   anthropic-*              computed here: version has a default, beta is merged
 *
 * Forwarding them is not cosmetic: what runs in an agent container **really is Claude
 * Code**, and with a key read from a file we are holding its OAuth credential too. Letting
 * the upstream see a client identity that matches the credential is more truthful than
 * sending an anonymous user agent.
 */
const PASSTHROUGH_EXACT = new Set(['user-agent', 'x-app', 'x-claude-code-session-id']);

/**
 * What Claude Code calls itself, used when the caller said nothing.
 *
 * Three of our own callers reach the upstream without going through a CLI: naming a
 * conversation, summarising one, and pulling an upstream's model list. On a subscription
 * those land on the same OAuth credential as the agent containers, and a request that
 * carries the credential but describes itself as nothing at all is the odd one out. The
 * version is the one the agent image ships and the wording is what a captured request
 * carried; a client that sends its own user-agent keeps it, since the allowlist runs first.
 */
const CLI_USER_AGENT = 'claude-cli/2.1.224 (external, sdk-cli)';

/** What an HTTP client calls itself when nobody has given it a name */
const BARE_RUNTIME = /^(node|undici|node-fetch|got|axios)(\/|$)/i;

/**
 * The SDK's description of itself, which Claude Code sends because it is built on that SDK.
 *
 * Real where this process can answer truthfully — the architecture, the system, the node it
 * runs on — and copied from a captured request where it is describing the client library
 * rather than the machine.
 */
const STAINLESS: Record<string, string> = {
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '0.94.0',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': process.version,
  'x-stainless-arch': process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : process.arch,
  'x-stainless-os': process.platform === 'linux' ? 'Linux' : process.platform === 'darwin' ? 'MacOS' : 'Windows',
  'x-stainless-retry-count': '0',
  'x-stainless-timeout': '600',
};

/** What marks a request as Claude Code's, alongside the OAuth beta */
const CLAUDE_CODE_BETA = 'claude-code-20250219';

/** The first system block Claude Code sends, which is how the upstream attributes the call */
const BILLING_SYSTEM = 'x-anthropic-billing-header: cc_version=2.1.224.ddf; cc_entrypoint=sdk-cli;';

/**
 * The query Claude Code puts on /v1/messages.
 *
 * Left alone when the caller already asked for something: a client that sends its own
 * query knows what it wants.
 */
export function betaUrl(url: string): string {
  if (/[?&]beta=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}beta=true`;
}

type SystemBlock = { type: 'text'; text: string };

/**
 * Put the billing line at the front of the system prompt, if it is not there already.
 *
 * Claude Code sends it on every request and the upstream reads the entrypoint from it. Our
 * own calls — naming a conversation, summarising one — carry no system prompt at all, and
 * a subscription request with none is the one that does not look like the client holding
 * the credential.
 */
export function withBillingSystem(body: unknown): unknown {
  if (!body || typeof body !== 'object') return body;
  const b = body as { system?: string | SystemBlock[] };
  const head: SystemBlock = { type: 'text', text: BILLING_SYSTEM };

  if (b.system === undefined) return { ...b, system: [head] };
  if (typeof b.system === 'string') {
    return b.system.startsWith('x-anthropic-billing-header:')
      ? b
      : { ...b, system: [head, { type: 'text', text: b.system }] };
  }
  if (!Array.isArray(b.system)) return b;
  const first = b.system[0];
  if (first && typeof first.text === 'string' && first.text.startsWith('x-anthropic-billing-header:')) return b;
  return { ...b, system: [head, ...b.system] };
}
const PASSTHROUGH_PREFIX = ['x-stainless-'];

function passthrough(reqHeaders: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rawKey, v] of Object.entries(reqHeaders)) {
    if (typeof v !== 'string') continue;
    const k = rawKey.toLowerCase();
    if (PASSTHROUGH_EXACT.has(k) || PASSTHROUGH_PREFIX.some((pre) => k.startsWith(pre))) out[k] = v;
  }
  return out;
}

/**
 * The headers used upstream. Client headers **do not pass through by default**; the
 * allowlist above and the few exceptions below are all that do.
 *
 * Not passing them through is a security boundary, not laziness: the audit proxy decides
 * where to relay from `x-forwarded-host` (see egressTarget in index.ts). Carry client
 * headers through and an agent container could set that itself, redirecting its traffic to
 * any host on the proxy's allowlist — an SSRF from inside a container. The cost is losing
 * x-stainless-*, x-app, user-agent and x-claude-code-session-id, which are the SDK's and
 * CLI's own descriptions of themselves; the Messages API does not require them and a
 * request stands without them.
 *
 * Authentication branches on the credential kind. An API key goes in both headers —
 * DeepSeek's compatibility layer reads Authorization, the official endpoint reads
 * x-api-key, and the same key to the same address exposes nothing extra. An OAuth token
 * can only go in Authorization; see isOAuthToken.
 *
 * `anthropic-beta` has to be forwarded. Claude Code uses it to turn on prompt caching,
 * fine-grained tool streaming and the like. Swallowing it raises no error and simply makes
 * those features stop, most visibly against the official endpoint. This project has been
 * caught twice already by that shape of bug — usage reading zero, and events lost when the
 * processes were split.
 */
export function outboundHeaders(
  reqHeaders: Record<string, string | string[] | undefined>,
  wire: Wire,
  apiKey: string,
  /**
   * The conversation this request belongs to, used as the session id when the caller sent
   * none. A conversation is the closest thing here to a CLI session, and the id is already
   * a uuid; with no conversation — an api key, or one of our own internal calls — each
   * request gets one of its own.
   */
  session?: string,
): Record<string, string> {
  const accept = reqHeaders.accept;
  // The allowlist goes first and our own headers after, so ours always win on a name
  // collision — otherwise a container sending an authorization could displace the upstream
  // credential
  const h: Record<string, string> = {
    ...passthrough(reqHeaders),
    authorization: `Bearer ${apiKey}`,
    'content-type': 'application/json',
    accept: (typeof accept === 'string' ? accept : undefined) ?? 'application/json',
  };
  if (wire === 'anthropic') {
    const oauth = isOAuthToken(apiKey);

    /*
     * Filled in, never overwritten: whatever the client sent about itself is already in h.
     *
     * Only on a subscription. That credential is Claude Code's, and a request carrying it
     * should look like the client it was issued to. An API key is billed to an API account
     * whoever sends it, and nothing upstream asks who that is — inventing a claude-cli
     * identity for a request that is not the CLI's would be describing it wrongly for no
     * gain. DeepSeek's compatibility layer, reached on this same wire, gets neither.
     */
    if (oauth) {
      // `??=` is not enough for this one: Node's fetch puts `user-agent: node` on every
      // request it makes, so our own callers arrive with the slot already filled by a
      // runtime that is not a client. A real client's name is left alone.
      if (!h['user-agent'] || BARE_RUNTIME.test(h['user-agent'])) h['user-agent'] = CLI_USER_AGENT;
      h['x-app'] ??= 'cli';
      h['x-claude-code-session-id'] ??= session || crypto.randomUUID();
      // The whole set or none of it. Filled key by key, a caller that sent three of its
      // own got the rest from this host: `x-stainless-lang: python` alongside a Node
      // runtime version and this machine's OS is a fingerprint no real client produces,
      // which is the opposite of what describing yourself as one is for. A caller that
      // named itself is left to describe itself completely.
      if (!Object.keys(h).some((k) => k.startsWith('x-stainless-'))) {
        for (const [k, v] of Object.entries(STAINLESS)) h[k] = v;
      }
    }

    if (!oauth) h['x-api-key'] = apiKey;

    const version = reqHeaders['anthropic-version'];
    h['anthropic-version'] = (typeof version === 'string' ? version : undefined) ?? '2023-06-01';

    // The two betas a subscription request carries. An API key gets neither: an endpoint
    // that is not Anthropic is reached on the same wire, and unknown betas are its problem.
    const beta = mergeBeta(reqHeaders['anthropic-beta'], oauth ? `${CLAUDE_CODE_BETA},${OAUTH_BETA}` : undefined);
    if (beta) h['anthropic-beta'] = beta;
  }
  return h;
}

#!/usr/bin/env node
/**
 * llm-trace-proxy
 *
 * A zero-dependency transparent forwarding proxy that captures everything, for watching the
 * API traffic Claude Code and the Codex CLI actually send.
 *
 *   client (Claude Code / Codex)  ->  http://127.0.0.1:8787  ->  the official upstream
 *
 * Requests go out as they came in (only Host and accept-encoding change) and responses come
 * back untouched, while request headers, request body, response headers and response body —
 * SSE event by event — are written to traces/.
 */

'use strict';

const http = require('node:http');
const https = require('node:https');
const http2 = require('node:http2');
const zlib = require('node:zlib');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');
const ui = require('./server.js');

// ---------------------------------------------------------------- Configuration

const PORT = Number(process.env.PROXY_PORT || 8787);
const HOST = process.env.PROXY_HOST || '127.0.0.1';
const TRACE_DIR = process.env.TRACE_DIR || path.join(__dirname, 'traces');
// HTTP/1.1 by default: Claude Code's ClientHello advertises ALPN ["http/1.1"] and nothing
// else, so h1 is what it negotiates going direct, and matching that stays closest to the
// real thing. PROXY_HTTP2=1 switches to h2.
const USE_HTTP2 = process.env.PROXY_HTTP2 === '1';
// accept-encoding is left alone by default: compressed bytes reach the client exactly as
// they arrived, and decompression happens only for the trace. PROXY_IDENTITY=1 asks the
// upstream not to compress — cheaper, but no longer a faithful copy of the traffic.
const FORCE_IDENTITY = process.env.PROXY_IDENTITY === '1';
// Redact API keys and tokens. PROXY_REDACT=0 records them verbatim.
const REDACT = process.env.PROXY_REDACT !== '0';

// ---- Pinning device_id
// Claude Code puts device_id in JSON nested inside the body's metadata.user_id. It comes
// from the userID field in ~/.claude.json, so a different HOME — a fresh container each
// time, say — means a different value.
//   PROXY_DEVICE_ID=<value>   rewrite every one to this value
//   PROXY_DEVICE_ID=sticky    remember the first value seen, persist it, and reuse it
// With this on the body is modified and the proxy is no longer a pure passthrough, so every
// rewrite goes into the trace.
// device_id only; account_uuid is left alone, because that one is the account's identity.
const DEVICE_ID_MODE = process.env.PROXY_DEVICE_ID || '';

// ---- The recording blocklist. A match is forwarded as usual but never written to disk,
//      never indexed, and never logged.
// Entries take globs (* matches anything) and an optional method prefix:
//   /favicon.ico        that path, any method
//   HEAD /api/hello     HEAD only
//   /v1/models*         prefix wildcard
const TRACE_SKIP = (process.env.PROXY_TRACE_SKIP ?? '')
  .split(',').map((x) => x.trim()).filter(Boolean);

// A browser opening the interface asks for these on its own. They are not API traffic, and
// forwarding them upstream only earns a 404, so the proxy answers them itself — nothing goes
// out and nothing is recorded.
const BROWSER_NOISE = ['/favicon.ico', '/robots.txt', '/apple-touch-icon.png', '/apple-touch-icon-precomposed.png'];

// ---- The concurrency gate: caps in-flight upstream requests, and queues the rest.
// Off by default: set too low it drags Claude Code down, because a streaming request holds
// its slot for a long time. Turn it on against your account's real limit once you start
// seeing 429s — cheaper than being refused and retrying.
const MAX_CONCURRENT = Number(process.env.PROXY_MAX_CONCURRENT ?? 0);
const QUEUE_MAX = Number(process.env.PROXY_QUEUE_MAX ?? 200);
const QUEUE_TIMEOUT_MS = Number(process.env.PROXY_QUEUE_TIMEOUT_MS ?? 120_000);

// ---- Retries, and only while not one byte has reached the client yet.
// Once the response starts forwarding, retrying is off the table: the upstream generates
// from scratch, the client receives a second message_start, and the SSE stream is ruined.
// The Anthropic API has no way to resume.
const MAX_RETRY = Number(process.env.PROXY_RETRY ?? 2);
const RETRY_BASE_MS = Number(process.env.PROXY_RETRY_BASE_MS || 500);
const RETRY_MAX_MS = Number(process.env.PROXY_RETRY_MAX_MS || 30_000);
// The fallback list for when the upstream sends no x-should-retry. 500 is deliberately
// absent: a 500 can mean "handled, but the reply failed", and retrying risks being billed
// twice. These others generally mean the request was never processed at all.
const RETRY_STATUS = new Set(
  (process.env.PROXY_RETRY_STATUS || '429,502,503,504,529').split(',').map((x) => Number(x.trim()))
);
// Connection-level errors. All of these happen before any response header arrives, which
// means the upstream never got a result back to us
const RETRY_ERR_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
]);

// ---- Retention. Any of the three ceilings being hit prunes the oldest records; 0 disables
//      that one.
// A trace runs about 100-300 KB, nine tenths of it request.body.json, which carries the
// whole conversation history
//
// These, like the allowlist, are **changeable at runtime** through /__admin/config, so they
// cannot be consts referenced directly. They live in runtimeCfg, are written to disk when
// changed, and survive a restart. The environment supplies initial values only.
const ENV_MAX_COUNT = Number(process.env.TRACE_MAX_COUNT ?? 1000);
const ENV_MAX_BYTES = Number(process.env.TRACE_MAX_MB ?? 1024) * 1024 * 1024;
const ENV_MAX_AGE_MS = Number(process.env.TRACE_MAX_DAYS ?? 7) * 86400_000;
// Check for pruning once every this many requests, rather than scanning the directory each time
const PRUNE_EVERY = Number(process.env.TRACE_PRUNE_EVERY || 25);

// Where the viewer is mounted. An empty string means not at all, and the standalone
// server.js takes over. The official API only uses /v1/* and /api/*, so this prefix cannot
// collide with it.
const UI_PREFIX = process.env.PROXY_UI_PREFIX ?? '/__trace';

const ANTHROPIC = process.env.ANTHROPIC_UPSTREAM || 'https://api.anthropic.com';
const OPENAI = process.env.OPENAI_UPSTREAM || 'https://api.openai.com';
// Signed in with a ChatGPT subscription, Codex talks to chatgpt.com rather than api.openai.com
const CHATGPT = process.env.CHATGPT_UPSTREAM || 'https://chatgpt.com';

const SECRET_HEADERS = new Set([
  'x-api-key',
  'authorization',
  'cookie',
  'proxy-authorization',
  'openai-api-key',
]);

// Choosing the upstream: Anthropic by default, everything else routed by path. UPSTREAM_URL
// pins it.
const OPENAI_PATHS = [
  '/v1/responses',
  '/v1/chat/completions',
  '/v1/completions',
  '/v1/embeddings',
  '/v1/moderations',
];
// The path subscription-based Codex takes (auth_mode=chatgpt and OPENAI_API_KEY=null in auth.json)
const CHATGPT_PATHS = ['/backend-api'];

/* ── Routing by forwarded host ─────────────────────────────────────────────────
 *
 * Lets the caller name the destination per request, so one proxy instance serves many
 * upstreams instead of one process per upstream.
 *
 * Why not simply set `Host`, the `curl 1.2.3.4 -H "Host: api.deepseek.com"` approach: the
 * caller is the AgentLodge gateway, which uses Node's `fetch`, and undici treats `Host` as a
 * forbidden header — **dropping it silently, with no error**, as trying it confirms. Setting
 * Host would mean moving the gateway's egress off fetch and onto node:http, which means
 * rewriting the SSE passthrough and the usage sniffing — far more risk than the change is
 * worth. `x-forwarded-host` and `x-forwarded-proto` are how reverse-proxy chains say the
 * same thing, and fetch lets them through.
 *
 *
 * `Host` cannot carry a scheme anyway, so proto needs a header of its own regardless.
 *
 * Security: a destination a header can name is an open forwarder (SSRF). Hence
 *   1. off by default, and PROXY_DYNAMIC_UPSTREAM=1 has to be explicit
 *   2. PROXY_UPSTREAM_ALLOW takes an allowlist of comma-separated hosts; anything else is a 403
 *   3. a pinned UPSTREAM_URL wins, so a single-upstream deployment behaves exactly as before
 *   4. both headers are stripped before forwarding, so neither leaks upstream
 */
/* ── Runtime configuration ────────────────────────────────────────────────────
 *
 * The allowlist and the retention policy have to be editable from the console, so they
 * cannot be consts. The environment supplies **initial values**; changes are written to
 * TRACE_DIR/.proxy-config.json and restored from there on restart.
 *
 * Why the source of truth is here rather than in the main service's database: the proxy is
 * what enforces this, and the main service is only a client. The other way round leaves a
 * window between the proxy restarting and the main service pushing configuration down, and
 * during it the proxy runs on the environment's values — possibly looser than what an
 * administrator set. An audit component should not have a window like that.
 *
 * Two of them **cannot be changed**: PROXY_RETRY and PROXY_MAX_CONCURRENT must be 0.
 * They are not tuning knobs. The proxy's own retries swallow the upstream's 429, so the
 * gateway's AIMD gate downstream never sees the signal to back off and — reading a run of
 * successes — pushes harder. Two queues in series make the slot accounting disagree, and
 * the proxy cannot tell users apart, so per-user limits and fair queueing are beyond it.
 */
const CONFIG_FILE = path.join(TRACE_DIR, '.proxy-config.json');

const runtimeCfg = {
  /** host[:port] values that may be forwarded to; an empty array means no restriction */
  allow: (process.env.PROXY_UPSTREAM_ALLOW || '')
    .split(',')
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean),
  /** Whether a caller may name the destination with x-forwarded-host */
  dynamicUpstream: process.env.PROXY_DYNAMIC_UPSTREAM === '1',
  maxCount: ENV_MAX_COUNT,
  maxBytes: ENV_MAX_BYTES,
  maxAgeMs: ENV_MAX_AGE_MS,
};

function loadRuntimeCfg() {
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    for (const k of Object.keys(runtimeCfg)) {
      if (saved[k] !== undefined) runtimeCfg[k] = saved[k];
    }
    console.log(c.dim(`  restored runtime configuration from ${CONFIG_FILE}`));
  } catch {
    /* Nothing saved yet, so the environment's initial values stand */
  }
}

function saveRuntimeCfg() {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(runtimeCfg, null, 2));
}

/** Validate a patch and apply it. Returns the reason it failed, or undefined on success. */
function patchRuntimeCfg(patch) {
  const next = { ...runtimeCfg };

  if (patch.allow !== undefined) {
    if (!Array.isArray(patch.allow)) return 'allow must be an array';
    const cleaned = patch.allow.map((v) => String(v).trim().toLowerCase()).filter(Boolean);
    for (const h of cleaned) {
      if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(h)) return `"${h}" is not a valid host[:port]`;
    }
    next.allow = [...new Set(cleaned)];
  }
  if (patch.dynamicUpstream !== undefined) next.dynamicUpstream = Boolean(patch.dynamicUpstream);

  for (const [k, label, max] of [
    ['maxCount', 'the record ceiling', 10_000_000],
    ['maxBytes', 'the size ceiling in bytes', 10 * 1024 ** 4],
    ['maxAgeMs', 'the retention period in milliseconds', 3650 * 86400_000],
  ]) {
    if (patch[k] === undefined) continue;
    const n = Number(patch[k]);
    if (!Number.isFinite(n) || n < 0 || n > max) return `${label} is out of range`;
    next[k] = n;
  }

  // The locked settings. Refuse plainly and say why, rather than let somebody think their
  // change simply did not take
  for (const k of ['retry', 'maxConcurrent']) {
    if (patch[k] !== undefined && Number(patch[k]) !== 0) {
      return `${k} must be 0: in this chain the proxy observes and nothing more. `
        + 'Its own retries swallow the upstream 429, so the gateway AIMD gate downstream never '
        + 'sees the signal to back off, and two queues in series make the slot accounting disagree.';
    }
  }

  Object.assign(runtimeCfg, next);
  saveRuntimeCfg();
  return undefined;
}

/** A snapshot for the console: the configuration, plus what is actually going on */
function configSnapshot() {
  let count = 0;
  let bytes = 0;
  try {
    for (const e of fs.readdirSync(TRACE_DIR, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      count += 1;
      bytes += dirSize(path.join(TRACE_DIR, e.name));
    }
  } catch {
    /* The directory does not exist yet */
  }
  return {
    allow: runtimeCfg.allow,
    dynamicUpstream: runtimeCfg.dynamicUpstream,
    maxCount: runtimeCfg.maxCount,
    maxBytes: runtimeCfg.maxBytes,
    maxAgeMs: runtimeCfg.maxAgeMs,
    /** Read-only. Shown precisely so it is visible that they really are 0. */
    locked: { retry: MAX_RETRY, maxConcurrent: MAX_CONCURRENT },
    stats: { traceCount: count, traceBytes: bytes, traceDir: TRACE_DIR },
    pinnedUpstream: process.env.UPSTREAM_URL || null,
    uiEnabled: Boolean(UI_PREFIX),
    /** Where the interface is mounted. Callers need it to build links and to set a cookie Path. */
    uiPrefix: UI_PREFIX,
  };
}

const FWD_HOST = 'x-forwarded-host';
const FWD_PROTO = 'x-forwarded-proto';

/** Header value to an origin string. Returns { problem } when it is malformed or not allowed. */
function forwardedOrigin(headers) {
  const raw = headers[FWD_HOST];
  if (!raw) return {};
  if (!runtimeCfg.dynamicUpstream) {
    return { problem: `${FWD_HOST} is not enabled (needs PROXY_DYNAMIC_UPSTREAM=1, or switching on in the console)` };
  }
  const host = String(raw).trim().toLowerCase();
  // host[:port] only, which shuts out a smuggled scheme, a path, or an @ (userinfo confusion)
  if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(host)) {
    return { problem: `${FWD_HOST} is not a valid host[:port]: ${host}` };
  }
  if (runtimeCfg.allow.length && !runtimeCfg.allow.includes(host)) {
    return { problem: `${host} is not on the allowlist (add it under "audit proxy" in the console, or change PROXY_UPSTREAM_ALLOW)` };
  }
  const proto = String(headers[FWD_PROTO] || 'https').trim().toLowerCase();
  if (proto !== 'http' && proto !== 'https') {
    return { problem: `${FWD_PROTO} must be http or https, got ${proto}` };
  }
  return { origin: `${proto}://${host}` };
}

function pickUpstream(pathname, headers) {
  if (process.env.UPSTREAM_URL) return process.env.UPSTREAM_URL;
  // The destination the caller named, already validated on the way in
  const fwd = forwardedOrigin(headers);
  if (fwd.origin) return fwd.origin;
  if (CHATGPT_PATHS.some((p) => pathname.startsWith(p))) return CHATGPT;
  if (OPENAI_PATHS.some((p) => pathname.startsWith(p))) return OPENAI;
  // Both sides have /v1/models, so tell them apart by Anthropic's distinctive header
  if (pathname.startsWith('/v1/models')) {
    if (headers['x-api-key'] || headers['anthropic-version']) return ANTHROPIC;
    return OPENAI;
  }
  return ANTHROPIC;
}

// ---------------------------------------------------------------- Helpers

fs.mkdirSync(TRACE_DIR, { recursive: true });
const INDEX = path.join(TRACE_DIR, 'index.jsonl');

// Continue numbering from the existing index.jsonl: a restarted proxy must not collide with
// the ids already on disk
let seq = 0;
if (fs.existsSync(INDEX)) {
  for (const line of fs.readFileSync(INDEX, 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const id = JSON.parse(line).id;
      if (Number.isFinite(id) && id > seq) seq = id;
    } catch {
      /* Skip a bad line */
    }
  }
}

function ts() {
  return new Date().toISOString();
}

function redact(value) {
  if (!REDACT || typeof value !== 'string') return value;
  if (value.length <= 16) return '***';
  return `${value.slice(0, 12)}…${value.slice(-4)} (len=${value.length})`;
}

/** rawHeaders is [name, value, name, value, …], preserving the case and order the client sent */
function dumpRawHeaders(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i];
    const v = raw[i + 1];
    out.push([k, SECRET_HEADERS.has(k.toLowerCase()) ? redact(String(v)) : v]);
  }
  return out;
}

function dumpHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? redact(String(v)) : v;
  }
  return out;
}

function slug(pathname) {
  return pathname.replace(/^\/+/, '').replace(/[^a-zA-Z0-9]+/g, '-').slice(0, 48) || 'root';
}

function writeJSON(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
}

function tryParseJSON(buf) {
  try {
    return JSON.parse(buf.toString('utf8'));
  } catch {
    return null;
  }
}

function preview(str, n = 400) {
  if (typeof str !== 'string') return str;
  return str.length > n ? `${str.slice(0, n)}… [+${str.length - n} chars]` : str;
}

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

/**
 * Allowance and rate-limit information hides in response headers; pull it out separately:
 *   Anthropic: anthropic-ratelimit-unified-*  (5h / 7d window utilisation, reset, overage)
 *   Codex    : x-codex-credits-*, x-codex-rate-limit-*, x-ratelimit-*
 */
function extractQuotaHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (
      lk.startsWith('anthropic-ratelimit') ||
      lk.startsWith('x-ratelimit') ||
      lk.startsWith('x-codex-credits') ||
      lk.startsWith('x-codex-rate-limit') ||
      lk === 'x-codex-active-limit' ||
      lk === 'retry-after'
    ) {
      out[lk] = v;
    }
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------- Request body summary

/** Pull a readable structure out of an Anthropic /v1/messages or OpenAI /v1/responses body */
function summarizeRequest(body) {
  if (!body || typeof body !== 'object') return null;
  const s = {
    model: body.model,
    stream: !!body.stream,
    max_tokens: body.max_tokens ?? body.max_output_tokens,
    temperature: body.temperature,
  };

  // system: Anthropic accepts either a string or an array of content blocks
  if (body.system) {
    s.system = Array.isArray(body.system)
      ? body.system.map((b) => ({
          type: b.type,
          cache_control: b.cache_control,
          chars: (b.text || '').length,
          text: preview(b.text || ''),
        }))
      : { chars: body.system.length, text: preview(body.system) };
  }
  if (body.instructions) s.instructions = { chars: body.instructions.length, text: preview(body.instructions) };

  const msgs = body.messages || body.input;
  if (Array.isArray(msgs)) {
    s.message_count = msgs.length;
    s.messages = msgs.map((m, i) => {
      const item = { i, role: m.role || m.type };
      if (typeof m.content === 'string') {
        item.chars = m.content.length;
        item.text = preview(m.content, 200);
      } else if (Array.isArray(m.content)) {
        item.blocks = m.content.map((b) => {
          const blk = { type: b.type };
          if (b.cache_control) blk.cache_control = b.cache_control;
          if (b.type === 'text' || b.type === 'input_text' || b.type === 'output_text') {
            blk.chars = (b.text || '').length;
            blk.text = preview(b.text || '', 200);
          }
          if (b.type === 'tool_use' || b.type === 'function_call') {
            blk.name = b.name;
            blk.id = b.id || b.call_id;
            blk.input = preview(JSON.stringify(b.input ?? b.arguments ?? {}), 200);
          }
          if (b.type === 'tool_result' || b.type === 'function_call_output') {
            blk.tool_use_id = b.tool_use_id || b.call_id;
            blk.is_error = b.is_error;
            const t = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? b.output ?? '');
            blk.chars = t.length;
            blk.content = preview(t, 200);
          }
          if (b.type === 'image' || b.type === 'input_image') {
            blk.media_type = b.source?.media_type;
            blk.bytes = b.source?.data ? b.source.data.length : undefined;
          }
          if (b.type === 'thinking') {
            blk.chars = (b.thinking || '').length;
            blk.text = preview(b.thinking || '', 200);
          }
          return blk;
        });
      }
      return item;
    });
  }

  if (Array.isArray(body.tools)) {
    s.tool_count = body.tools.length;
    s.tools = body.tools.map((t) => ({
      name: t.name || t.function?.name,
      type: t.type,
      desc_chars: (t.description || t.function?.description || '').length,
      schema_chars: JSON.stringify(t.input_schema || t.parameters || t.function?.parameters || {}).length,
      cache_control: t.cache_control,
    }));
  }
  if (body.tool_choice) s.tool_choice = body.tool_choice;
  if (body.thinking) s.thinking = body.thinking;
  if (body.metadata) s.metadata = body.metadata;
  if (body.reasoning) s.reasoning = body.reasoning;

  s.cache_breakpoints = countCacheBreakpoints(body);
  return s;
}

function countCacheBreakpoints(body) {
  let n = 0;
  const walk = (v) => {
    if (!v || typeof v !== 'object') return;
    if (Array.isArray(v)) return v.forEach(walk);
    if (v.cache_control) n++;
    Object.values(v).forEach(walk);
  };
  walk(body);
  return n;
}

// ---------------------------------------------------------------- SSE parsing

/**
 * An incremental SSE parser: it cuts the byte stream into {event, data} events and
 * reconstructs the final message from them — text, tool_use, usage.
 */
function createSSECollector(streamFile) {
  let buf = '';
  const events = [];
  const state = {
    text: '',
    thinking: '',
    toolUses: [],
    usage: null,
    rateLimits: null,
    stopReason: null,
    model: null,
    partialJSON: {},
  };

  function handle(evtName, dataRaw) {
    let data = dataRaw;
    if (dataRaw !== '[DONE]') {
      try {
        data = JSON.parse(dataRaw);
      } catch {
        /* Keep it verbatim */
      }
    }
    const rec = { t: ts(), event: evtName || (data && data.type) || null, data };
    events.push(rec);
    fs.appendFileSync(streamFile, JSON.stringify(rec) + '\n');

    if (!data || typeof data !== 'object') return;
    const type = data.type || evtName;

    // ---- The Anthropic Messages stream
    if (type === 'message_start' && data.message) {
      state.model = data.message.model;
      state.usage = { ...(data.message.usage || {}) };
    }
    if (type === 'content_block_start' && data.content_block) {
      const cb = data.content_block;
      if (cb.type === 'tool_use') {
        state.toolUses[data.index] = { id: cb.id, name: cb.name, input: '' };
      }
    }
    if (type === 'content_block_delta' && data.delta) {
      const d = data.delta;
      if (d.type === 'text_delta') state.text += d.text || '';
      if (d.type === 'thinking_delta') state.thinking += d.thinking || '';
      if (d.type === 'input_json_delta') {
        const tu = state.toolUses[data.index];
        if (tu) tu.input += d.partial_json || '';
      }
    }
    if (type === 'message_delta') {
      if (data.delta?.stop_reason) state.stopReason = data.delta.stop_reason;
      if (data.usage) state.usage = { ...(state.usage || {}), ...data.usage };
    }

    // ---- The OpenAI Responses stream
    if (type === 'response.output_text.delta') state.text += data.delta || '';
    if (type === 'response.reasoning_summary_text.delta') state.thinking += data.delta || '';
    if (type === 'response.completed' && data.response) {
      state.usage = data.response.usage || state.usage;
      state.model = data.response.model || state.model;
      state.stopReason = data.response.status || state.stopReason;
    }
    // ---- The OpenAI chat.completions stream
    if (data.choices?.[0]?.delta?.content) state.text += data.choices[0].delta.content;
    if (data.choices?.[0]?.finish_reason) state.stopReason = data.choices[0].finish_reason;
    if (data.usage && !state.usage) state.usage = data.usage;
    // ---- Codex reports the subscription allowance inside the SSE stream
    if (data.rate_limits) state.rateLimits = data.rate_limits;
    if (data.response?.rate_limits) state.rateLimits = data.response.rate_limits;
  }

  return {
    events,
    state,
    push(chunk) {
      buf += chunk.toString('utf8');
      let idx;
      // SSE separates event blocks with a blank line
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + (buf[idx] === '\r' ? 4 : 2));
        let evtName = null;
        const dataLines = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith('event:')) evtName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length) handle(evtName, dataLines.join('\n'));
      }
    },
    finish() {
      if (buf.trim()) {
        const dataLines = [];
        let evtName = null;
        for (const line of buf.split(/\r?\n/)) {
          if (line.startsWith('event:')) evtName = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length) handle(evtName, dataLines.join('\n'));
      }
      for (const tu of state.toolUses) {
        if (tu && typeof tu.input === 'string') {
          try {
            tu.parsed = JSON.parse(tu.input || '{}');
          } catch {
            /* Keep the original string */
          }
        }
      }
      return state;
    },
  };
}

// ---------------------------------------------------------------- Pinning device_id

const STICKY_FILE = path.join(TRACE_DIR, '.device-id');
let fixedDeviceId = null;

if (DEVICE_ID_MODE === 'sticky') {
  try {
    fixedDeviceId = fs.readFileSync(STICKY_FILE, 'utf8').trim() || null;
  } catch {
    fixedDeviceId = null; // Nothing recorded yet; the first request settles it
  }
} else if (DEVICE_ID_MODE) {
  fixedDeviceId = DEVICE_ID_MODE;
}

/**
 * Replace the device_id inside metadata.user_id in place.
 * Returns a record of the rewrite for the trace, or null when nothing was rewritten.
 */
function applyFixedDeviceId(body) {
  if (!DEVICE_ID_MODE) return null;
  const raw = body?.metadata?.user_id;
  if (typeof raw !== 'string') return null;

  let u;
  try {
    u = JSON.parse(raw);
  } catch {
    return null; // Not the shape we expected, so leave it alone
  }
  if (!u || typeof u.device_id !== 'string') return null;

  // sticky: the first one seen is the one we keep
  if (!fixedDeviceId) {
    fixedDeviceId = u.device_id;
    try {
      fs.writeFileSync(STICKY_FILE, fixedDeviceId + '\n');
    } catch {}
    console.log(c.dim(`  ⤷ pinned device_id ${fixedDeviceId.slice(0, 12)}… -> ${STICKY_FILE}`));
    return null; // This request already carried that value
  }
  if (u.device_id === fixedDeviceId) return null;

  const from = u.device_id;
  u.device_id = fixedDeviceId;
  body.metadata.user_id = JSON.stringify(u);
  return { field: 'metadata.user_id.device_id', from, to: fixedDeviceId };
}

// ---------------------------------------------------------------- The recording blocklist

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  return new RegExp('^' + escaped.split('*').join('.*') + '$');
}

const skipRules = TRACE_SKIP.map((rule) => {
  const sp = rule.indexOf(' ');
  if (sp > 0) {
    return { method: rule.slice(0, sp).toUpperCase(), re: globToRegExp(rule.slice(sp + 1).trim()), raw: rule };
  }
  return { method: null, re: globToRegExp(rule), raw: rule };
});

/** Whether this request skips recording */
function shouldSkipTrace(method, pathname) {
  return skipRules.some((r) => (!r.method || r.method === method.toUpperCase()) && r.re.test(pathname));
}

// ---------------------------------------------------------------- The concurrency gate

let inFlight = 0;
const waitQueue = [];
let peakQueue = 0;

/** Take a slot, returning how long it queued in ms. Rejects when the queue is full or the wait times out. */
function acquireSlot() {
  return new Promise((resolve, reject) => {
    if (MAX_CONCURRENT <= 0 || inFlight < MAX_CONCURRENT) {
      inFlight++;
      return resolve(0);
    }
    if (waitQueue.length >= QUEUE_MAX) {
      const e = new Error(`the proxy queue is full (${QUEUE_MAX})`);
      e.code = 'QUEUE_FULL';
      return reject(e);
    }
    const item = { resolve, reject, at: Date.now() };
    item.timer = setTimeout(() => {
      const i = waitQueue.indexOf(item);
      if (i >= 0) waitQueue.splice(i, 1);
      const e = new Error(`queued for more than ${QUEUE_TIMEOUT_MS}ms`);
      e.code = 'QUEUE_TIMEOUT';
      reject(e);
    }, QUEUE_TIMEOUT_MS);
    waitQueue.push(item);
    if (waitQueue.length > peakQueue) peakQueue = waitQueue.length;
  });
}

function releaseSlot() {
  const next = waitQueue.shift();
  if (next) {
    clearTimeout(next.timer);
    next.resolve(Date.now() - next.at); // The slot is handed straight over, so inFlight does not change
    return;
  }
  inFlight = Math.max(0, inFlight - 1);
}

/** Remove a waiter whose turn never came — used when the client disconnects early */
function cancelWait(item) {
  const i = waitQueue.indexOf(item);
  if (i >= 0) {
    clearTimeout(waitQueue[i].timer);
    waitQueue.splice(i, 1);
  }
}

// ---------------------------------------------------------------- Deciding to retry

/** Anthropic says so outright with x-should-retry, and that takes precedence */
function statusRetriable(status, headers) {
  const sr = String(headers?.['x-should-retry'] ?? '').toLowerCase();
  if (sr === 'true') return true;
  if (sr === 'false') return false;
  return RETRY_STATUS.has(status);
}

function errorRetriable(err) {
  if (err.code && RETRY_ERR_CODES.has(err.code)) return true;
  return /socket hang up|aborted|timeout/i.test(err.message || '');
}

/** How long to back off: the upstream's retry-after if it sent one, otherwise exponential backoff with jitter */
function backoffMs(attempt, headers) {
  const ra = headers?.['retry-after'];
  if (ra != null) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return Math.min(secs * 1000, RETRY_MAX_MS);
    const at = Date.parse(ra);
    if (at) return Math.min(Math.max(at - Date.now(), 0), RETRY_MAX_MS);
  }
  const exp = RETRY_BASE_MS * 2 ** (attempt - 1);
  return Math.min(exp, RETRY_MAX_MS) + Math.floor(Math.random() * 250);
}

// ---------------------------------------------------------------- Retention

function dirSize(p) {
  let n = 0;
  for (const e of fs.readdirSync(p, { withFileTypes: true })) {
    const f = path.join(p, e.name);
    n += e.isDirectory() ? dirSize(f) : fs.statSync(f).size;
  }
  return n;
}

/** Rewrite index.jsonl without the removed directories. Lines appended during the rewrite are carried over, so nothing is lost. */
function rewriteIndex(keep) {
  if (!fs.existsSync(INDEX)) return;
  const before = fs.statSync(INDEX).size;
  const kept = fs
    .readFileSync(INDEX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .filter((l) => {
      try {
        return keep.has(JSON.parse(l).dir);
      } catch {
        return false;
      }
    });
  const tmp = INDEX + '.tmp';
  fs.writeFileSync(tmp, kept.length ? kept.join('\n') + '\n' : '');
  const after = fs.statSync(INDEX).size;
  if (after > before) {
    // New requests arrived mid-prune; append that part unchanged
    const fd = fs.openSync(INDEX, 'r');
    const buf = Buffer.alloc(after - before);
    fs.readSync(fd, buf, 0, after - before, before);
    fs.closeSync(fd);
    fs.appendFileSync(tmp, buf);
  }
  fs.renameSync(tmp, INDEX);
}

/** Prune the oldest traces by count, total size, or age, and return a summary */
function pruneTraces({ quiet = false } = {}) {
  let entries;
  try {
    entries = fs
      .readdirSync(TRACE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => {
        const full = path.join(TRACE_DIR, e.name);
        const st = fs.statSync(full);
        return { name: e.name, full, mtime: st.mtimeMs, size: dirSize(full) };
      })
      .sort((a, b) => a.mtime - b.mtime); // oldest first
  } catch {
    return null;
  }
  if (!entries.length) return null;

  const now = Date.now();
  const doomed = new Set();

  const { maxAgeMs, maxCount, maxBytes } = runtimeCfg;
  if (maxAgeMs > 0) {
    for (const e of entries) if (now - e.mtime > maxAgeMs) doomed.add(e.name);
  }
  if (maxCount > 0) {
    const over = entries.length - doomed.size - maxCount;
    if (over > 0) {
      let n = 0;
      for (const e of entries) {
        if (n >= over) break;
        if (!doomed.has(e.name)) { doomed.add(e.name); n++; }
      }
    }
  }
  if (maxBytes > 0) {
    let total = entries.reduce((a, e) => (doomed.has(e.name) ? a : a + e.size), 0);
    for (const e of entries) {
      if (total <= maxBytes) break;
      if (doomed.has(e.name)) continue;
      doomed.add(e.name);
      total -= e.size;
    }
  }
  if (!doomed.size) return null;

  let freed = 0;
  for (const e of entries) {
    if (!doomed.has(e.name)) continue;
    // Only directories we created ourselves, under TRACE_DIR
    if (path.dirname(e.full) !== path.resolve(TRACE_DIR)) continue;
    try {
      fs.rmSync(e.full, { recursive: true, force: true });
      freed += e.size;
    } catch {
      doomed.delete(e.name);
    }
  }
  rewriteIndex(new Set(entries.filter((e) => !doomed.has(e.name)).map((e) => e.name)));

  const summary = { removed: doomed.size, freed_mb: +(freed / 1048576).toFixed(1), remaining: entries.length - doomed.size };
  if (!quiet) {
    console.log(
      c.dim(`  ⤷ pruned ${summary.removed} old traces, freeing ${summary.freed_mb} MB; ${summary.remaining} remain`)
    );
  }
  return summary;
}

/**
 * Clear every trace in one go.
 *
 * It differs from pruneTraces() in more than how much it removes:
 *   - that one drops the old and keeps the new, so numbering has to carry on upwards, because
 *     the surviving records still hold those ids
 *   - this one leaves nothing behind, so numbering returns to 0 and the next record is #1,
 *     which is what anybody would expect to see
 *
 * It touches only the NNNN-… record directories and index.jsonl. TRACE_DIR also holds dot
 * files — `.proxy-config.json` is the runtime configuration and `.device-id` is the sticky
 * device_id — which are not audit data, and sweeping them up would reset the configuration
 * along with the traces.
 */
function clearTraces() {
  let names;
  try {
    names = fs
      .readdirSync(TRACE_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{4,}-/.test(e.name))
      .map((e) => e.name);
  } catch {
    return { removed: 0, freed_mb: 0, remaining: 0 };
  }

  let freed = 0;
  const survivors = new Set();
  for (const name of names) {
    const full = path.join(TRACE_DIR, name);
    const size = dirSize(full);
    try {
      fs.rmSync(full, { recursive: true, force: true });
      freed += size;
    } catch {
      survivors.add(name); // What could not be deleted stays in the index, rather than becoming an orphan directory
    }
  }
  rewriteIndex(survivors);
  if (!survivors.size) seq = 0;

  const summary = {
    removed: names.length - survivors.size,
    freed_mb: +(freed / 1048576).toFixed(1),
    remaining: survivors.size,
  };
  console.log(c.dim(`  ⤷ cleared traces: removed ${summary.removed}, freeing ${summary.freed_mb} MB`));
  return summary;
}

// ---------------------------------------------------------------- Scope-of-use checks
//
// This tool is meant to serve one machine: yours. Neither check below reports anything
// anywhere; they print to the local terminal, so the proxy does not end up accidentally
// exposed or treated as a shared relay for several people.

const crypto = require('node:crypto');
const seenCreds = new Set();
let credWarned = false;

/** A short hash of the credential, for counting. The credential itself is not kept. */
function credFingerprint(headers) {
  const raw = headers['x-api-key'] || headers['authorization'] || '';
  if (!raw) return null;
  return crypto.createHash('sha256').update(String(raw)).digest('hex').slice(0, 8);
}

function checkCredentialScope(headers) {
  const fp = credFingerprint(headers);
  if (!fp) return;
  seenCreds.add(fp);
  if (seenCreds.size > 1 && !credWarned) {
    credWarned = true;
    console.warn(
      c.yellow('\n  ⚠  Several different credentials have passed through this proxy.\n') +
      c.dim('     It is built for debugging your own traffic. Relaying requests for several\n') +
      c.dim('     people or accounts through one proxy may breach the terms of service\n') +
      c.dim('     (account sharing) — a risk that has nothing to do with TLS or HTTP versions.\n')
    );
  }
}

// ---------------------------------------------------------------- Forwarding machinery

/**
 * Hop-by-hop headers. RFC 7230 says they must not be forwarded, and HTTP/2 forbids them
 * outright — sending one is a PROTOCOL_ERROR. host is handled separately: rewritten under
 * h1, and carried as :authority under h2.
 */
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te', 'trailer',
  'proxy-connection', 'proxy-authenticate', 'proxy-authorization', 'host',
]);

/** Build a decompression stream for the content-encoding, or null when none is needed */
function makeDecompressor(encoding) {
  const e = String(encoding || '').toLowerCase().trim();
  if (e === 'gzip' || e === 'x-gzip') return zlib.createGunzip();
  if (e === 'deflate') return zlib.createInflate();
  if (e === 'br') return zlib.createBrotliDecompress();
  if (e === 'zstd' && zlib.createZstdDecompress) return zlib.createZstdDecompress();
  return null;
}

// h2 sessions are reused per origin, and an origin that fails to negotiate is remembered so
// later requests go straight to h1
const h2Sessions = new Map();
const h2Unsupported = new Set();

function getH2Session(origin) {
  const cur = h2Sessions.get(origin);
  if (cur && !cur.destroyed && !cur.closed) return cur;
  const session = http2.connect(origin);
  session.setTimeout(Number(process.env.PROXY_TIMEOUT_MS || 15 * 60 * 1000), () => {});
  session.on('error', () => h2Sessions.delete(origin));
  session.on('close', () => h2Sessions.delete(origin));
  session.unref();
  h2Sessions.set(origin, session);
  return session;
}

// ---------------------------------------------------------------- The server

loadRuntimeCfg();

if (process.argv.includes('--prune')) {
  const r = pruneTraces();
  console.log(r ? `pruned ${r.removed}, freeing ${r.freed_mb} MB; ${r.remaining} remain` : 'nothing to prune');
  process.exit(0);
}

/* ── The control API ──────────────────────────────────────────────────────────
 *
 * GET   /__admin/config  read the configuration and status
 * PATCH /__admin/config  change the allowlist, the retention policy, or dynamic routing
 *
 * Authenticated by a fixed token (PROXY_ADMIN_TOKEN); with no token configured it is not
 * mounted at all. An endpoint that can edit the allowlist is an endpoint that can aim the
 * audit proxy anywhere, and open by default is not a defensible position.
 * The comparison is constant-time, so response timing cannot be used to guess the token.
 *
 *
 * Handled before the UI, and **never traced**: control traffic is not what is being audited.
 */
const ADMIN_TOKEN = process.env.PROXY_ADMIN_TOKEN || '';
const ADMIN_PREFIX = '/__admin/config';
/**
 * Reading and clearing trace data, behind the same token:
 *   GET    /__admin/traces        the listing (every line of index.jsonl)
 *   GET    /__admin/traces/<id>   one in full (request, response, SSE, usage)
 *   DELETE /__admin/traces        clear the lot
 *
 * Under the **control API** rather than the UI: the caller is our own console, which has its
 * own admin authentication, and should not be affected by something as unrelated as whether
 * `PROXY_UI_PREFIX` is set. Traces stay readable with the interface switched off.
 */
const ADMIN_TRACES = '/__admin/traces';

function adminAuthorized(req) {
  if (!ADMIN_TOKEN) return false;
  const raw = String(req.headers.authorization || '');
  const got = raw.startsWith('Bearer ') ? raw.slice(7) : '';
  const a = Buffer.from(got);
  const b = Buffer.from(ADMIN_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

/** Returns true when it handled the request */
function handleAdmin(req, res) {
  const p = req.url.split('?')[0];
  const isTraces = p === ADMIN_TRACES || p.startsWith(ADMIN_TRACES + '/');
  if (p !== ADMIN_PREFIX && !isTraces) return false;
  if (!ADMIN_TOKEN) {
    sendJson(res, 404, { error: 'the control API is not enabled (no PROXY_ADMIN_TOKEN configured)' });
    return true;
  }
  if (!adminAuthorized(req)) {
    sendJson(res, 401, { error: 'invalid credential' });
    return true;
  }
  if (isTraces) {
    const rest = p.slice(ADMIN_TRACES.length).replace(/^\//, '');
    if (rest) {
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'GET only' });
        return true;
      }
      const one = ui.loadTrace(Number(rest));
      one ? sendJson(res, 200, one) : sendJson(res, 404, { error: 'no such record' });
      return true;
    }
    if (req.method === 'GET') {
      sendJson(res, 200, { traceDir: TRACE_DIR, rows: ui.readIndex() });
      return true;
    }
    if (req.method === 'DELETE') {
      sendJson(res, 200, { ...clearTraces(), config: configSnapshot() });
      return true;
    }
    sendJson(res, 405, { error: 'GET or DELETE only' });
    return true;
  }
  if (req.method === 'GET') {
    sendJson(res, 200, configSnapshot());
    return true;
  }
  if (req.method === 'PATCH') {
    const chunks = [];
    req.on('data', (ch) => chunks.push(ch));
    req.on('end', () => {
      let patch;
      try {
        patch = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      } catch {
        return sendJson(res, 400, { error: 'the body is not valid JSON' });
      }
      const problem = patchRuntimeCfg(patch);
      if (problem) return sendJson(res, 400, { error: problem });
      console.log(c.dim(`[admin] configuration updated: ${JSON.stringify(patch)}`));
      sendJson(res, 200, configSnapshot());
    });
    return true;
  }
  sendJson(res, 405, { error: 'GET or PATCH only' });
  return true;
}

const server = http.createServer((req, res) => {
  // The control API comes first: never forwarded, never traced
  if (handleAdmin(req, res)) return;
  // Interface requests are handled here: never traced, never forwarded upstream
  if (UI_PREFIX && ui.handleUiRequest(req, res, UI_PREFIX)) return;
  // Browser noise such as favicon: answered locally, neither forwarded nor recorded
  if (
    UI_PREFIX &&
    !req.headers['x-api-key'] &&
    !req.headers.authorization &&
    BROWSER_NOISE.includes(req.url.split('?')[0])
  ) {
    if (req.url.split('?')[0] === '/favicon.ico') {
      // Give the interface an icon, so the browser stops asking
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">' +
        '<rect width="32" height="32" rx="7" fill="#2a78d6"/>' +
        '<path d="M8 20.5 13 11l3.2 6 2.3-3.5L24 20.5z" fill="#fff"/></svg>';
      res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'max-age=86400' });
      res.end(svg);
    } else {
      res.writeHead(204);
      res.end();
    }
    return;
  }

  // A browser opening the root goes to the interface. Programmatic requests carrying an API
  // key are unaffected.
  if (
    UI_PREFIX &&
    req.method === 'GET' &&
    req.url === '/' &&
    !req.headers['x-api-key'] &&
    !req.headers.authorization &&
    String(req.headers.accept || '').includes('text/html')
  ) {
    res.writeHead(302, { location: UI_PREFIX + '/' });
    res.end();
    return;
  }

  const skipTrace = shouldSkipTrace(req.method, req.url.split('?')[0]);
  const id = skipTrace ? 0 : ++seq;
  const started = Date.now();
  const chunks = [];

  req.on('data', (ch) => chunks.push(ch));
  req.on('error', (err) => {
    console.error(c.red(`[#${id}] client error: ${err.message}`));
  });

  req.on('end', () => {
    let reqBody = Buffer.concat(chunks);
    const [pathname, query] = req.url.split('?');

    /* A routing header is validated first, and refused outright when malformed.
     * After the directory is created and before forwarding, so a refused request still
     * leaves an audit trail. */
    if (!process.env.UPSTREAM_URL) {
      const { problem } = forwardedOrigin(req.headers);
      if (problem) {
        console.error(c.red(`[#${id}] refused to forward: ${problem}`));
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { type: 'forbidden', message: problem } }));
        return;
      }
    }

    const upstreamBase = pickUpstream(pathname, req.headers);
    const target = new URL(req.url, upstreamBase);

    const dirName = `${String(id).padStart(4, '0')}-${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}-${req.method}-${slug(pathname)}`;
    const dir = path.join(TRACE_DIR, dirName);
    if (!skipTrace) fs.mkdirSync(dir, { recursive: true });

    checkCredentialScope(req.headers);
    if (PRUNE_EVERY > 0 && id % PRUNE_EVERY === 0) setImmediate(() => pruneTraces());

    const parsedReq = tryParseJSON(reqBody);

    // Pinning device_id has to happen before content-length is computed, or the length is wrong
    const rewrite = parsedReq ? applyFixedDeviceId(parsedReq) : null;
    if (rewrite) {
      reqBody = Buffer.from(JSON.stringify(parsedReq));
      if (!skipTrace) {
        writeJSON(path.join(dir, 'request.rewrites.json'), {
          note: 'The proxy modified the body before sending it upstream. request.body.json holds the rewritten version.',
          rewrites: [rewrite],
        });
      }
    }

    const reqSummary = summarizeRequest(parsedReq);

    // ---- Writing the request to disk
    if (!skipTrace) writeJSON(path.join(dir, 'request.json'), {
      id,
      time: ts(),
      method: req.method,
      url: req.url,
      upstream: target.origin,
      http_version: req.httpVersion,
      headers: dumpHeaders(req.headers),
      raw_headers: dumpRawHeaders(req.rawHeaders),
      body_bytes: reqBody.length,
    });
    if (!skipTrace) {
      if (parsedReq) {
        writeJSON(path.join(dir, 'request.body.json'), parsedReq);
        if (reqSummary) writeJSON(path.join(dir, 'request.summary.json'), reqSummary);
      } else if (reqBody.length) {
        fs.writeFileSync(path.join(dir, 'request.body.raw'), reqBody);
      }
    }

    // ---- Build the forwarded headers: drop the hop-by-hop ones, carry the rest through
    const outHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      // Routing headers, not leaked upstream
      if (k.toLowerCase() === FWD_HOST || k.toLowerCase() === FWD_PROTO) continue;
      outHeaders[k] = v;
    }
    if (FORCE_IDENTITY) outHeaders['accept-encoding'] = 'identity';
    if (reqBody.length) outHeaders['content-length'] = String(reqBody.length);

    const wantH2 = USE_HTTP2 && target.protocol === 'https:' && !h2Unsupported.has(target.origin);

    if (!skipTrace) writeJSON(path.join(dir, 'forwarded.headers.json'), {
      protocol: wantH2 ? 'HTTP/2' : 'HTTP/1.1',
      note: wantH2
        ? 'Under HTTP/2 header names must be lowercase, Host is carried as :authority, and ' +
          'Connection-style headers are forbidden — so the differences from the client\'s ' +
          'original headers here are what the protocol demands, not distortion the proxy added.'
        : 'The headers actually sent upstream (HTTP/1.1). Comparing them with raw_headers in ' +
          'request.json shows the differences: names lowercased, Host rewritten, content-length ' +
          'recomputed, and Node appending Connection at the socket layer.',
      headers: dumpHeaders(outHeaders),
    });

    const label = `${req.method} ${pathname}${query ? '?' + query : ''}`;
    if (!skipTrace) console.log(
      `${c.dim(new Date().toLocaleTimeString())} ${c.bold(`#${id}`)} ${c.cyan('→')} ${label} ` +
        `${c.dim(`[${target.host} ${wantH2 ? 'h2' : 'h1'}]`)}` +
        (reqSummary
          ? ` ${c.dim(
              `model=${reqSummary.model} msgs=${reqSummary.message_count ?? 0} tools=${
                reqSummary.tool_count ?? 0
              } stream=${reqSummary.stream} cache_bp=${reqSummary.cache_breakpoints} body=${reqBody.length}B`
            )}`
          : ` ${c.dim(`body=${reqBody.length}B`)}`)
    );

    // ---------------------------------------------------------------- Handling the response
    // h1 and h2 share this: once there is a status, headers and a readable stream, they behave alike
    let settled = false;
    let committed = false;   // Response headers have reached the client — past this line, no retry
    let slotHeld = false;    // Whether a concurrency slot is held
    let queuedMs = 0;        // How long it spent queued
    let attempt = 0;         // Which attempt this is (1 = the first)
    const attempts = [];     // A record of each failed attempt, written into the trace

    const onResponse = ({ status, headers, rawHeaders, bodyStream, httpVersion }) => {
      // Nothing written to the client yet, and the upstream says it is retryable — so retry
      if (!committed && attempt <= MAX_RETRY && statusRetriable(status, headers)) {
        const wait = backoffMs(attempt, headers);
        attempts.push({
          attempt,
          status,
          http_version: httpVersion,
          should_retry_header: headers['x-should-retry'] ?? null,
          retry_after_header: headers['retry-after'] ?? null,
          waited_ms: wait,
        });
        console.log(
          `${c.dim(new Date().toLocaleTimeString())} ${c.bold(`#${id}`)} ${c.yellow('↻')} ` +
            `${c.red(String(status))} ${c.dim(`attempt ${attempt} failed, retrying in ${wait}ms`)}`
        );
        bodyStream.resume();                       // Drain and discard, so the connection can be reused
        const again = () => setTimeout(tryForward, wait);
        bodyStream.once('end', again);
        bodyStream.once('error', again);
        return;
      }

      settled = true;
      committed = true;
      const ct = String(headers['content-type'] || '');
      const isSSE = ct.includes('event-stream');
      const quota = extractQuotaHeaders(headers);

      if (!skipTrace) writeJSON(path.join(dir, 'response.headers.json'), {
        status,
        http_version: httpVersion,
        headers: dumpHeaders(headers),
        raw_headers: rawHeaders ? dumpRawHeaders(rawHeaders) : null,
        quota,
        ttfb_ms: Date.now() - started,
      });
      if (quota && !skipTrace) writeJSON(path.join(dir, 'quota.json'), quota);

      // Passed back untouched, compressed bytes included — the client decompresses them
      res.writeHead(status, headers);

      const streamFile = path.join(dir, 'response.stream.jsonl');
      const collector = isSSE && !skipTrace ? createSSECollector(streamFile) : null;
      const bodyChunks = [];
      let received = 0;      // Raw bytes received from the upstream so far
      let truncated = null;  // Where it broke off, when the connection drops mid-response

      // The trace wants plaintext and the client wants the original bytes, so the stream forks
      const decoder = makeDecompressor(headers['content-encoding']);
      const sink = (ch) => {
        if (skipTrace) return;                       // Not recording, so do not hold it in memory
        collector ? collector.push(ch) : bodyChunks.push(ch);
      };
      if (decoder) {
        decoder.on('data', sink);
        decoder.on('error', (err) =>
          console.error(c.red(`[#${id}] decompression failed (${headers['content-encoding']}): ${err.message}`)));
      }

      const finish = () => {
        freeSlot();
        if (skipTrace) return;                       // Blocklisted: forwarding it is the whole job
        const durationMs = Date.now() - started;
        let usage = null;
        let stopReason = null;
        let model = reqSummary?.model;

        if (collector) {
          const st = collector.finish();
          usage = st.usage;
          stopReason = st.stopReason;
          model = st.model || model;
          writeJSON(path.join(dir, 'response.reconstructed.json'), {
            model: st.model,
            stop_reason: st.stopReason,
            usage: st.usage,
            rate_limits: st.rateLimits,
            text: st.text,
            thinking: st.thinking || undefined,
            tool_uses: st.toolUses.filter(Boolean),
            event_count: collector.events.length,
          });
        } else {
          const buf = Buffer.concat(bodyChunks);
          const parsed = tryParseJSON(buf);
          if (parsed) {
            writeJSON(path.join(dir, 'response.body.json'), parsed);
            usage = parsed.usage || null;
            stopReason = parsed.stop_reason || parsed.status || null;
            model = parsed.model || model;
          } else if (buf.length) {
            fs.writeFileSync(path.join(dir, 'response.body.raw'), buf);
          }
        }

        const record = {
          id,
          time: ts(),
          method: req.method,
          path: pathname,
          query: query || null,
          upstream: target.origin,
          upstream_http_version: httpVersion,
          content_encoding: headers['content-encoding'] || null,
          truncated,
          response_bytes: received,
          attempts: attempts.length || undefined,
          retry_log: attempts.length ? attempts : undefined,
          queued_ms: queuedMs || undefined,
          rewritten: rewrite ? [rewrite.field] : undefined,
          status,
          stream: !!isSSE,
          model,
          duration_ms: durationMs,
          request_bytes: reqBody.length,
          usage,
          quota,
          stop_reason: stopReason,
          dir: dirName,
        };
        fs.appendFileSync(INDEX, JSON.stringify(record) + '\n');
        writeJSON(path.join(dir, 'meta.json'), record);

        const statusStr = status < 400 ? c.green(String(status)) : c.red(String(status));
        const u = usage
          ? ` ${c.dim(
              `in=${usage.input_tokens ?? usage.prompt_tokens ?? '?'} out=${
                usage.output_tokens ?? usage.completion_tokens ?? '?'
              } cache_r=${usage.cache_read_input_tokens ?? 0} cache_w=${usage.cache_creation_input_tokens ?? 0}`
            )}`
          : '';
        console.log(
          `${c.dim(new Date().toLocaleTimeString())} ${c.bold(`#${id}`)} ${c.yellow('←')} ${statusStr} ` +
            `${c.dim(httpVersion)} ${isSSE ? 'SSE' : 'json'}${
              headers['content-encoding'] ? c.dim('/' + headers['content-encoding']) : ''
            } ${durationMs}ms${u} ${c.dim(`stop=${stopReason ?? '-'}`)} ${c.dim(dirName)}`
        );
      };

      bodyStream.on('data', (ch) => {
        received += ch.length;
        res.write(ch);
        if (decoder) decoder.write(ch);
        else sink(ch);
      });

      bodyStream.on('end', () => {
        res.end();
        if (decoder) {
          decoder.end();
          decoder.on('end', finish);
        } else {
          finish();
        }
      });

      // The connection dropped mid-response.
      // Do not lose the scene: the SSE events already received, where it stopped, and the
      // error code are all kept
      bodyStream.on('error', (err) => {
        truncated = {
          phase: 'mid-response',
          message: err.message,
          code: err.code || null,
          after_ms: Date.now() - started,
          bytes_received: received,
          events_received: collector ? collector.events.length : null,
          last_event: collector?.events.length
            ? collector.events[collector.events.length - 1].event
            : null,
        };
        if (!skipTrace) writeJSON(path.join(dir, 'error.json'), truncated);
        if (!skipTrace) console.error(
          c.red(`[#${id}] response dropped mid-flight: ${err.message}`) +
            c.dim(` (after ${truncated.after_ms}ms, ${received}B received` +
              (collector ? `, ${truncated.events_received} events, last ${truncated.last_event}` : '') + ')')
        );
        // Finish the usual way: what arrived is still reconstructed and still indexed
        if (decoder) {
          decoder.end();
          decoder.on('end', finish);
        } else {
          finish();
        }
        res.destroy();
      });
    };

    const onError = (err, phase) => {
      // Nothing committed to the client yet, and a connection-level error — safe to retry,
      // because the upstream never got a result back to us
      if (!committed && attempt <= MAX_RETRY && errorRetriable(err)) {
        const wait = backoffMs(attempt, null);
        attempts.push({ attempt, error: err.message, code: err.code || null, phase, waited_ms: wait });
        console.log(
          `${c.dim(new Date().toLocaleTimeString())} ${c.bold(`#${id}`)} ${c.yellow('↻')} ` +
            `${c.red(err.code || err.message)} ${c.dim(`attempt ${attempt} failed, retrying in ${wait}ms`)}`
        );
        setTimeout(tryForward, wait);
        return;
      }
      if (settled) {
        freeSlot();
        res.destroy();
        return;
      }
      settled = true;
      freeSlot();
      console.error(c.red(`[#${id}] upstream error (${phase}): ${err.message}`));
      if (!skipTrace) fs.appendFileSync(
        INDEX,
        JSON.stringify({ id, time: ts(), method: req.method, path: pathname, error: err.message, dir: dirName }) + '\n'
      );
      if (!skipTrace) writeJSON(path.join(dir, 'error.json'), {
        phase,
        message: err.message,
        code: err.code || null,
        after_ms: Date.now() - started,
        note: 'Failed before any response header arrived — the connection dropped before the upstream started replying',
        attempts: attempts.length ? attempts : undefined,
        stack: err.stack,
      });
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: err.message } }));
      } else {
        res.destroy();
      }
    };

    // ---------------------------------------------------------------- The HTTP/1.1 path
    const forwardH1 = () => {
      const agent = target.protocol === 'https:' ? https : http;
      const upstreamReq = agent.request(
        {
          protocol: target.protocol,
          hostname: target.hostname,
          port: target.port || (target.protocol === 'https:' ? 443 : 80),
          path: target.pathname + target.search,
          method: req.method,
          headers: { ...outHeaders, host: target.host },
          // Node sends no ALPN extension by default while Claude Code sends ["http/1.1"];
          // matching it removes one more difference in the fingerprint
          ALPNProtocols: ['http/1.1'],
        },
        (upstreamRes) =>
          onResponse({
            status: upstreamRes.statusCode,
            headers: upstreamRes.headers,
            rawHeaders: upstreamRes.rawHeaders,
            bodyStream: upstreamRes,
            httpVersion: `HTTP/${upstreamRes.httpVersion}`,
          })
      );
      upstreamReq.setTimeout(Number(process.env.PROXY_TIMEOUT_MS || 15 * 60 * 1000), () => {
        upstreamReq.destroy(new Error('upstream timeout'));
      });
      upstreamReq.on('error', (err) => onError(err, 'h1'));
      if (reqBody.length) upstreamReq.write(reqBody);
      upstreamReq.end();
    };

    // ---------------------------------------------------------------- The HTTP/2 path
    const forwardH2 = () => {
      let session;
      try {
        session = getH2Session(target.origin);
      } catch (err) {
        h2Unsupported.add(target.origin);
        return forwardH1();
      }

      const stream = session.request({
        ':method': req.method,
        ':path': target.pathname + target.search,
        ':scheme': 'https',
        ':authority': target.host,
        ...outHeaders,
      });

      stream.setTimeout(Number(process.env.PROXY_TIMEOUT_MS || 15 * 60 * 1000), () =>
        stream.destroy(new Error('upstream timeout')));

      stream.on('response', (h) => {
        // h2's pseudo-headers have no place in an h1 response
        const headers = {};
        for (const [k, v] of Object.entries(h)) if (!k.startsWith(':')) headers[k] = v;
        onResponse({
          status: h[':status'],
          headers,
          rawHeaders: null,
          bodyStream: stream,
          httpVersion: 'HTTP/2',
        });
      });

      stream.on('error', (err) => {
        // If h2 will not negotiate, blacklist the origin and fall back to h1 for this request
        if (!settled) {
          h2Unsupported.add(target.origin);
          console.error(c.yellow(`[#${id}] h2 failed, falling back to h1: ${err.message}`));
          return forwardH1();
        }
        onError(err, 'h2');
      });

      if (reqBody.length) stream.write(reqBody);
      stream.end();
    };

    const tryForward = () => {
      attempt++;
      if (wantH2 && !h2Unsupported.has(target.origin)) forwardH2();
      else forwardH1();
    };

    const freeSlot = () => {
      if (!slotHeld) return;
      slotHeld = false;
      releaseSlot();
    };

    // One slot covers the whole request, retries included
    acquireSlot()
      .then((waited) => {
        slotHeld = true;
        queuedMs = waited;
        if (waited > 0) {
          console.log(
            `${c.dim(new Date().toLocaleTimeString())} ${c.bold(`#${id}`)} ${c.dim('⧗')} ` +
              c.dim(`queued ${waited}ms (in flight ${inFlight}/${MAX_CONCURRENT}, queue ${waitQueue.length})`)
          );
        }
        if (res.writableEnded || res.destroyed) {
          freeSlot(); // The client gave up waiting
          return;
        }
        tryForward();
      })
      .catch((err) => {
        // No room in the queue. Say plainly that this came from the proxy, not the upstream.
        console.error(c.red(`[#${id}] ${err.message}`));
        if (!skipTrace) writeJSON(path.join(dir, 'error.json'), {
          phase: 'proxy-queue',
          code: err.code,
          message: err.message,
          note: 'Refused by the local concurrency gate; the request never went upstream',
        });
        if (!skipTrace) fs.appendFileSync(
          INDEX,
          JSON.stringify({
            id, time: ts(), method: req.method, path: pathname,
            status: 429, error: err.message, dir: dirName,
          }) + '\n'
        );
        if (!res.headersSent) {
          res.writeHead(429, { 'content-type': 'application/json', 'x-proxy-queue': err.code });
          res.end(JSON.stringify({
            type: 'error',
            error: { type: 'rate_limit_error', message: `llm-trace-proxy: ${err.message}` },
          }));
        } else {
          res.destroy();
        }
      });
  });
});

server.listen(PORT, HOST, () => {
  const loopback = HOST === '127.0.0.1' || HOST === 'localhost' || HOST === '::1';
  console.log(c.bold(`\nllm-trace-proxy listening on http://${HOST}:${PORT}`));
  if (!loopback) {
    console.warn(
      c.red(`\n  ⚠  Listening on ${HOST}, which is not a loopback address: any machine on this\n     network can use your credentials directly.\n`) +
      c.dim('     Unless you really need this, go back to the default 127.0.0.1.\n')
    );
  }
  console.log(`  traces  -> ${TRACE_DIR}`);
  console.log(`  anthropic upstream -> ${ANTHROPIC}`);
  console.log(`  openai    upstream -> ${OPENAI}`);
  console.log(`  chatgpt   upstream -> ${CHATGPT}  (where subscription Codex goes)`);
  console.log(
    c.dim(
      `  redact=${REDACT} retry=${MAX_RETRY} ` +
        `concurrency=${MAX_CONCURRENT > 0 ? `${MAX_CONCURRENT} (queue limit ${QUEUE_MAX})` : 'unlimited'}` +
        (skipRules.length ? `\n  not recorded: ${skipRules.map((r) => r.raw).join(', ')}` : '') + '\n'
    )
  );
  if (DEVICE_ID_MODE) {
    console.log(
      c.yellow(`  ⚠  device_id pinning is on (${DEVICE_ID_MODE === 'sticky' ? 'sticky' : 'fixed value'})`) +
        c.dim('\n     bodies are modified before forwarding, so this is no longer a pure passthrough') +
        c.dim('\n     every rewrite is recorded in request.rewrites.json') +
        c.dim(fixedDeviceId ? `\n     current value: ${fixedDeviceId.slice(0, 16)}…\n` : '\n     waiting for the first request to pin it\n')
    );
  }
  console.log(c.dim('  Claude Code:  ANTHROPIC_BASE_URL=' + `http://${HOST}:${PORT}` + ' claude'));
  console.log(
    c.dim('  Codex CLI  :  codex -c model_provider=trace \\\n') +
      c.dim(`                      -c 'model_providers.trace.base_url="http://${HOST}:${PORT}/backend-api/codex"' \\\n`) +
      c.dim("                      -c 'model_providers.trace.wire_api=\"responses\"' \\\n") +
      c.dim("                      -c 'model_providers.trace.requires_openai_auth=true'")
  );
  if (UI_PREFIX) console.log(c.bold(`  interface  :  http://${HOST}:${PORT}${UI_PREFIX}\n`));
  else console.log('');
  pruneTraces();
  try {
    const dirs = fs.readdirSync(TRACE_DIR, { withFileTypes: true }).filter((e) => e.isDirectory());
    const bytes = dirs.reduce((a, e) => a + dirSize(path.join(TRACE_DIR, e.name)), 0);
    const lim = [
      MAX_COUNT > 0 ? `${MAX_COUNT} records` : null,
      MAX_BYTES > 0 ? `${(MAX_BYTES / 1073741824).toFixed(1)} GB` : null,
      MAX_AGE_MS > 0 ? `${MAX_AGE_MS / 86400000} days` : null,
    ].filter(Boolean).join(' / ');
    console.log(c.dim(`  ${dirs.length} stored · ${(bytes / 1048576).toFixed(1)} MB  (limits: ${lim || 'none'})\n`));
  } catch {}
});

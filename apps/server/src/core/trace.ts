/**
 * Per-user records of what actually went upstream.
 *
 * Why not just use the proxy's own UI: it is **global**, holding everyone's complete
 * prompts, and its authentication only distinguishes administrator from not (loopback or
 * an admin token). Opening it to ordinary users would mean opening everyone's
 * conversations to everyone. It is also an optional side component — not running it means
 * no data.
 *
 * So the recording point is the **metering gateway**, the one place that holds both the
 * userId (from the ticket) and the full payload. Files go into a directory per userId,
 * and on read that directory name is built from the **authenticated identity**; the
 * client cannot supply it, so reading someone else's is not possible by construction.
 *
 * What is stored is a structured summary rather than raw bytes: a user wants to know how
 * long the system prompt was, which tools were attached, how deep the history is and what
 * went out this time — not 200KB of verbatim tool_result. Oversized blocks are truncated
 * and marked.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config, paths } from './config.js';

/** Characters kept per text block before truncation */
const BLOCK_CHARS = 8_000;
/** Records kept per user; the oldest go first */
const KEEP_PER_USER = 50;

export interface TraceBlock {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  toolUseId?: string;
  isError?: boolean;
  chars?: number;
  truncated?: boolean;
  cacheControl?: boolean;
}

export interface TraceMessage {
  role: string;
  blocks: TraceBlock[];
}

export interface TraceDetail {
  id: string;
  at: string;
  conversationId?: string;
  turnId?: string;
  agent?: string;
  /** Which credential this request used: runtime for our containers, api-key for a user's own CLI */
  credential?: 'runtime' | 'api-key';
  wire: string;
  model?: string;
  stream: boolean;
  /** The upstream provider's name — no address, no key */
  upstream?: string;
  system: TraceBlock[];
  tools: Array<{ name: string; chars: number }>;
  messages: TraceMessage[];
  response: {
    status: number;
    durationMs: number;
    ttftMs?: number;
    queueWaitMs?: number;
    usage?: Record<string, number>;
    error?: string;
  };
}

/** The slimmed-down shape the list page uses */
export interface TraceSummary {
  id: string;
  at: string;
  conversationId?: string;
  agent?: string;
  model?: string;
  status: number;
  durationMs: number;
  credential?: 'runtime' | 'api-key';
  messageCount: number;
  toolCount: number;
  usage?: Record<string, number>;
  /** The start of the last user message, so a turn can be recognised */
  preview: string;
}

const dirFor = (userId: string) => path.join(paths.traces, userId);

/** ids are only accepted in the shape we generate, so path building cannot be traversed */
const ID_RE = /^[0-9]{13}-[0-9a-f]{8}$/;

function clip(s: string): TraceBlock {
  const chars = s.length;
  return chars > BLOCK_CHARS
    ? { type: 'text', text: s.slice(0, BLOCK_CHARS), chars, truncated: true }
    : { type: 'text', text: s, chars };
}

function blockOf(b: Record<string, unknown>): TraceBlock {
  const type = String(b.type ?? 'unknown');
  const out: TraceBlock = { type };
  if (b.cache_control) out.cacheControl = true;

  if (type === 'text' || type === 'input_text' || type === 'output_text') {
    const t = clip(String(b.text ?? ''));
    out.text = t.text;
    out.chars = t.chars;
    if (t.truncated) out.truncated = true;
  } else if (type === 'tool_use' || type === 'function_call') {
    out.name = String(b.name ?? '');
    const raw = JSON.stringify(b.input ?? b.arguments ?? {});
    out.input = raw.length > BLOCK_CHARS ? raw.slice(0, BLOCK_CHARS) : raw;
    out.chars = raw.length;
    if (raw.length > BLOCK_CHARS) out.truncated = true;
  } else if (type === 'tool_result' || type === 'function_call_output') {
    out.toolUseId = String(b.tool_use_id ?? b.call_id ?? '');
    out.isError = Boolean(b.is_error);
    const raw = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
    const t = clip(raw);
    out.text = t.text;
    out.chars = t.chars;
    if (t.truncated) out.truncated = true;
  }
  return out;
}

function messagesOf(body: Record<string, unknown>): TraceMessage[] {
  const raw = (body.messages ?? body.input) as unknown;
  if (!Array.isArray(raw)) return [];
  return raw.map((m) => {
    const msg = (m ?? {}) as Record<string, unknown>;
    const role = String(msg.role ?? msg.type ?? '?');
    const content = msg.content;
    if (typeof content === 'string') return { role, blocks: [clip(content)] };
    if (Array.isArray(content))
      return { role, blocks: content.map((b) => blockOf((b ?? {}) as Record<string, unknown>)) };
    return { role, blocks: [] };
  });
}

function systemOf(body: Record<string, unknown>): TraceBlock[] {
  const sys = body.system ?? body.instructions;
  if (typeof sys === 'string') return [clip(sys)];
  if (Array.isArray(sys))
    return sys.map((b) => blockOf((b ?? {}) as Record<string, unknown>));
  return [];
}

function toolsOf(body: Record<string, unknown>): Array<{ name: string; chars: number }> {
  const tools = body.tools;
  if (!Array.isArray(tools)) return [];
  return tools.map((t) => {
    const tool = (t ?? {}) as Record<string, unknown>;
    const fn = (tool.function ?? tool) as Record<string, unknown>;
    return { name: String(fn.name ?? '?'), chars: JSON.stringify(tool).length };
  });
}

export interface RecordInput {
  userId: string;
  conversationId?: string;
  turnId?: string;
  agent?: string;
  credential?: 'runtime' | 'api-key';
  wire: string;
  upstream?: string;
  body: unknown;
  status: number;
  durationMs: number;
  ttftMs?: number;
  queueWaitMs?: number;
  usage?: Record<string, number>;
  error?: string;
}

/** Record one. Any failure costs a trace and must never affect the request in flight. */
export function record(input: RecordInput): void {
  if (!config.traceRequests) return;
  try {
    const body = (input.body ?? {}) as Record<string, unknown>;
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const detail: TraceDetail = {
      id,
      at: new Date().toISOString(),
      conversationId: input.conversationId,
      turnId: input.turnId,
      agent: input.agent,
      credential: input.credential,
      wire: input.wire,
      model: typeof body.model === 'string' ? body.model : undefined,
      stream: body.stream !== false,
      upstream: input.upstream,
      system: systemOf(body),
      tools: toolsOf(body),
      messages: messagesOf(body),
      response: {
        status: input.status,
        durationMs: input.durationMs,
        ttftMs: input.ttftMs,
        queueWaitMs: input.queueWaitMs,
        usage: input.usage,
        error: input.error,
      },
    };
    const dir = dirFor(input.userId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(detail));
    prune(dir);
  } catch {
    /* A failed recording must not affect the request */
  }
}

function prune(dir: string): void {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - KEEP_PER_USER))) {
    fs.rmSync(path.join(dir, f), { force: true });
  }
}

function summarize(d: TraceDetail): TraceSummary {
  const lastUser = [...d.messages].reverse().find((m) => m.role === 'user');
  const preview =
    lastUser?.blocks.map((b) => b.text ?? b.name ?? '').find((t) => t) ?? '';
  return {
    id: d.id,
    at: d.at,
    conversationId: d.conversationId,
    agent: d.agent,
    model: d.model,
    status: d.response.status,
    durationMs: d.response.durationMs,
    credential: d.credential,
    messageCount: d.messages.length,
    toolCount: d.tools.length,
    usage: d.response.usage,
    preview: preview.replace(/\s+/g, ' ').slice(0, 120),
  };
}

/** One user's own traces, newest first */
export function list(userId: string, limit = 50): TraceSummary[] {
  const dir = dirFor(userId);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort().reverse();
  } catch {
    return [];
  }
  const out: TraceSummary[] = [];
  for (const f of files.slice(0, limit)) {
    try {
      out.push(summarize(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) as TraceDetail));
    } catch {
      /* Skip a half-written file */
    }
  }
  return out;
}

/** Read one. userId comes from the authenticated identity and id is shape-checked; together they make reading someone else's impossible. */
export function get(userId: string, id: string): TraceDetail | undefined {
  if (!ID_RE.test(id)) return undefined;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(dirFor(userId), `${id}.json`), 'utf8'),
    ) as TraceDetail;
  } catch {
    return undefined;
  }
}

/** The user clearing their own */
export function clear(userId: string): number {
  const dir = dirFor(userId);
  try {
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    for (const f of files) fs.rmSync(path.join(dir, f), { force: true });
    return files.length;
  } catch {
    return 0;
  }
}

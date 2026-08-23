import { setSetting } from '../core/db/settings.js';
import type { Wire } from './usage-parser.js';

/**
 * What the upstream says about **its own** allowance, kept for the administrator.
 *
 * Users are deliberately never shown this: one subscription serves every tenant, so the
 * pool's figures are not any one user's allowance, and quota-report.ts replaces them on the
 * way out. The administrator is the opposite case — they are the one person who has to know
 * how much of the shared plan is left, and there is nowhere else to read it: the figures
 * exist only on responses passing through this process.
 *
 * So the headers are recorded here as they arrived, verbatim, alongside a parsed view. The
 * raw copy matters: this is the one screen where a wrong reading is worse than an unparsed
 * one, and the upstream is free to add fields we do not know about yet.
 *
 * **In memory, in the gateway process.** Same reasoning as the concurrency gate: this is
 * observed here, so it lives here, and the console reaches it by forwarding
 * (app/routes/admin/upstream.ts). It is lost on restart and refilled by the next upstream
 * response, which is the right trade for a figure that is only ever "as of the last call".
 */

export interface AllowanceWindow {
  /** 0..1, the scale the headers use */
  utilization: number | null;
  /** ISO 8601, converted from the unix seconds the headers carry */
  resetsAt: string | null;
  status: string | null;
}

export interface Allowance {
  /** Which provider this was observed through */
  provider: string;
  wire: Wire;
  /** When we saw it */
  observedAt: string;
  status: string | null;
  resetsAt: string | null;
  /** Which window the top-level status refers to */
  representative: string | null;
  /** Keyed by the upstream's own abbreviations: 5h, 7d, 7d_oi, overage */
  windows: Record<string, AllowanceWindow>;
  /** Everything the upstream sent on the subject, unparsed */
  raw: Record<string, string>;
  /** Codex has no allowance headers; its figures ride in the response body */
  codex?: unknown;
}

const PREFIX = 'anthropic-ratelimit-unified-';

/** Anything the upstream says about limits, by the same rule the audit proxy uses */
function isAllowanceHeader(k: string): boolean {
  return (
    k.startsWith('anthropic-ratelimit')
    || k.startsWith('x-ratelimit')
    || k.startsWith('x-codex-credits')
    || k.startsWith('x-codex-rate-limit')
    || k === 'x-codex-active-limit'
    || k === 'retry-after'
  );
}

function num(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The headers carry unix seconds; the console wants something it can print */
function isoFromEpoch(v: string | undefined): string | null {
  const n = num(v);
  return n === null ? null : new Date(Math.round(n) * 1000).toISOString();
}

let last: Allowance | null = null;

export function record(provider: string, wire: Wire, headers: Headers): void {
  const raw: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (isAllowanceHeader(k)) raw[k] = value;
  });
  if (Object.keys(raw).length === 0) return; // Nothing said; keep the previous reading

  const windows: Record<string, AllowanceWindow> = {};
  for (const key of Object.keys(raw)) {
    // anthropic-ratelimit-unified-5h-utilization → 5h
    if (!key.startsWith(PREFIX)) continue;
    const rest = key.slice(PREFIX.length);
    const dash = rest.lastIndexOf('-');
    if (dash <= 0) continue;
    const name = rest.slice(0, dash);
    const field = rest.slice(dash + 1);
    if (field !== 'utilization' && field !== 'reset' && field !== 'status') continue;
    const w = (windows[name] ??= { utilization: null, resetsAt: null, status: null });
    if (field === 'utilization') w.utilization = num(raw[key]);
    else if (field === 'reset') w.resetsAt = isoFromEpoch(raw[key]);
    else w.status = raw[key] ?? null;
  }

  last = {
    provider,
    wire,
    observedAt: new Date().toISOString(),
    status: raw[`${PREFIX}status`] ?? null,
    resetsAt: isoFromEpoch(raw[`${PREFIX}reset`]),
    representative: raw[`${PREFIX}representative-claim`] ?? null,
    windows,
    raw,
    codex: last?.codex,
  };

  /*
   * The 5-hour window's reset is not only the administrator's business: it is the boundary
   * every user's quota is cut at, and quotas are computed in both containers. So it goes to
   * the database — the one store the two share — and only when it changes, which is once
   * every five hours rather than once a request.
   */
  const reset = windows['5h']?.resetsAt;
  if (reset && reset !== lastPersisted) {
    lastPersisted = reset;
    try {
      setSetting('quota.windowResetAt', reset);
    } catch {
      // A read-only or busy database must not take the response down with it; the window
      // falls back to the clock, which is still the same for everybody
    }
  }
}

/** What was last written, so an unchanged reset does not write on every response */
let lastPersisted: string | undefined;

/**
 * Codex's allowance, which arrives inside the response body rather than in headers.
 *
 * Recorded on the way past — quota-report.ts removes the same object before the body reaches
 * the client, so this is the only place it survives.
 */
export function recordCodex(provider: string, wire: Wire, rateLimits: unknown): void {
  last = {
    provider,
    wire,
    observedAt: new Date().toISOString(),
    status: last?.provider === provider ? last.status : null,
    resetsAt: last?.provider === provider ? last.resetsAt : null,
    representative: last?.provider === provider ? last.representative : null,
    windows: last?.provider === provider ? last.windows : {},
    raw: last?.provider === provider ? last.raw : {},
    codex: rateLimits,
  };
}

/** null means nothing has come back from an upstream since this process started */
export function snapshot(): Allowance | null {
  return last;
}

/** Test seam */
export function reset(): void {
  last = null;
}

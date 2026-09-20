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
  /**
   * When this window was last mentioned, which is not when the reading was taken.
   *
   * A response only carries the windows its own request counted against: `7d_oi` arrives
   * on Claude Fable and on nothing else — 68 responses here, every one of them Fable —
   * so the reading is as old as the last time somebody used that class of model, and the
   * console says so rather than presenting it as current.
   */
  observedAt: string;
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

/**
 * The allowances every model on a plan counts against, by the name a refusal gives them: the
 * 5-hour window, the weekly one, and the usage credits behind both.
 */
const PLAN_WIDE_CLAIMS = new Set(['five_hour', 'seven_day', 'overage']);

/**
 * Whether a 429 refuses only some models, leaving the upstream open to the rest.
 *
 * A subscription also has allowances that only some models count against. `7d_oi` is Claude
 * Fable's weekly one. Captured through the audit proxy, the 429 when it ran out named
 * `seven_day_overage_included` in `representative-claim` and marked only that window
 * rejected, with the 5-hour and weekly ones still open and a retry-after of five days.
 * `seven_day_opus` and `seven_day_sonnet` are the same for those families. Claude Code reads
 * the claim to tell its user which limit they hit, and calls these three the Fable, Opus and
 * Sonnet limits.
 *
 * The concurrency gate takes a 429 as the upstream pushing back on everything sent to it: it
 * halves the upstream's concurrency and holds every request for as long as retry-after says,
 * up to an hour. For one of these narrower allowances that stops every other model on the
 * plan behind a refusal that is not about them, and they time out in the queue.
 *
 * A claim not listed above counts as narrower, including one this code has never seen. Wrong
 * in that direction, a few requests reach an upstream that refuses them at once; wrong in the
 * other, every model on the plan stops for an hour. A 429 whose top-level status is still
 * allowed has not refused anything on allowance grounds, so it stays the gate's to act on.
 */
export function refusesOnlySomeModels(status: number, headers: Headers): boolean {
  if (status !== 429) return false;
  const claim = headers.get(`${PREFIX}representative-claim`);
  if (claim === null || PLAN_WIDE_CLAIMS.has(claim)) return false;
  const overall = headers.get(`${PREFIX}status`);
  return overall === null || overall === 'rejected';
}

/** Last writer, for callers that still ask "what just came back" */
let last: Allowance | null = null;
/** One reading per upstream. Claude does not wipe Cursor when both are in use. */
const byProvider = new Map<string, Allowance>();

function store(next: Allowance): void {
  byProvider.set(next.provider, next);
  last = next;
}

export function record(provider: string, wire: Wire, headers: Headers): void {
  const raw: Record<string, string> = {};
  headers.forEach((value, key) => {
    const k = key.toLowerCase();
    if (isAllowanceHeader(k)) raw[k] = value;
  });
  if (Object.keys(raw).length === 0) return; // Nothing said; keep the previous reading

  /*
   * Carried over rather than rebuilt. Each response names only the windows its own request
   * counted against, so replacing the set wholesale meant Fable's weekly window lived until
   * the next response from any other model — a few seconds, in practice, and never long
   * enough for anybody to see it. A window is dropped only when the upstream it belongs to
   * changes; until then the last reading stands with its own timestamp.
   */
  const prev = byProvider.get(provider);
  const carried = prev && prev.wire === wire ? prev.windows : {};
  const windows: Record<string, AllowanceWindow> = { ...carried };
  const now = new Date().toISOString();
  for (const key of Object.keys(raw)) {
    // anthropic-ratelimit-unified-5h-utilization → 5h
    if (!key.startsWith(PREFIX)) continue;
    const rest = key.slice(PREFIX.length);
    const dash = rest.lastIndexOf('-');
    if (dash <= 0) continue;
    const name = rest.slice(0, dash);
    const field = rest.slice(dash + 1);
    if (field !== 'utilization' && field !== 'reset' && field !== 'status') continue;
    // A window this response mentions is this response's reading, not the carried one
    const w = (windows[name] =
      windows[name]?.observedAt === now
        ? windows[name]
        : { utilization: null, resetsAt: null, status: null, observedAt: now });
    if (field === 'utilization') w.utilization = num(raw[key]);
    else if (field === 'reset') w.resetsAt = isoFromEpoch(raw[key]);
    else w.status = raw[key] ?? null;
  }

  store({
    provider,
    wire,
    observedAt: now,
    status: raw[`${PREFIX}status`] ?? null,
    resetsAt: isoFromEpoch(raw[`${PREFIX}reset`]),
    representative: raw[`${PREFIX}representative-claim`] ?? null,
    windows,
    raw,
    codex: prev?.codex,
  });

  /*
   * These two resets are not only the administrator's business: they are the boundaries
   * every user's quota is cut at, and quotas are computed in both containers. So they go to
   * the database — the one store the two share — and only when they change, which is once
   * a window rather than once a request.
   */
  persist('quota.windowResetAt', windows['5h']?.resetsAt);
  persist('quota.weekResetAt', windows['7d']?.resetsAt);
}

/** What was last written per key, so an unchanged reset does not write on every response */
const lastPersisted = new Map<string, string>();

function persist(key: string, reset: string | null | undefined): void {
  if (!reset || lastPersisted.get(key) === reset) return;
  try {
    setSetting(key, reset);
    // Only after it landed: marking first meant one busy database lost the boundary for the
    // whole window, since every later response would see the value as already written
    lastPersisted.set(key, reset);
  } catch {
    // A read-only or busy database must not take the response down with it; the window
    // falls back to the clock, which is still the same for everybody
  }
}

/**
 * Codex's allowance, which arrives inside the response body rather than in headers.
 *
 * Recorded on the way past — quota-report.ts removes the same object before the body reaches
 * the client, so this is the only place it survives.
 */
export function recordCodex(provider: string, wire: Wire, rateLimits: unknown): void {
  const prev = byProvider.get(provider);
  store({
    provider,
    wire,
    observedAt: new Date().toISOString(),
    status: prev?.status ?? null,
    resetsAt: prev?.resetsAt ?? null,
    representative: prev?.representative ?? null,
    windows: prev?.windows ?? {},
    raw: prev?.raw ?? {},
    codex: rateLimits,
  });
}

/** The most recent reading, whichever upstream answered last */
export function snapshot(): Allowance | null {
  return last;
}

/** The reading for one upstream, or null if it has not spoken since this process started */
export function snapshotFor(provider: string): Allowance | null {
  return byProvider.get(provider) ?? null;
}

/** Every upstream that has reported, newest first so the console can show them all */
export function snapshots(): Allowance[] {
  return [...byProvider.values()].sort((a, b) => (a.observedAt < b.observedAt ? 1 : -1));
}

/** Test seam */
export function reset(): void {
  last = null;
  byProvider.clear();
  lastPersisted.clear();
}

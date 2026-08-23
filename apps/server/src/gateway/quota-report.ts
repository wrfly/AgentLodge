import type { QuotaStatus } from '../core/protocol.js';

/**
 * Telling a CLI how much of **its own** allowance is left.
 *
 * One upstream subscription serves every tenant, so everything the upstream says about
 * remaining allowance describes the pool: the `anthropic-ratelimit-unified-*` headers on
 * every response, the `/api/oauth/usage` panel behind `/usage`, and — on the Codex side —
 * a `rate_limits` object riding inside the response body. Relaying any of it shows one
 * user the whole platform's consumption, against a ceiling that is not theirs.
 *
 * So the gateway answers with the asking user's own quota instead. Nothing from the
 * upstream reaches a client on its own: the relay writes a fixed set of response headers
 * and the upstream's are dropped with the rest, and what this module produces takes their
 * place.
 *
 * **The two formats disagree with each other, and it matters.** Both were read out of the
 * claude binary rather than guessed:
 *
 *   response headers    utilization is a fraction 0..1, reset is unix seconds
 *   /api/oauth/usage    utilization is a percentage 0..100, resets_at is an ISO 8601 string
 *
 * Sending a percentage on the header side is not a rounding error — the client clamps with
 * `max(0, min(1, n))`, so every request past 1% would look like the limit was blown.
 *
 * **Who listens, measured rather than assumed.**
 *
 * The headers are the channel that works. Claude Code honours them only for a claude.ai
 * subscription session (`extractQuotaStatusFromHeaders` opens with
 * `if (!Oqr(ds())) { this.rawUtilization = {}; return null }`), and the credential a user
 * installs — a credentials file in a config directory of ours, see app/cli-install.ts —
 * makes the session count as one. Measured: answering with a utilization of 0.98 makes the
 * CLI emit
 * `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.98,"rateLimitType":"five_hour"}}`,
 * against this user's quota rather than the pool's.
 *
 * The `/usage` panel does **not** come through here, and does not need to. Logging CONNECT
 * through an HTTPS proxy showed that request going straight to `api.anthropic.com:443` with
 * the machine's own claude.ai credentials, ignoring ANTHROPIC_BASE_URL — and in the profile
 * we install there is no claude.ai account, so the panel shows no allowance and makes no
 * outbound connection at all. `oauthUsage` therefore exists to keep that path from ever
 * being proxied: asked, we answer with the caller's own quota rather than fetching the
 * pool's.
 */

/**
 * Which of Claude Code's two fixed windows a quota period is reported in.
 *
 * The titles are hard-coded on its side — "Current session" for five_hour, "Current week
 * (all models)" for seven_day — so the choice is only about which one reads less like a
 * lie. Nothing is gained by filling both: they would carry the same number twice.
 */
export type Claim = 'five_hour' | 'seven_day';

const SHORT_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Epoch seconds, or null when the timestamp is missing or unparseable */
function epochSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The ceiling in whichever unit this quota is counted in */
function limitOf(q: QuotaStatus): number | null {
  return q.limitKind === 'cost' ? q.costLimitMicro : q.limit;
}

/** No ceiling of the relevant kind means there is nothing to report */
function unlimited(q: QuotaStatus): boolean {
  return limitOf(q) === null;
}

/** How long this quota's period runs, or null when it has no end */
function periodMs(q: QuotaStatus): number | null {
  if (!q.periodEnd) return null;
  const length = new Date(q.periodEnd).getTime() - new Date(q.periodStart).getTime();
  return Number.isFinite(length) && length > 0 ? length : null;
}

/**
 * Measured against the period's own length rather than its name: a rolling quota can be
 * two hours or two months, and only the length decides which window it resembles.
 */
export function claimFor(q: QuotaStatus): Claim {
  const start = new Date(q.periodStart).getTime();
  const end = q.periodEnd ? new Date(q.periodEnd).getTime() : NaN;
  const length = end - start;
  return Number.isFinite(length) && length > 0 && length <= SHORT_WINDOW_MS
    ? 'five_hour'
    : 'seven_day';
}

const ABBREV: Record<Claim, string> = { five_hour: '5h', seven_day: '7d' };

/** The three values the client acts on */
function statusOf(q: QuotaStatus): 'allowed' | 'allowed_warning' | 'rejected' {
  if (q.exceeded) return 'rejected';
  return q.warning ? 'allowed_warning' : 'allowed';
}

/**
 * The `anthropic-ratelimit-unified-*` set, describing this user's quota.
 *
 * Only the fields we can answer honestly are sent. Overage, fallback and upgrade paths are
 * concepts of the upstream's billing, not ours, and the client reads each of them as an
 * exact string match (`=== 'available'`, `=== 'true'`), so leaving them out is read as
 * "not applicable" rather than as a missing value.
 */
export function unifiedHeaders(q: QuotaStatus, windows: Windows = {}): Record<string, string> {
  if (unlimited(q)) return {};

  const status = statusOf(q);
  const out: Record<string, string> = {};

  // The upstream's windows when they are known, so the warnings the client raises are about
  // the window that will actually run out, at the instant it actually runs out
  for (const claim of ['five_hour', 'seven_day'] as const) {
    const observed = windows[claim];
    if (!observed) continue;
    const reset = epochSeconds(observed.resetsAt);
    const pace = paceOf(q, observed.used, WINDOW_MS[claim]);
    if (reset === null || pace === null) continue;
    const n = ABBREV[claim];
    out[`anthropic-ratelimit-unified-${n}-status`] = status;
    // The header scale is a fraction; the panel's is a percentage
    out[`anthropic-ratelimit-unified-${n}-utilization`] = (pace / 100).toFixed(4);
    out[`anthropic-ratelimit-unified-${n}-reset`] = String(reset);
  }

  if (Object.keys(out).length > 0) {
    const representative = windows.five_hour ? 'five_hour' : 'seven_day';
    const reset = epochSeconds(windows[representative]?.resetsAt ?? null);
    return {
      'anthropic-ratelimit-unified-status': status,
      ...(reset === null ? {} : { 'anthropic-ratelimit-unified-reset': String(reset) }),
      'anthropic-ratelimit-unified-representative-claim': representative,
      ...out,
    };
  }

  // Nothing observed from the upstream yet: fall back to the quota's own period. A window
  // needs both figures — the client skips one that has a utilization and no reset — so a
  // period that never ends reports nothing here and shows up only in the panel.
  const reset = epochSeconds(q.periodEnd);
  if (reset === null) return {};

  const claim = claimFor(q);
  const n = ABBREV[claim];
  const resetStr = String(reset);
  return {
    'anthropic-ratelimit-unified-status': status,
    'anthropic-ratelimit-unified-reset': resetStr,
    'anthropic-ratelimit-unified-representative-claim': claim,
    [`anthropic-ratelimit-unified-${n}-status`]: status,
    [`anthropic-ratelimit-unified-${n}-utilization`]: q.ratio.toFixed(4),
    [`anthropic-ratelimit-unified-${n}-reset`]: resetStr,
  };
}

export interface UsageWindow {
  /** Percentage of the window used, 0-100 */
  utilization: number | null;
  /** ISO 8601, or null for a quota that never resets */
  resets_at: string | null;
}

/**
 * The body of `GET /api/oauth/usage`.
 *
 * Every key the client's schema knows about is present, because it is a `passthrough`
 * object parse: an absent key and a null one both mean "no such window", but sending the
 * full shape keeps what we return recognisable next to a real capture.
 */
export interface OAuthUsage {
  five_hour: UsageWindow | null;
  seven_day: UsageWindow | null;
  seven_day_oauth_apps: null;
  seven_day_opus: null;
  seven_day_sonnet: null;
  cinder_cove: null;
  /** Paid-overage credits, which we do not have */
  extra_usage: null;
  /** Per-model weekly windows; ours is not split by model */
  limits: [];
}

const HOUR_MS = 60 * 60_000;

/** The platform's two windows, as the upstream defines them */
export const WINDOW_MS: Record<Claim, number> = {
  five_hour: 5 * HOUR_MS,
  seven_day: 7 * 24 * HOUR_MS,
};

/**
 * One of the platform's windows, as it applies to one user.
 *
 * **The boundary belongs to the upstream, the amount belongs to the user.** These two lines
 * are the platform's windows — one subscription, one 5-hour window, one weekly window, the
 * same instants for everybody — and the upstream states when each resets on every response.
 * A window measured from a user's own first message instead would tell them their allowance
 * runs until nine when the pool empties at seven.
 *
 * The amount is that user's own consumption inside those boundaries, so nobody learns what
 * anybody else spent.
 */
export interface ObservedWindow {
  /** What this user spent inside the window, in whichever unit the quota counts */
  used: number;
  /** When the upstream says the window resets, ISO 8601 */
  resetsAt: string;
}

export type Windows = Partial<Record<Claim, ObservedWindow>>;

/**
 * A user's share of a window, as a percentage.
 *
 * The denominator is their own quota stretched to the window's length: a daily ceiling of
 * 10M is about 2.08M over five hours. That makes it a **pace** — am I burning faster than my
 * allowance allows — rather than a second limit. Nothing here blocks; the quota does, and
 * says so in its own words when it refuses a request.
 */
function paceOf(q: QuotaStatus, used: number, windowMs: number): number | null {
  const limit = limitOf(q);
  const length = periodMs(q);
  if (limit === null || limit <= 0 || length === null) return null;
  const allowance = (limit * windowMs) / length;
  return allowance > 0 ? Math.min(Math.round((used / allowance) * 100), 100) : null;
}

/** The panel's shape for one window, or null when there is nothing to say about it */
function panelWindow(q: QuotaStatus, claim: Claim, windows: Windows): UsageWindow | null {
  const observed = windows[claim];
  if (!observed) return null;
  const utilization = paceOf(q, observed.used, WINDOW_MS[claim]);
  return utilization === null ? null : { utilization, resets_at: observed.resetsAt };
}

/**
 * What the upstream's windows are worth to this user.
 *
 * With no observation yet — a gateway that has just started, or an upstream that reports no
 * allowance at all, such as the built-in mock — this falls back to the quota's own period in
 * whichever of the two windows it resembles. That is a worse answer, and it is the honest
 * one: better the user's real ceiling under a roughly-fitting label than a window whose
 * boundaries we would have to invent.
 */
export function oauthUsage(q: QuotaStatus, windows: Windows = {}): OAuthUsage {
  const empty: OAuthUsage = {
    five_hour: null,
    seven_day: null,
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    cinder_cove: null,
    extra_usage: null,
    limits: [],
  };
  if (unlimited(q)) return empty;

  if (windows.five_hour || windows.seven_day) {
    return {
      ...empty,
      five_hour: panelWindow(q, 'five_hour', windows),
      seven_day: panelWindow(q, 'seven_day', windows),
    };
  }

  const window: UsageWindow = {
    utilization: Math.round(q.ratio * 100),
    resets_at: q.periodEnd,
  };
  const claim = claimFor(q);
  return {
    ...empty,
    five_hour: claim === 'five_hour' ? window : null,
    seven_day: claim === 'seven_day' ? window : null,
  };
}

/**
 * Removing the shared account's allowance from a Codex response.
 *
 * Codex has no usage endpoint: its figures ride inside the response — `rate_limits`, with
 * `primary` and `secondary`, each carrying `used_percent`, `window_minutes`, `resets_at`
 * and `plan_type` — and the body is relayed byte for byte, so those percentages are the
 * pool's and they arrive at every user's `codex /status`.
 *
 * They are dropped from the client's copy rather than replaced. The field shapes above come
 * from a capture, and
 * writing a wrong `resets_at` back into a stream the client parses is worse than the
 * client having nothing to show; a replacement can be written when there is a capture to
 * check it against. Dropping is safe in a way rewriting is not: the field is optional, and
 * an absent one is the same as a response from a plan without limits.
 */
export function stripRateLimits(json: string, onFound?: (rateLimits: unknown) => void): string | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null; // Not JSON, so not something to edit
  }
  if (!value || typeof value !== 'object') return null;

  const obj = value as Record<string, unknown>;
  let hit = false;
  if ('rate_limits' in obj) {
    onFound?.(obj.rate_limits);
    delete obj.rate_limits;
    hit = true;
  }
  // Codex sends it both at the top level and on the response object, depending on the event
  const response = obj.response;
  if (response && typeof response === 'object' && 'rate_limits' in response) {
    onFound?.((response as Record<string, unknown>).rate_limits);
    delete (response as Record<string, unknown>).rate_limits;
    hit = true;
  }
  return hit ? JSON.stringify(obj) : null;
}

/**
 * The same, over a stream.
 *
 * Line-buffered because a chunk boundary falls wherever the network puts it, and half a
 * `data:` line is not JSON. Lines that need no edit are passed through unchanged rather
 * than re-serialised, so everything except the one object we remove stays byte-identical.
 */
export class RateLimitScrubber {
  private buf = '';
  private readonly onFound?: (rateLimits: unknown) => void;

  /**
   * @param onFound handed each allowance object on its way out. The administrator's console
   * is the one place it is still wanted, and this is the last point it exists — see
   * gateway/upstream-allowance.ts.
   */
  constructor(onFound?: (rateLimits: unknown) => void) {
    this.onFound = onFound;
  }

  /** Feed in upstream text; get back what should go to the client */
  push(chunk: string): string {
    this.buf += chunk;
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';
    if (parts.length === 0) return '';
    return `${parts.map((line) => this.line(line)).join('\n')}\n`;
  }

  /** Whatever is left when the upstream closes mid-line */
  end(): string {
    const rest = this.buf;
    this.buf = '';
    return rest ? this.line(rest) : '';
  }

  private line(line: string): string {
    // A CRLF stream keeps its \r: it belongs to the line ending, not to the payload
    const cr = line.endsWith('\r');
    const body = cr ? line.slice(0, -1) : line;
    if (!body.startsWith('data:') || !body.includes('"rate_limits"')) return line;

    const payload = body.slice(5).trim();
    if (!payload || payload === '[DONE]') return line;
    const edited = stripRateLimits(payload, this.onFound);
    return edited === null ? line : `data: ${edited}${cr ? '\r' : ''}`;
  }
}

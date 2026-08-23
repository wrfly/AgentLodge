import type { QuotaStatus, QuotaWindow } from '../core/protocol.js';

/**
 * Telling a CLI how much of **its own** allowance is left.
 *
 * One upstream subscription serves every tenant, so everything the upstream says about
 * remaining allowance describes the pool: the `anthropic-ratelimit-unified-*` headers on
 * every response, the `/api/oauth/usage` panel behind `/usage`, and — on the Codex side —
 * a `rate_limits` object riding inside the response body. Relaying any of it shows one
 * user the whole platform's consumption, against a ceiling that is not theirs.
 *
 * What goes out instead is this user's own quota, and it lines up exactly: the client has a
 * 5-hour window and a weekly one, and so does the quota. Same instants for everybody, same
 * meaning on both sides, nothing pro-rated or approximated.
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
 * **Who listens.** The headers are the channel that works: Claude Code honours them only for
 * a claude.ai subscription session (`extractQuotaStatusFromHeaders` opens with
 * `if (!Oqr(ds())) { this.rawUtilization = {}; return null }`), and the credential a user
 * installs — a credentials file in a config directory of ours, see app/cli-install.ts —
 * makes the session count as one. Measured: answering with a utilization of 0.98 makes the
 * CLI emit a rate_limit_event with status allowed_warning.
 *
 * The `/usage` panel does **not** come through here, and does not need to. That request goes
 * straight to `api.anthropic.com` with the machine's own claude.ai credentials, ignoring
 * ANTHROPIC_BASE_URL — and in the profile we install there is no claude.ai account, so the
 * panel shows no allowance and makes no outbound connection at all. `oauthUsage` therefore
 * exists to keep that path from ever being proxied: asked, we answer with the caller's own
 * quota rather than fetching the pool's.
 */

/** Which of the quota's windows each of the client's two lines carries */
const CLAIMS = [
  { header: '5h', panel: 'five_hour', scope: 'window' },
  { header: '7d', panel: 'seven_day', scope: 'week' },
] as const;

/** Epoch seconds, or null when the timestamp is missing or unparseable */
function epochSeconds(iso: string | null): number | null {
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** allowed | allowed_warning | rejected — the three the client acts on */
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
 *
 * A window with no ceiling is left out entirely rather than sent as zero: the client skips
 * a window it has no figures for, which is exactly right for one that cannot run out.
 */
export function unifiedHeaders(q: QuotaStatus): Record<string, string> {
  const status = statusOf(q);
  const out: Record<string, string> = {};
  let representative: string | null = null;

  for (const claim of CLAIMS) {
    const w: QuotaWindow = q.windows[claim.scope];
    const reset = epochSeconds(w.endsAt);
    if (w.limit === null || reset === null) continue;
    out[`anthropic-ratelimit-unified-${claim.header}-status`] = status;
    out[`anthropic-ratelimit-unified-${claim.header}-utilization`] = w.ratio.toFixed(4);
    out[`anthropic-ratelimit-unified-${claim.header}-reset`] = String(reset);
    // The first one listed is the short window, which is the one that bites first
    representative ??= claim.panel;
  }

  if (representative === null) return {};
  const scope = representative === 'five_hour' ? 'window' : 'week';
  return {
    'anthropic-ratelimit-unified-status': status,
    'anthropic-ratelimit-unified-reset': String(epochSeconds(q.windows[scope].endsAt)),
    'anthropic-ratelimit-unified-representative-claim': representative,
    ...out,
  };
}

export interface UsageWindow {
  /** Percentage of the window used, 0-100 */
  utilization: number | null;
  /** ISO 8601 */
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

/**
 * The monthly ceiling has no line here — the client's panel has two, and they are the two
 * this maps onto. It is shown in the web console, where there is room to say what it is.
 */
export function oauthUsage(q: QuotaStatus): OAuthUsage {
  const line = (w: QuotaWindow): UsageWindow | null =>
    w.limit === null ? null : { utilization: Math.round(w.ratio * 100), resets_at: w.endsAt };

  return {
    five_hour: line(q.windows.window),
    seven_day: line(q.windows.week),
    seven_day_oauth_apps: null,
    seven_day_opus: null,
    seven_day_sonnet: null,
    cinder_cove: null,
    extra_usage: null,
    limits: [],
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

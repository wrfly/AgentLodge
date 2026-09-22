import * as usersRepo from './db/users.js';
import * as usageRepo from './db/usage.js';
import { WINDOW_MS, periodEndAt, periodStartAt, weekBoundsAt, windowBoundsAt } from './db/period.js';
import { quotaAnchor } from './db/settings.js';
import { getStringFresh } from './db/settings.js';
import type { QuotaScope, QuotaStatus, QuotaWindow } from './protocol.js';
import { MICRO } from './db/pricing.js';

export type { QuotaStatus, QuotaWindow, QuotaScope } from './protocol.js';

/**
 * What a user has left, in each of the platform's three windows.
 *
 * **The windows belong to the platform, the amounts belong to the user.** One subscription
 * has one 5-hour window, one week and one month; they begin and end at the same instants
 * for everybody, and only the consumption inside them differs. Windows measured from each
 * user's own first message would tell somebody who started at four that their allowance
 * runs until nine, when the pool empties at seven and they are refused with most of their
 * quota unspent.
 *
 * A ceiling of null means that window is not limited — a deployment that only cares about
 * the monthly total leaves the other two empty and nothing about them is enforced or shown.
 */

const SCOPES: QuotaScope[] = ['window', 'week', 'month'];

export function scopeLabel(scope: QuotaScope): string {
  return scope === 'window' ? '5-hour window' : scope === 'week' ? 'week' : 'month';
}

/**
 * How long a reported reset stays evidence that some upstream has rolling windows.
 *
 * The two settings below hold an instant, not a timestamp of when we learned it, so age is
 * the only thing there is to go on. A deployment that moved off a Claude subscription keeps
 * whatever that subscription last reported for ever, and would keep being cut on a cadence
 * nothing refills on any more. Well past a week — the longest window anything reports — and
 * long enough that a quiet fortnight does not change how anybody is billed.
 */
const WINDOW_EVIDENCE_MS = 30 * 24 * 3600_000;

/**
 * Whether any upstream has said it has a 5-hour or weekly allowance.
 *
 * Only Anthropic's `anthropic-ratelimit-unified-*` headers write these two settings
 * (gateway/upstream-allowance.ts), so this is the one honest way to ask. The provider's
 * `kind` is not: a Claude subscription is `anthropic-native`, and so are DeepSeek and
 * anybody's own gateway.
 *
 * It matters because Cursor has no such thing. Its plan is a monthly dollar pot — see
 * core/cursor-balance.ts — and cutting a Cursor-only deployment into 5-hour windows
 * phase-locked to nothing invents a cadence for it.
 */
export function upstreamWindowsSeen(now = new Date()): boolean {
  const fresh = (key: string): boolean => {
    const at = getStringFresh(key);
    if (!at) return false;
    const ms = new Date(at).getTime();
    return Number.isFinite(ms) && now.getTime() - ms < WINDOW_EVIDENCE_MS;
  };
  return fresh('quota.windowResetAt') || fresh('quota.weekResetAt');
}

/**
 * The scopes the gate actually enforces, in the order a refusal should name them.
 *
 * All three are still computed and shown — an administrator's typed ceilings stay in the
 * database and the figures stay on the page — but a window no upstream has a counterpart for
 * refuses nobody. Otherwise a Cursor-only deployment holds people at a 5-hour boundary that
 * exists only here, against a pot that refills monthly.
 */
export function enforcedScopes(now = new Date()): QuotaScope[] {
  return upstreamWindowsSeen(now) ? SCOPES : ['month'];
}

/**
 * Where each window begins and ends.
 *
 * The two the upstream also has — 5 hours and a week — follow its cadence rather than the
 * calendar, so that consumption is counted over the same interval the pool refills on. Until
 * an upstream has reported one, each falls back to what it did before; see period.ts. The
 * month is ours alone and stays on the administrator's anchor.
 */
export function boundsOf(scope: QuotaScope, now = new Date()): { start: Date; end: Date } {
  if (scope === 'window') {
    return windowBoundsAt(now, getStringFresh('quota.windowResetAt'), quotaAnchor());
  }
  if (scope === 'week') {
    return weekBoundsAt(now, getStringFresh('quota.weekResetAt'), quotaAnchor());
  }
  const anchor = quotaAnchor();
  const start = periodStartAt('monthly', now, anchor);
  // Both have an end; the fallback is only there because the signature allows null for
  // 'total', which is not a scope any more
  const end = periodEndAt('monthly', now, anchor) ?? new Date(start.getTime() + WINDOW_MS);
  return { start, end };
}

function ceilingOf(q: usersRepo.Quota, scope: QuotaScope): number | null {
  return scope === 'window' ? q.window : scope === 'week' ? q.week : q.month;
}

/**
 * A top-up counts only on the window it was granted for, and only until that window ends.
 *
 * Expiry is the window's own boundary rather than a clock of its own — that is what stops a
 * top-up from handing one user a schedule nobody else is on.
 */
function boostOf(q: usersRepo.Quota, scope: QuotaScope, now: Date): number {
  if (!q.boost || q.boost.scope !== scope) return 0;
  return new Date(q.boost.until).getTime() > now.getTime() ? q.boost.amount : 0;
}

/**
 * The ceiling the gate will actually enforce: the configured one plus any live top-up, or
 * null when the window is uncapped and a top-up would be discarded.
 *
 * Exported because the admin list draws a bar against it. It used to draw against the raw
 * `q.window`, so a user who had just been topped up read past 100% while the gate was still
 * letting them through — the list saying "refused" about somebody it was not refusing.
 */
export function effectiveCeiling(q: usersRepo.Quota, scope: QuotaScope, now = new Date()): number | null {
  const ceiling = ceilingOf(q, scope);
  return ceiling === null ? null : ceiling + boostOf(q, scope, now);
}

function windowStatus(
  userId: string,
  q: usersRepo.Quota,
  scope: QuotaScope,
  now: Date,
): QuotaWindow {
  const { start, end } = boundsOf(scope, now);

  /*
   * One query, and one number. There used to be two: `used`, counted from wherever a manual
   * reset had moved this account's start to, and `spent`, counted from the window's own
   * boundary — because after a reset the gate and the usage report disagreed and the page had
   * to show both to be believable. Zeroing is retired, so a window now begins where it begins
   * for everybody and there is nothing left for a second figure to reconcile.
   */
  /*
   * A ceiling is one number, so what is compared against it has to be one too. `costSettled`
   * is the per-currency spend converted at the configured rates — the only place in the
   * system that collapses money, and only because a limit leaves no choice. Everything that
   * reports rather than enforces keeps the currencies apart.
   */
  const amountOf = (t: usageRepo.Totals) => t.costSettled;
  const from = start.toISOString();
  const to = end.toISOString();
  const used = amountOf(usageRepo.totalsForUser(userId, { from, to }));

  // Reported separately so the interface can mark a top-up, but the ceiling itself comes
  // from the one function that owns that rule
  const boost = boostOf(q, scope, now);
  const limit = effectiveCeiling(q, scope, now);

  return {
    scope,
    limit,
    boost,
    used,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    ratio: limit === null || limit <= 0 ? 0 : Math.min(used / limit, 1),
    startsAt: from,
    endsAt: to,
    exceeded: limit !== null && used >= limit,
  };
}

/**
 * `withTypicalTurn` is off by default, and that is not a performance nicety.
 *
 * This function is on the gate's path — `check()` calls it for every upstream request —
 * and the admin user list calls it once per user. What it would compute is a grouped scan
 * of that user's usage rows, synchronously, on the event loop. Only the three surfaces
 * that actually show "about N more turns" ask for it.
 */
export function status(
  userId: string,
  now = new Date(),
  opts: { withTypicalTurn?: boolean } = {},
): QuotaStatus {
  const q = usersRepo.getQuota(userId);
  const windows = Object.fromEntries(
    SCOPES.map((scope) => [scope, windowStatus(userId, q, scope, now)]),
  ) as Record<QuotaScope, QuotaWindow>;

  /*
   * Every window is computed, only the enforced ones decide anything. A ceiling on a window
   * the gate is not enforcing is still shown — it is what the administrator typed, and it
   * comes back into force the day a subscription with that cadence is configured — but it
   * must not refuse, warn, or be named as the one closest to refusing.
   */
  const enforced = enforcedScopes(now);
  const limited = enforced.map((s) => windows[s]).filter((w) => w.limit !== null);
  // The one that will refuse first: whichever limited window is furthest along
  const tightest = limited.length
    ? limited.reduce((a, b) => (b.ratio > a.ratio ? b : a)).scope
    : null;

  return {
    currency: q.currency,
    hardStop: q.hardStop,
    windows,
    enforced,
    exceeded: limited.some((w) => w.exceeded),
    warning: limited.some((w) => w.ratio >= 0.9),
    tightest,
    // Null both when nobody asked and when there is nothing to say — the one consumer
    // treats either as "no line to show", which is the same answer.
    typicalTurn:
      opts.withTypicalTurn && limited.length ? usageRepo.typicalTurn(userId) : null,
  };
}

export interface Verdict {
  allow: boolean;
  reason?: string;
  status: QuotaStatus;
}

/**
 * When every window that is over its ceiling will have turned over — the earliest instant
 * this user could be let through again.
 *
 * The **latest** of the exceeded windows, not the first. `check()` names the first one it
 * finds, which is the right thing to tell somebody; how long the wait is, is a different
 * question, and answering it with that same window is wrong whenever two are over. A turn
 * held until the 5-hour window resets at two o'clock, on a month that is also exhausted,
 * comes back at two and is refused again — having waited for nothing.
 *
 * Null when nothing is over, and null on a soft quota, which refuses nobody and so has
 * nobody waiting.
 */
export function clearsAt(s: QuotaStatus): Date | null {
  if (!s.exceeded || !s.hardStop) return null;
  const over = s.enforced.map((scope) => s.windows[scope]).filter((w) => w.exceeded);
  if (!over.length) return null;
  return new Date(Math.max(...over.map((w) => new Date(w.endsAt).getTime())));
}

/**
 * The gate. Any window over its ceiling refuses, and the message names which one.
 *
 * A soft quota reports the same status and allows the request: an administrator who wants
 * to watch before enforcing gets the warnings without the refusals.
 */
export function check(userId: string, now = new Date()): Verdict {
  const s = status(userId, now);
  if (!s.exceeded || !s.hardStop) return { allow: true, status: s };

  const hit = s.enforced.map((scope) => s.windows[scope]).find((w) => w.exceeded)!;
  const { unit, amount } = amountIn(s.currency);

  return {
    allow: false,
    reason:
      `Quota used up for this ${scopeLabel(hit.scope)} `
      + `(${amount(hit.used)} / ${amount(hit.limit ?? 0)} ${unit}, `
      + `resets in ${formatDuration(new Date(hit.endsAt).getTime() - now.getTime())})`,
    status: s,
  };
}

/**
 * How a quota figure is written down.
 *
 * Both the refusal and the warning mail quote the same pair of numbers, and they used to
 * format them apart: one `String(v)`, the other `v.toLocaleString()` — so the same figure
 * appeared two ways, and on a server with a non-English `LANG` the mail said `900.000` to an
 * English reader. Two spellings of one number in two places is what makes people distrust
 * both.
 */
export function amountIn(currency: string): { unit: string; amount: (v: number) => string } {
  return { unit: currency, amount: (v: number) => (v / MICRO).toFixed(2) };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

import * as usersRepo from './db/users.js';
import * as usageRepo from './db/usage.js';
import { WINDOW_MS, periodEndAt, periodStartAt, weekBoundsAt, windowBoundsAt } from './db/period.js';
import { quotaAnchor } from './db/settings.js';
import { getStringFresh } from './db/settings.js';
import type { LimitKind, QuotaScope, QuotaStatus, QuotaWindow } from './protocol.js';
import { MICRO } from './db/pricing.js';

export type { QuotaStatus, QuotaWindow, LimitKind, QuotaScope } from './protocol.js';

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
 * Where a window's count begins for this user: its boundary, unless a manual reset moved the
 * start forward inside a window already running. The next window still begins at its own
 * boundary.
 *
 * The rule lives here, and not at each caller, because anything that re-derives it drifts
 * from the number the gate enforces — and a report disagreeing with the gate about how much
 * somebody has spent is worse than not showing the figure at all.
 */
export function countStartOf(q: usersRepo.Quota, start: Date): string {
  return q.resetAt && new Date(q.resetAt) > start ? q.resetAt : start.toISOString();
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
  const from = countStartOf(q, start);

  const amountOf = (t: usageRepo.Totals) => (q.limitKind === 'cost' ? t.costMicro : t.billableTokens);
  const to = end.toISOString();
  const used = amountOf(usageRepo.totalsForUser(userId, { from, to }));
  /*
   * What was actually spent over the whole window, reset or no reset.
   *
   * `used` is what the gate counts; this is what the usage report counts. They are the same
   * number until an administrator clears somebody part-way through, and then they are not —
   * and a page showing both with no way to reconcile them is a page nobody trusts. The
   * second query only happens when they can differ.
   */
  const spent = from === start.toISOString()
    ? used
    : amountOf(usageRepo.totalsForUser(userId, { from: start.toISOString(), to }));

  // Reported separately so the interface can mark a top-up, but the ceiling itself comes
  // from the one function that owns that rule
  const boost = boostOf(q, scope, now);
  const limit = effectiveCeiling(q, scope, now);

  return {
    scope,
    limit,
    boost,
    used,
    spent,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    ratio: limit === null || limit <= 0 ? 0 : Math.min(used / limit, 1),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
    countsFrom: from,
    exceeded: limit !== null && used >= limit,
  };
}

export function status(userId: string, now = new Date()): QuotaStatus {
  const q = usersRepo.getQuota(userId);
  const windows = Object.fromEntries(
    SCOPES.map((scope) => [scope, windowStatus(userId, q, scope, now)]),
  ) as Record<QuotaScope, QuotaWindow>;

  const limited = SCOPES.map((s) => windows[s]).filter((w) => w.limit !== null);
  // The one that will refuse first: whichever limited window is furthest along
  const tightest = limited.length
    ? limited.reduce((a, b) => (b.ratio > a.ratio ? b : a)).scope
    : null;

  return {
    limitKind: q.limitKind,
    currency: q.currency,
    hardStop: q.hardStop,
    windows,
    exceeded: limited.some((w) => w.exceeded),
    warning: limited.some((w) => w.ratio >= 0.9),
    tightest,
  };
}

export interface Verdict {
  allow: boolean;
  reason?: string;
  status: QuotaStatus;
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

  const hit = SCOPES.map((scope) => s.windows[scope]).find((w) => w.exceeded)!;
  const { unit, amount } = amountIn(s.limitKind, s.currency);

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
 * How a quota figure is written down, in the unit its ceiling is counted in.
 *
 * Both the refusal and the warning mail quote the same pair of numbers, and they used to
 * format them apart: one `String(v)`, the other `v.toLocaleString()` — so the same 900,000
 * appeared as `900000` in the refusal and `900,000` in the mail, and on a server with a
 * non-English `LANG` the mail said `900.000` to an English reader. Neither is worth arguing
 * about on its own; two spellings of one number in two places is what makes people distrust
 * both. `en-US` is pinned because these strings are not translated.
 */
export function amountIn(
  limitKind: LimitKind,
  currency: string,
): { unit: string; amount: (v: number) => string } {
  const byCost = limitKind === 'cost';
  return {
    unit: byCost ? currency : 'tokens',
    amount: (v: number) =>
      byCost ? (v / MICRO).toFixed(2) : v.toLocaleString('en-US'),
  };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

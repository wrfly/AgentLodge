import * as usersRepo from './db/users.js';
import * as usageRepo from './db/usage.js';
import { WINDOW_MS, periodEndAt, periodStartAt, windowBoundsAt } from './db/period.js';
import { quotaAnchor } from './db/settings.js';
import { getStringFresh } from './db/settings.js';
import type { QuotaScope, QuotaStatus, QuotaWindow } from './protocol.js';

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

/** Where each window begins and ends. The 5-hour one follows the upstream; see period.ts. */
export function boundsOf(scope: QuotaScope, now = new Date()): { start: Date; end: Date } {
  if (scope === 'window') {
    return windowBoundsAt(now, getStringFresh('quota.windowResetAt'), quotaAnchor());
  }
  const period = scope === 'week' ? 'weekly' : 'monthly';
  const anchor = quotaAnchor();
  const start = periodStartAt(period, now, anchor);
  // Both have an end; the fallback is only there because the signature allows null for
  // 'total', which is not a scope any more
  const end = periodEndAt(period, now, anchor) ?? new Date(start.getTime() + WINDOW_MS);
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

function windowStatus(
  userId: string,
  q: usersRepo.Quota,
  scope: QuotaScope,
  now: Date,
): QuotaWindow {
  const { start, end } = boundsOf(scope, now);
  // A manual reset moves the counting start forward inside a window already running; the
  // next window still begins at its own boundary
  const from =
    q.resetAt && new Date(q.resetAt) > start ? q.resetAt : start.toISOString();

  const totals = usageRepo.totalsForUser(userId, { from, to: end.toISOString() });
  const used = q.limitKind === 'cost' ? totals.costMicro : totals.billableTokens;

  const ceiling = ceilingOf(q, scope);
  const boost = boostOf(q, scope, now);
  const limit = ceiling === null ? null : ceiling + boost;

  return {
    scope,
    limit,
    boost,
    used,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    ratio: limit === null || limit <= 0 ? 0 : Math.min(used / limit, 1),
    startsAt: start.toISOString(),
    endsAt: end.toISOString(),
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
  const unit = s.limitKind === 'cost' ? s.currency : 'tokens';
  const amount = (v: number): string =>
    s.limitKind === 'cost' ? (v / 1_000_000).toFixed(2) : String(v);

  return {
    allow: false,
    reason:
      `Quota used up for this ${scopeLabel(hit.scope)} `
      + `(${amount(hit.used)} / ${amount(hit.limit ?? 0)} ${unit}, `
      + `resets in ${formatDuration(new Date(hit.endsAt).getTime() - now.getTime())})`,
    status: s,
  };
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

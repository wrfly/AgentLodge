import * as usageRepo from '../core/db/usage.js';
import type { QuotaScope, QuotaStatus } from '../core/protocol.js';
import type { ClaimStatus, PoolShare } from './quota-report.js';
import * as allowance from './upstream-allowance.js';

/**
 * What a user with no ceiling of their own should be told.
 *
 * "Unlimited" is a local statement. Nobody configured a limit for them here, but they still
 * sit inside one shared subscription, and when that empties they are refused like everybody
 * else — today with no warning at all, because a window with no ceiling emits no headers and
 * a client with no headers raises no rate_limit_event. The bound exists; it just is not
 * written down in their row.
 *
 * **The pool's own utilisation cannot be the answer.** It describes every tenant's
 * consumption together, so relaying it hands one user a reading of the whole platform's
 * business. What goes out instead is their share of it:
 *
 *     personal = (this user's usage ÷ everybody's usage) × the pool's utilisation
 *
 * both usages taken over the same window and the same upstream. The left factor is a
 * dimensionless share, so the unit cancels: our billable-token weights
 * (`quota.weightOutput` and friends) do not have to match whatever weighting the upstream
 * bills by. Only the *relative* standing of two users would shift if the weights disagreed,
 * and both figures are re-read on every response, so nothing accumulates.
 *
 * It behaves the way the arithmetic says it should. A user who is the only one on the
 * platform gets exactly the pool's utilisation, because their share is 1. Nobody can ever
 * exceed it, because a share cannot exceed 1. And a reader knows only their own numerator,
 * so neither the denominator nor the pool's utilisation can be recovered from what they are
 * shown — which is why this needs no administrator gate and goes to every such user.
 *
 * The pool's *status* is passed through unchanged rather than derived; see the note on
 * `unifiedHeaders` for why those two fields deliberately answer different questions.
 */

/** Which window of the upstream's each of ours is the same interval as */
const POOL_WINDOW: Record<Exclude<QuotaScope, 'month'>, string> = {
  window: '5h',
  week: '7d',
};

/**
 * An absent or unrecognised status reads as `allowed`.
 *
 * Not merely defensive: `record()` rebuilds a window from whatever fields the response
 * carried, so one response mentioning `5h-utilization` and not `5h-status` leaves the status
 * null. Dropping the window over that would blank the very status line this exists to fill,
 * and the number is the payload — the status is advisory, and the pool's own gate still
 * refuses the request either way.
 */
const claimStatus = (s: string | null): ClaimStatus =>
  s === 'allowed_warning' || s === 'rejected' ? s : 'allowed';

/**
 * @param provider the upstream this request is going to. Both fields are needed and they are
 * different things: the reading is filed under the provider's `name`, the usage rows under
 * its `id`.
 */
export function poolShare(
  q: QuotaStatus,
  provider: { id: string; name: string },
): Partial<Record<QuotaScope, PoolShare>> {
  const snap = allowance.snapshot();
  /*
   * One global slot, not one per upstream: whichever provider answered last is what is in
   * it. A deployment with two of them would otherwise hand a user of the second one the
   * first one's allowance. No match means we have nothing to say about this upstream, which
   * also disposes of the mock and local-agent paths — they have no pool at all.
   */
  if (!snap || snap.provider !== provider.name) return {};

  const out: Partial<Record<QuotaScope, PoolShare>> = {};

  for (const scope of ['window', 'week'] as const) {
    const w = q.windows[scope];
    // A ceiling of ours is exact and already enforced; nothing to derive
    if (w.limit !== null) continue;

    const pool = snap.windows[POOL_WINDOW[scope]];
    if (!pool || pool.utilization === null) continue;

    /*
     * The window is the one quota.status already cut, which since boundsOf started
     * following the upstream is the upstream's own. That is what makes the two figures
     * comparable at all: a numerator counted over our week and a utilisation reported over
     * theirs would divide by the wrong denominator.
     */
    const all = usageRepo.totalsAllInRange({ from: w.startsAt, to: w.endsAt }, provider.id);
    const total = q.limitKind === 'cost' ? all.costMicro : all.billableTokens;
    /*
     * Nobody has spent anything yet, so neither has this user.
     *
     * The clamp is for the numerator and denominator not being cut identically: an
     * administrator's manual reset moves one user's counting start forward inside a window
     * the total still spans whole. That understates their share, which is the harmless
     * direction — but the clamp is what makes "never more than the pool" true by
     * construction rather than by argument.
     */
    const share = total <= 0 ? 0 : Math.min(w.used / total, 1);

    out[scope] = { utilization: share * pool.utilization, status: claimStatus(pool.status) };
  }

  return out;
}

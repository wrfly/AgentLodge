/**
 * Being over the ceiling is a wait, not a refusal.
 *
 * A question that arrives over quota is written down and sent when the window turns over,
 * instead of coming back as a 402 the person has to sit and re-send. What this is *not* is
 * holding the request: waiting out a 5-hour window inside the HTTP call would park a socket
 * and an idle agent container for hours against a client that gives up in minutes, so the
 * call returns immediately and the intention lives in a row (`core/db/deferred.ts`).
 *
 * It sits on the app side deliberately. The gateway's refusal is the one that cannot be
 * sidestepped and it does not change: a turn already under way can still be stopped
 * mid-flight, and a user's own CLI — which never touches this process — still gets its 402.
 * All that moves is the admission check, from *no* to *not yet*.
 */
import * as convRepo from '../core/db/conversations.js';
import * as deferredRepo from '../core/db/deferred.js';
import * as quota from '../core/quota.js';
import * as turns from './turns.js';
import { WINDOW_MS } from '../core/db/period.js';
import { publish } from '../core/events.js';
import type { DeferredTurn, QuotaScope, QuotaStatus } from '../core/protocol.js';

/**
 * How far ahead a turn will wait.
 *
 * One window length, which is not a tuning knob dressed up as a constant — it is the rule
 * that makes the feature mean one thing. The 5-hour window can never be more than its own
 * length away from resetting, so a turn blocked on that alone is always held; a week or a
 * month is only ever within five hours of turning over at the very end of one, which is
 * exactly when waiting is reasonable and every other time it is not. Nobody wants a
 * question asked automatically nineteen days after they typed it.
 */
export const HORIZON_MS = WINDOW_MS;

/**
 * Rows are re-asked rather than trusted, so this is also how quickly an administrator's
 * top-up reaches the person waiting on it.
 */
export const SWEEP_MS = 20_000;

/**
 * At most this many go per pass.
 *
 * Every turn blocked on the 5-hour window becomes eligible at the same instant, because
 * that is what a platform-wide window means. Letting the whole set go at once would hand
 * the gateway's concurrency gate a queue as long as the deployment has users — it would
 * hold them all correctly, but `queue.waiting` cannot reach the browser once app and
 * gateway are separate processes (DESIGN.md §2.6), so what people would see is a spinner
 * with nothing behind it. Three a pass spreads the same set over a few minutes.
 */
export const RELEASE_PER_SWEEP = 3;

/**
 * A safety valve, not a deadline.
 *
 * Admission already guarantees a hold of at most HORIZON_MS, so nothing reaches this in
 * the ordinary run of things. What can: an administrator lowering a ceiling underneath a
 * turn that is already waiting, which leaves it blocked past the window it was waiting
 * for and, without this, waiting forever. Giving up loses the text if no browser is open
 * to catch the event — acceptable for a case that needs somebody to have moved the
 * goalposts, and the alternative is a table that only grows.
 */
const GIVE_UP_MS = 24 * 60 * 60 * 1000;

/**
 * How long a conversation whose release just failed is left alone.
 *
 * Without it a permanently broken one is retried every SWEEP_MS until GIVE_UP_MS — four
 * thousand container starts and four thousand identical log lines over a day. The realistic
 * causes are not rare either: an administrator turning off the agent a held conversation
 * uses, or the container engine being down, which fails *every* held row at once.
 */
const RETRY_AFTER_FAIL_MS = 2 * 60_000;

/** conversationId → the instant before which trying again is pointless. In memory: a restart is a fresh start, and the rows outlive it. */
const failedAt = new Map<string, number>();

/**
 * Which window the wait is for.
 *
 * The one whose reset is `clears`, found by matching the instant — **not** `tightest`,
 * which is the window furthest along as a fraction and says nothing about when it turns
 * over. Naming that one puts a label on the banner that disagrees with the time beside it,
 * and it is the same confusion `clearsAt` exists to avoid. Both the admission and the
 * reschedule go through here so they cannot drift apart.
 */
function scopeClearingAt(status: QuotaStatus, clears: Date): QuotaScope {
  const at = clears.toISOString();
  return (
    (['window', 'week', 'month'] as const).find(
      (s) => status.windows[s].exceeded && status.windows[s].endsAt === at,
    ) ?? status.tightest ?? 'window'
  );
}

/**
 * Hold this question, or say it cannot be held.
 *
 * Returns the row when the wait is inside the horizon, and null when the caller should
 * refuse as it always did — `status` is the verdict's, already computed, so this costs no
 * further queries.
 */
export function tryDefer(input: {
  conversationId: string;
  userId: string;
  body: string;
  status: QuotaStatus;
  now?: Date;
}): DeferredTurn | null {
  const now = input.now ?? new Date();

  /*
   * Threads are refused, not held.
   *
   * A sub-conversation posts to the same route as its parent, so it would be held by the
   * same code — but the panel it lives in has no line above its composer to say so and no
   * way to take it back, and the parent's banner is a different conversation's. A hold
   * nobody can see or cancel is worse than the refusal it replaced. A thread is also a
   * short question about a passage on screen; waiting five hours is not what it is for.
   */
  const conv = convRepo.meta(input.conversationId, input.userId);
  if (!conv || conv.parentId) return null;

  const clears = quota.clearsAt(input.status);
  if (!clears) return null;
  if (clears.getTime() - now.getTime() > HORIZON_MS) return null;

  // Which window to name. The one whose reset is being waited for, which is the one
  // clearsAt picked — not `tightest`, which is the furthest along and may already have
  // turned over by then.
  const scope = scopeClearingAt(input.status, clears);

  // A new question is a fresh start: whatever made the last release attempt on this
  // conversation throw has nothing to say about this one, and leaving the mark would hold
  // it back for up to RETRY_AFTER_FAIL_MS for no reason.
  failedAt.delete(input.conversationId);
  const held = deferredRepo.add({
    userId: input.userId,
    conversationId: input.conversationId,
    body: input.body,
    scope,
    releaseAt: clears.toISOString(),
  });
  publish(input.conversationId, { type: 'turn.deferred', deferred: held });
  return held;
}

/** Cancel, and hand back what it was holding so the composer can have the text again */
export function cancel(conversationId: string, userId: string): DeferredTurn | undefined {
  const gone = deferredRepo.removeForConversation(conversationId, userId);
  failedAt.delete(conversationId);
  if (gone) publish(conversationId, { type: 'turn.deferred', deferred: null });
  return gone;
}

export function forConversation(conversationId: string, userId: string): DeferredTurn | undefined {
  return deferredRepo.forConversation(conversationId, userId);
}

/**
 * One pass: let go of what can go, push the rest forward.
 *
 * The release test is `quota.check` asked afresh, not `release_at` — the stored instant is
 * what the interface shows, and trusting it would mean a top-up granted at three o'clock
 * does nothing until the window it was granted to work around has ended anyway.
 */
export async function sweep(now = new Date()): Promise<number> {
  let released = 0;
  for (const held of deferredRepo.pending()) {
    if (released >= RELEASE_PER_SWEEP) break;

    // The conversation may have been deleted; the foreign key takes the row with it, so
    // this is the user having renamed or moved it out from under the hold.
    const conv = convRepo.meta(held.conversationId, held.userId);
    if (!conv) {
      deferredRepo.remove(held.id);
      failedAt.delete(held.conversationId);
      continue;
    }
    // Its last release attempt threw and the cause is unlikely to have changed yet
    if ((failedAt.get(held.conversationId) ?? 0) > now.getTime()) continue;
    // Something is already generating in this thread — a held turn from another
    // conversation in the same family, or the person came back and asked directly. Next pass.
    if (turns.isBusy(held.conversationId)) continue;

    const verdict = quota.check(held.userId, now);
    if (!verdict.allow) {
      if (now.getTime() - new Date(held.createdAt).getTime() > GIVE_UP_MS) {
        deferredRepo.remove(held.id);
        failedAt.delete(held.conversationId);
        publish(held.conversationId, { type: 'turn.deferred', deferred: null });
        continue;
      }
      // Still blocked, and the window it was waiting for may have turned over while
      // another has not. Say so rather than showing an instant that has passed.
      const clears = quota.clearsAt(verdict.status);
      if (clears && clears.toISOString() !== held.releaseAt) {
        const scope = scopeClearingAt(verdict.status, clears);
        deferredRepo.reschedule(held.id, clears.toISOString(), scope);
        // `held` carries the user id, which the published shape does not; naming the
        // fields keeps what goes to the browser the same as what the type promises
        publish(held.conversationId, {
          type: 'turn.deferred',
          deferred: {
            id: held.id,
            conversationId: held.conversationId,
            body: held.body,
            createdAt: held.createdAt,
            releaseAt: clears.toISOString(),
            scope,
          },
        });
      }
      continue;
    }

    /*
     * Remove first, start second.
     *
     * `startTurn` is awaited — it pulls up a container — and a pass that ran while it was
     * still going would find the same row and start the same question twice. `isBusy` only
     * answers once the turn exists. Deleting up front makes the row the claim: the cost of
     * crashing between the two is one lost question, against a double-charged turn.
     */
    deferredRepo.remove(held.id);
    try {
      const { turnId, userMessage } = await turns.startTurn(
        held.conversationId,
        held.userId,
        held.body,
      );
      publish(held.conversationId, { type: 'turn.deferred', deferred: null });
      publish(held.conversationId, { type: 'turn.released', turnId, userMessage });
      failedAt.delete(held.conversationId);
      released += 1;
    } catch (err) {
      // Put it back. Whatever refused it — the container engine, a quota that moved
      // between the check and the start — is a reason to wait, not to discard what was
      // typed. A permanently broken one leaves on the GIVE_UP_MS valve above.
      deferredRepo.add({
        userId: held.userId,
        conversationId: held.conversationId,
        body: held.body,
        scope: held.scope,
        releaseAt: held.releaseAt,
      });
      failedAt.set(held.conversationId, now.getTime() + RETRY_AFTER_FAIL_MS);
      console.error(
        `[deferred] ${held.conversationId} could not be released, waiting `
          + `${RETRY_AFTER_FAIL_MS / 60_000}m before trying again: `
          + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return released;
}

/**
 * One pass at a time.
 *
 * A pass awaits `startTurn`, which pulls up a container and can take longer than the
 * interval between passes — so without this the timer starts a second pass over a set the
 * first is still working through. The row is deleted before the await, so the same question
 * cannot be started twice; what overlapping passes *do* defeat is RELEASE_PER_SWEEP, which
 * exists to keep a window's worth of held turns from arriving at the concurrency gate all
 * at once. Two passes make it six, and a slow engine makes it more.
 */
let sweeping = false;

/** Called once at start-up on the app side; the gateway has no part in this */
export function startSweeping(): NodeJS.Timeout {
  return setInterval(() => {
    if (sweeping) return;
    sweeping = true;
    void sweep()
      .catch((err) => console.error('[deferred] sweep failed:', err))
      .finally(() => {
        sweeping = false;
      });
  }, SWEEP_MS).unref();
}

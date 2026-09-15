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
import type { DeferredTurn, QuotaStatus } from '../core/protocol.js';

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
  const scope =
    (['window', 'week', 'month'] as const).find(
      (s) => input.status.windows[s].exceeded && input.status.windows[s].endsAt === clears.toISOString(),
    ) ?? input.status.tightest ?? 'window';

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
      continue;
    }
    // Something is already generating in this thread — a held turn from another
    // conversation in the same family, or the person came back and asked directly. Next pass.
    if (turns.isBusy(held.conversationId)) continue;

    const verdict = quota.check(held.userId, now);
    if (!verdict.allow) {
      if (now.getTime() - new Date(held.createdAt).getTime() > GIVE_UP_MS) {
        deferredRepo.remove(held.id);
        publish(held.conversationId, { type: 'turn.deferred', deferred: null });
        continue;
      }
      // Still blocked, and the window it was waiting for may have turned over while
      // another has not. Say so rather than showing an instant that has passed.
      const clears = quota.clearsAt(verdict.status);
      if (clears && clears.toISOString() !== held.releaseAt) {
        const scope = verdict.status.tightest ?? held.scope;
        deferredRepo.reschedule(held.id, clears.toISOString(), scope);
        publish(held.conversationId, {
          type: 'turn.deferred',
          deferred: { ...held, releaseAt: clears.toISOString(), scope },
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
      console.error(
        `[deferred] ${held.conversationId} could not be released: `
          + (err instanceof Error ? err.message : String(err)),
      );
    }
  }
  return released;
}

/** Called once at start-up on the app side; the gateway has no part in this */
export function startSweeping(): NodeJS.Timeout {
  return setInterval(() => {
    void sweep().catch((err) => console.error('[deferred] sweep failed:', err));
  }, SWEEP_MS).unref();
}

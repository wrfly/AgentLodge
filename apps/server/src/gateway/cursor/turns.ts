import type { AgentEvent, AgentSession } from './session.js';

/**
 * Keeping a turn alive across the request that ended in the middle of it.
 *
 * The mismatch this exists for: Cursor holds a turn open while it waits for a tool result,
 * and the APIs this gateway speaks end the response at the tool call and deliver the result
 * in a **new** request. So the suspended turn is parked here under the tool call id it is
 * waiting on, and the next request that carries that id resumes the same conversation instead
 * of starting another one.
 *
 * Losing one is not fatal — a turn that cannot be found is started again from the transcript,
 * which is what every other upstream here does on every request — but it costs the agent's
 * server-side context and another request against the plan, so they are worth keeping.
 *
 * ## Why this is bounded
 *
 * A parked turn is an open HTTP stream to Cursor that outlives the request that made it, so
 * it is outside the gate's concurrency accounting. Two bounds, both deliberate:
 *
 *   TTL    a client that takes a tool call and never comes back — it crashed, the user hit
 *          ctrl-c — would otherwise hold its stream until the process restarts
 *   count  a cap over all providers, oldest evicted first, so no amount of abandoned turns
 *          can grow this without limit
 */

/** How long a client has to come back with a tool result before its turn is dropped */
const TTL_MS = 10 * 60_000;

/** At most this many turns parked at once, across every provider */
const MAX_PARKED = 64;

export interface ParkedTurn {
  session: AgentSession;
  events: AsyncGenerator<AgentEvent>;
  /** The tool call the client is answering when it comes back */
  callId: string;
  /** Which model this turn is for, so a resumed one still names it in the stream */
  model: string;
  /**
   * Which lane this turn's conversation belongs to, when it has one.
   *
   * Carried because the request that resumes this turn cannot work it out: the lane is keyed by
   * the resolved model (see conversation.ts), and a resumed request never resolves one — it
   * picks up a turn that was already running. Absent where the turn had no lane to begin with.
   */
  lane?: string;
  parkedAt: number;
  /**
   * The session's own lifetime, which is not the request's.
   *
   * A turn outlives the response that handed over its tool call, so it cannot be tied to that
   * request's signal — the reply closing would abort the very turn being parked. Aborting this
   * is how an expired or evicted turn lets go of its stream, and how the request that resumes
   * it can still be cancelled by its own client going away.
   */
  controller: AbortController;
}

const parked = new Map<string, ParkedTurn>();

/** Park a suspended turn under the call id its answer will arrive with */
export function park(turn: Omit<ParkedTurn, 'parkedAt'>): void {
  expire();
  while (parked.size >= MAX_PARKED) {
    // Insertion order is age order, so the first key is the oldest
    const oldest = parked.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
  parked.set(turn.callId, { ...turn, parkedAt: Date.now() });
}

/**
 * The turn waiting for one of these tool results, if it is still here.
 *
 * Several ids because a client can answer more than one call in a request; the first that
 * matches a parked turn is the one being resumed.
 */
export function resume(callIds: string[]): ParkedTurn | undefined {
  expire();
  for (const id of callIds) {
    const turn = parked.get(id);
    if (turn) {
      parked.delete(id);
      return turn;
    }
  }
  return undefined;
}

/** Give up on a turn and let go of its stream */
function drop(callId: string): void {
  const turn = parked.get(callId);
  if (!turn) return;
  parked.delete(callId);
  turn.controller.abort();
  void turn.events.return(undefined).catch(() => {});
  void turn.session.close().catch(() => {});
}

function expire(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [callId, turn] of parked) {
    if (turn.parkedAt < cutoff) drop(callId);
  }
}

/** How many turns are parked, for a test and for anything that wants to watch this grow */
export const parkedCount = (): number => parked.size;

/** For tests, which must not inherit another test's parked turns */
export function clear(): void {
  for (const callId of [...parked.keys()]) drop(callId);
}

/** Turns held until the quota window turns over. The decision to hold one is app/deferred.ts. */
import { all, get, nowIso, run } from './index.js';
import type { DeferredTurn, QuotaScope } from '../protocol.js';

interface Row {
  id: string;
  user_id: string;
  conversation_id: string;
  body: string;
  scope: string;
  release_at: string;
  created_at: string;
}

function toDeferred(r: Row): DeferredTurn {
  return {
    id: r.id,
    conversationId: r.conversation_id,
    body: r.body,
    scope: r.scope as QuotaScope,
    releaseAt: r.release_at,
    createdAt: r.created_at,
  };
}

/** The row with the user on it, which the public shape leaves off — the sweeper needs it */
export interface Held extends DeferredTurn {
  userId: string;
}

function toHeld(r: Row): Held {
  return { ...toDeferred(r), userId: r.user_id };
}

/**
 * Hold a question.
 *
 * Replaces this conversation's existing held turn rather than refusing: the caller has
 * already been through `turns.isBusy`, so getting here twice means the first one is still
 * waiting and the person has changed their mind about what to ask. Keeping the older text
 * would send the question they replaced.
 */
export function add(input: {
  userId: string;
  conversationId: string;
  body: string;
  scope: QuotaScope;
  releaseAt: string;
}): DeferredTurn {
  const row: Row = {
    id: crypto.randomUUID(),
    user_id: input.userId,
    conversation_id: input.conversationId,
    body: input.body,
    scope: input.scope,
    release_at: input.releaseAt,
    created_at: nowIso(),
  };
  run(
    `insert into deferred_turns (id, user_id, conversation_id, body, scope, release_at, created_at)
     values (?, ?, ?, ?, ?, ?, ?)
     on conflict (conversation_id) do update set
       id = excluded.id,
       body = excluded.body,
       scope = excluded.scope,
       release_at = excluded.release_at,
       created_at = excluded.created_at`,
    row.id,
    row.user_id,
    row.conversation_id,
    row.body,
    row.scope,
    row.release_at,
    row.created_at,
  );
  return toDeferred(row);
}

/** What this conversation is holding, if anything. Scoped by user: the id comes from a URL. */
export function forConversation(conversationId: string, userId: string): DeferredTurn | undefined {
  const r = get<Row>(
    'select * from deferred_turns where conversation_id = ? and user_id = ?',
    conversationId,
    userId,
  );
  return r && toDeferred(r);
}

/** Everything held, oldest release first — the order the sweeper should try them in */
export function pending(limit = 200): Held[] {
  return all<Row>('select * from deferred_turns order by release_at, created_at limit ?', limit).map(
    toHeld,
  );
}

export function countForUser(userId: string): number {
  return (
    get<{ n: number }>('select count(*) as n from deferred_turns where user_id = ?', userId)?.n ?? 0
  );
}

/** Drop one. Returns what it was holding, so a cancel can hand the text back to the composer. */
export function remove(id: string, userId?: string): DeferredTurn | undefined {
  const r = userId
    ? get<Row>('select * from deferred_turns where id = ? and user_id = ?', id, userId)
    : get<Row>('select * from deferred_turns where id = ?', id);
  if (!r) return undefined;
  run('delete from deferred_turns where id = ?', id);
  return toDeferred(r);
}

/** Cancel whatever this conversation is holding */
export function removeForConversation(
  conversationId: string,
  userId: string,
): DeferredTurn | undefined {
  const held = forConversation(conversationId, userId);
  return held && remove(held.id, userId);
}

/** Push a still-blocked turn's advertised release forward, after the sweeper re-asked */
export function reschedule(id: string, releaseAt: string, scope: QuotaScope): void {
  run('update deferred_turns set release_at = ?, scope = ? where id = ?', releaseAt, scope, id);
}

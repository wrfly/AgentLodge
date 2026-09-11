import { all, nowIso, run } from './index.js';

interface TrimRow {
  conversation_id: string;
  match_text: string;
  created_at: string;
}

/**
 * Record that an answer's text no longer belongs to the conversation.
 *
 * Called by the edit and retry routes just before the answer is deleted from our records.
 * The CLI's own transcript — an opaque file we cannot touch — keeps sending that answer on
 * every later request, so the gateway matches this text in the request body and drops the
 * message. See gateway/redo-trim.ts for the other half.
 */
export function add(conversationId: string, matchText: string): boolean {
  const t = matchText.trim();
  if (!t) return false;
  return (
    run(
      'insert into message_trims (conversation_id, match_text, created_at) values (?, ?, ?)',
      conversationId,
      t,
      nowIso(),
    ).changes > 0
  );
}

/**
 * Take rules back, for an answer that turned out not to be discarded after all.
 *
 * The routes record the rules before starting the replacement turn, because the CLI is
 * spawned inside `startTurn` and its first request can reach the gateway before the call
 * returns — a rule written afterwards would be too late for the turn it exists for.
 *
 * So a turn that never starts — out of quota, container engine down — has already written
 * them, and restoring the messages is not enough: the answer would be back on screen and in
 * the database while every later request had it cut out of the body. The user would be
 * looking at a conversation the model cannot see, with nothing to undo it.
 */
export function forget(conversationId: string, matchTexts: string[]): number {
  let gone = 0;
  for (const text of matchTexts) {
    const t = text.trim();
    if (!t) continue;
    gone += run(
      'delete from message_trims where conversation_id = ? and match_text = ?',
      conversationId,
      t,
    ).changes;
  }
  return gone;
}

/** The discarded answers for one conversation, newest first — the order they were discarded in */
export function forConversation(conversationId: string): string[] {
  return all<TrimRow>(
    'select match_text from message_trims where conversation_id = ? order by created_at desc',
    conversationId,
  ).map((r) => r.match_text);
}

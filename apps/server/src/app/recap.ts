import crypto from 'node:crypto';
import { all, get, nowIso, run } from '../core/db/index.js';
import * as convRepo from '../core/db/conversations.js';
import * as profileRepo from '../core/db/profile.js';
import type { StoredMessage } from '../core/protocol.js';
import { config } from '../core/config.js';
import { getStringFresh } from '../core/db/settings.js';
import { signRuntimeToken } from '../core/runtime-token.js';
import { gatewayEnabled, gatewayInternalUrl } from './agents/provider.js';

/**
 * Reading somebody's conversations back to them.
 *
 * Two steps, and the split is the point:
 *
 *   1. Each conversation is summarised once, into a few lines, and kept.
 *   2. The portrait is written from those summaries — never from the messages.
 *
 * Step 1 is linear in conversations and paid for once each; step 2 then reads a few hundred
 * lines instead of a year of transcripts, so it stays one cheap call however long somebody
 * has been here. A summary is also worth having on its own: it is what you want when you
 * come back to a conversation from three weeks ago.
 *
 * Both steps go through the gateway on a ticket for the user, so they are metered, counted
 * against their quota, refused when they are out, and recorded by the audit proxy.
 *
 * Nothing runs on a timer. A conversation is named once, on its first completed turn, from
 * the first few questions in it; summaries are written when somebody opens their portrait
 * and not before. A background pass over everybody's conversations spends tokens on pages
 * nobody asked for.
 *
 * Nothing here writes memory. The portrait is a page to read; the lines it suggests are
 * offered, and become memory only when the user takes one.
 */

/** Per conversation, and per portrait: enough to be faithful, bounded enough to stay cheap */
const CHARS_PER_CONVERSATION = 8_000;
const SUMMARIES_IN_PORTRAIT = 200;
/** How many conversations one request will summarise before handing control back */
export const BATCH = 12;

const SUMMARY_PROMPT = `Below is one conversation between a person and an AI assistant.

Answer with a title on the first line, a blank line, then a summary.

The title names what the conversation turned out to be about — the subject, not how it
opened. At most 24 characters. No quotes, no full stop, no "conversation about".

The summary is two or three sentences: what they were trying to do, what was decided, and
anything left unfinished. Write it so that someone returning in a month knows whether this
is the conversation they were looking for.

Write both in the language the person writes in, and answer with nothing else.`;

/**
 * Naming a conversation is its own small call, not a side effect of summarising: it happens
 * once, early, and reads a few questions rather than a transcript.
 */
const TITLE_PROMPT = `Below are the first questions someone asked in one conversation.

Answer with a name for that conversation and nothing else: what they are trying to do, at
most 24 characters, in the language they write in. No quotes, no full stop, and not
"conversation about".`;

/** How many of the opening questions are enough to name it */
const QUESTIONS = 5;
/** Per question, so one pasted file cannot become the whole prompt */
const CHARS_PER_QUESTION = 600;

/** Titles are cut to the same length as the one derived from an opening message */
const TITLE_MAX = 28;

/**
 * Split the answer into the title and the summary.
 *
 * A title is only taken when the first line looks like one — short, and with something
 * after it. Anything else is treated as all summary and the conversation keeps the name it
 * has: a wrong title is in front of the user forever, a missing one costs nothing.
 */
export function parseRecap(answer: string): { title?: string; summary: string } {
  const lines = answer.trim().split('\n');
  const rest = lines.slice(1).join('\n').trim();
  const title = cleanTitle(lines[0] ?? '');

  if (!rest || !title) return { title: undefined, summary: answer.trim() };
  return { title, summary: rest };
}

/**
 * A model's answer as a title, or nothing.
 *
 * Models decorate: a heading marker, quotes around it, a full stop at the end. What they
 * cannot be talked out of is answering with a sentence, and a sentence is not a title —
 * anything twice the length of a title is treated as one and dropped.
 */
export function cleanTitle(line: string): string | undefined {
  const title = line
    .trim()
    .replace(/^#+\s*/, '')
    // The stop can be inside the quotes or outside them, so both orders are tried
    .replace(/[.。!！]+$/, '')
    .replace(/^["'“”「『]+|["'“”」』]+$/g, '')
    .replace(/[.。!！]+$/, '')
    .trim();
  if (!title || title.length > TITLE_MAX * 2) return undefined;
  return title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title;
}

const PORTRAIT_PROMPT = `Below are summaries of the conversations one person has had with an
AI assistant, and some counts from their usage.

Write a short portrait of how this person works: what they build, the tools and languages
they use, how they want to be answered, what they keep coming back to. Three to five
sentences, addressed to them as "you". Say only what the summaries support — no flattery,
no advice, no guessing at things that are not there.

Then a line containing only ---

Then, one per line, the things worth remembering about them for the long run: durable
preferences and facts, not what any one conversation was about. Between three and eight of
them, each a single short line. If there is nothing worth keeping, write nothing after the
line.

Write in the language the person writes in.`;

/* ---------------- Step 1: one conversation at a time ---------------- */

interface Pending {
  id: string;
  messages: number;
}

/** Conversations with no summary, or one written before the conversation moved on */
export function pending(userId: string): Pending[] {
  return all<Pending>(
    `select c.id as id, count(m.id) as messages
       from conversations c join messages m on m.conversation_id = c.id
      where c.user_id = ?
      group by c.id
     having count(m.id) > 1
        and (c.summary is null or c.summary_upto is null or c.summary_upto < count(m.id))
      order by c.last_message_at desc`,
    userId,
  );
}

/** A conversation as plain text, speaker by speaker, oldest first */
export function transcript(conversationId: string, userId: string): string {
  const conv = convRepo.full(conversationId, userId);
  if (!conv) return '';

  const lines: string[] = [];
  let budget = CHARS_PER_CONVERSATION;
  for (const m of conv.messages) {
    const text = textOf(m);
    if (!text) continue;
    const line = `${m.role === 'user' ? 'Them' : 'Assistant'}: ${text.slice(0, 1_500)}`;
    budget -= line.length;
    if (budget <= 0) break;
    lines.push(line);
  }
  return lines.join('\n\n');
}

/** The opening questions, oldest first — what the conversation set out to be */
export function questions(conversationId: string, userId: string): string {
  const conv = convRepo.full(conversationId, userId);
  if (!conv) return '';

  return conv.messages
    .filter((m) => m.role === 'user')
    .slice(0, QUESTIONS)
    .map((m) => textOf(m).slice(0, CHARS_PER_QUESTION))
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Whether the upstream's 5-hour window is about to roll over.
 *
 * On a subscription the window is a session, and the request that arrives after one ends
 * opens the next. A title is not worth opening a session for: the user opens theirs by
 * saying something, and this runs on the turn after that. Empty on a key-billed upstream —
 * nothing reports a window — so this is false and nothing waits.
 */
const WINDOW_TAIL_MS = 60_000;

export function windowAboutToRoll(): boolean {
  const reset = getStringFresh('quota.windowResetAt');
  if (!reset) return false;
  const left = new Date(reset).getTime() - Date.now();
  return left > 0 && left <= WINDOW_TAIL_MS;
}

/**
 * Name the conversation, if nothing has named it yet.
 *
 * Called when a turn finishes and cheap enough to be: a couple of hundred tokens in, a
 * dozen out. `retitle` is what makes it once — a second call finds the name already there
 * and changes nothing, so this can be fired without checking first. A conversation left
 * unnamed at the end of a window is named on its next turn, which is the user's own.
 */
export async function nameIfNeeded(userId: string, conversationId: string): Promise<string | undefined> {
  if (windowAboutToRoll()) return undefined;
  const named = get<{ title_at: string | null; title_custom: number }>(
    'select title_at, title_custom from conversations where id = ? and user_id = ?',
    conversationId,
    userId,
  );
  if (!named || named.title_at || named.title_custom) return undefined;

  // Only "there is nothing to read". A length floor here was 8 characters, which no
  // Chinese question reaches: 「美国总统是谁」is a whole question in six.
  const body = questions(conversationId, userId).trim();
  if (!body) return undefined;

  // A failure to reach the model at all — out of quota, upstream unwell — leaves the
  // guard open on purpose: that is transient, and the next turn is the right time to try
  // again. An answer that arrives and cannot be used is not transient, so it closes the
  // guard: the model that replies with a sentence replies with a sentence every time.
  const answer = await ask(userId, `${TITLE_PROMPT}\n\n---\n\n${body}`, 32);
  const title = cleanTitle(answer.split('\n')[0] ?? '');
  if (!title) {
    convRepo.markNamingTried(conversationId);
    return undefined;
  }
  return convRepo.retitle(conversationId, title) ? title : undefined;
}

function textOf(m: StoredMessage): string {
  return m.blocks
    .filter((b) => b.kind === 'text')
    .map((b) => b.text ?? '')
    .join('\n')
    .trim();
}

async function summarizeOne(userId: string, id: string, messages: number): Promise<boolean> {
  const body = transcript(id, userId);
  if (body.length < 80) return false;

  const { title, summary } = parseRecap(await ask(userId, `${SUMMARY_PROMPT}\n\n---\n\n${body}`, 400));
  if (!summary) return false;

  run(
    'update conversations set summary = ?, summary_at = ?, summary_upto = ? where id = ? and user_id = ?',
    summary.slice(0, 2_000),
    nowIso(),
    messages,
    id,
    userId,
  );
  // Only for a conversation nothing has named yet — `retitle` keeps `title_at is null`,
  // and every conversation since naming moved to the first turn has it set. So this is
  // the backlog case: one that was created before, has not had a turn since, and is being
  // summarised now. It is not a second chance to rename what the first turn named.
  if (title) convRepo.retitle(id, title);
  return true;
}

export interface CatchUpResult {
  summarized: number;
  /** Still waiting. The sweep will get to them; the page says so rather than asking. */
  remaining: number;
}

/**
 * Summarise this user's out-of-date conversations, up to a batch.
 *
 * Bounded because each one is a request. Anything over the batch is left to the sweep,
 * which is why nothing here asks the user to press the button again.
 */
export async function catchUp(userId: string, limit = BATCH): Promise<CatchUpResult> {
  const queue = pending(userId);
  let summarized = 0;
  for (const c of queue.slice(0, limit)) {
    try {
      if (await summarizeOne(userId, c.id, c.messages)) summarized++;
    } catch {
      // Out of quota, or the upstream is unwell. Whatever is left stays on the queue.
      break;
    }
  }
  return { summarized, remaining: Math.max(0, queue.length - limit) };
}

/* ---------------- The sweep ---------------- */

/**
 * A conversation is finished when it has been quiet for a while — not when a turn ends.
 * Somebody who comes back ten minutes later is still in the same conversation, and
 * summarising after every turn would pay for the same conversation over and over.
 */
export interface Recap {
  id: string;
  title: string;
  summary: string;
  at: string;
}

/** The newest summaries, which are also what the portrait was written from */
export function recent(userId: string, limit = 20): Recap[] {
  return all<Recap>(
    `select id, title, summary, last_message_at as at
       from conversations
      where user_id = ? and summary is not null and summary != ''
      order by last_message_at desc limit ?`,
    userId,
    limit,
  );
}

/* ---------------- Step 2: the portrait ---------------- */

export interface Portrait {
  text: string;
  candidates: string[];
  conversations: number;
  createdAt: string;
}

interface PortraitRow {
  text: string;
  candidates: string | null;
  conversations: number;
  created_at: string;
}

export function portrait(userId: string): Portrait | undefined {
  const r = get<PortraitRow>('select * from user_portraits where user_id = ?', userId);
  if (!r) return undefined;
  return {
    text: r.text,
    candidates: r.candidates ? (JSON.parse(r.candidates) as string[]) : [],
    conversations: r.conversations,
    createdAt: r.created_at,
  };
}

/** Split the answer at the divider; anything before is prose, anything after is a line each */
export function parsePortrait(answer: string): { text: string; candidates: string[] } {
  const [head = '', ...rest] = answer.split(/^\s*-{3,}\s*$/m);
  return {
    text: head.trim(),
    candidates: rest
      .join('\n')
      .split('\n')
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').trim())
      .filter((l) => l.length > 2 && !l.endsWith(':'))
      .slice(0, 8),
  };
}

export async function writePortrait(userId: string): Promise<Portrait | undefined> {
  const summaries = all<{ title: string; summary: string }>(
    `select title, summary from conversations
      where user_id = ? and summary is not null and summary != ''
      order by last_message_at desc limit ?`,
    userId,
    SUMMARIES_IN_PORTRAIT,
  );
  if (summaries.length === 0) return undefined;

  const p = profileRepo.of(userId);
  const counts = [
    `Conversations: ${p.conversations}, messages: ${p.messages}, days used: ${p.activeDays}.`,
    `Of ${p.turns} assistant turns, ${p.withTools} used tools, ${p.aborted} were interrupted, ${p.failed} failed.`,
    `Their questions run ${p.askLength} characters at the median; ${Math.round(p.cjkShare * 100)}% of what they write is CJK.`,
    `They reach for: ${p.agents.map((a) => `${a.key} (${a.n})`).join(', ')}.`,
  ].join('\n');

  const body = summaries.map((s) => `- ${s.title}: ${s.summary}`).join('\n');
  const answer = await ask(userId, `${PORTRAIT_PROMPT}\n\n--- COUNTS ---\n${counts}\n\n--- CONVERSATIONS ---\n${body}`, 900);
  const { text, candidates } = parsePortrait(answer);
  if (text.length < 20) return undefined;

  run(
    `insert into user_portraits (user_id, text, candidates, conversations, created_at)
     values (?, ?, ?, ?, ?)
     on conflict(user_id) do update set
       text = excluded.text, candidates = excluded.candidates,
       conversations = excluded.conversations, created_at = excluded.created_at`,
    userId,
    text,
    JSON.stringify(candidates),
    summaries.length,
    nowIso(),
  );
  return portrait(userId);
}

/* ---------------- The one call both steps make ---------------- */

interface AnthropicText {
  content?: Array<{ type?: string; text?: string }>;
  error?: { message?: string };
}

async function ask(userId: string, body: string, maxTokens: number): Promise<string> {
  if (!gatewayEnabled()) throw new Error('No upstream provider is enabled');

  const token = await signRuntimeToken(
    { sub: userId, cid: '', tid: `recap-${crypto.randomUUID()}`, agent: 'claude' },
    60_000,
  );

  const res = await fetch(`${gatewayInternalUrl()}/v1/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model || 'claude-haiku-4-5',
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: body }],
    }),
    signal: AbortSignal.timeout(90_000),
  });

  const payload = (await res.json().catch(() => ({}))) as AnthropicText;
  if (!res.ok) throw new Error(payload.error?.message ?? `the gateway returned ${res.status}`);
  return (payload.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

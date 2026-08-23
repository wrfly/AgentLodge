import crypto from 'node:crypto';
import { all, get, nowIso, run } from '../core/db/index.js';
import * as convRepo from '../core/db/conversations.js';
import * as profileRepo from '../core/db/profile.js';
import type { StoredMessage } from '../core/protocol.js';
import { config } from '../core/config.js';
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
  const first = (lines[0] ?? '').trim();
  const rest = lines.slice(1).join('\n').trim();

  const title = first
    .replace(/^#+\s*/, '')
    .replace(/^["'“”「『]|["'“”」』]$/g, '')
    .replace(/[.。!！]+$/, '')
    .trim();

  if (!rest || !title || title.length > TITLE_MAX * 2) return { title: undefined, summary: answer.trim() };
  return {
    title: title.length > TITLE_MAX ? `${title.slice(0, TITLE_MAX)}…` : title,
    summary: rest,
  };
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
  // The name it started with is the first thing that was said; this is what it turned out
  // to be about. Skipped when the user has named it themselves.
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
const IDLE_MS = 15 * 60_000;
export const EVERY_MS = 30 * 60_000;
/** Per sweep, across everybody: a bound on what one tick can spend */
const PER_SWEEP = 24;

interface Stale {
  id: string;
  user_id: string;
  messages: number;
}

/** Quiet conversations whose summary is missing or older than the conversation */
export function stale(before: string): Stale[] {
  return all<Stale>(
    `select c.id as id, c.user_id as user_id, count(m.id) as messages
       from conversations c join messages m on m.conversation_id = c.id
      where c.last_message_at is not null and c.last_message_at < ?
      group by c.id
     having count(m.id) > 1
        and (c.summary is null or c.summary_upto is null or c.summary_upto < count(m.id))
      order by c.last_message_at desc
      limit ?`,
    before,
    PER_SWEEP,
  );
}

export async function sweep(): Promise<number> {
  if (!gatewayEnabled()) return 0;

  const cutoff = new Date(Date.now() - IDLE_MS).toISOString();
  // One user's refusal should not stop the rest of the sweep, so failures are counted per
  // user rather than thrown
  const done = new Set<string>();
  let n = 0;
  for (const c of stale(cutoff)) {
    if (done.has(c.user_id)) continue;
    try {
      if (await summarizeOne(c.user_id, c.id, c.messages)) n++;
    } catch {
      done.add(c.user_id);
    }
  }
  return n;
}

/** Run it now, and every half hour after that */
export function startSweeping(): void {
  const tick = () => {
    void sweep().catch(() => {});
  };
  // A minute in, so a restart does not race the rest of the boot sequence
  setTimeout(tick, 60_000).unref();
  setInterval(tick, EVERY_MS).unref();
}

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

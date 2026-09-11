import crypto from 'node:crypto';
import { all, bool, flag, get, nowIso, parseJson, run, tx } from './index.js';
import type {
  AgentId,
  Conversation,
  ConversationSummary,
  MessageBlock,
  ThreadSummary,
  StoredMessage,
  TurnUsage,
} from '../protocol.js';

interface ConvRow {
  id: string;
  user_id: string;
  agent: string;
  title: string;
  agent_session_id: string | null;
  model: string | null;
  effort: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  last_message_at: string | null;
  thinking: number;
  parent_id: string | null;
}

interface MsgRow {
  id: string;
  conversation_id: string;
  seq: number;
  role: string;
  blocks: string;
  usage: string | null;
  error: string | null;
  aborted: number;
  created_at: string;
}

interface TotalsRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  cost_usd: number | null;
  message_count: number | null;
}

function toMessage(r: MsgRow): StoredMessage {
  return {
    id: r.id,
    role: r.role as 'user' | 'assistant',
    blocks: parseJson<MessageBlock[]>(r.blocks, []),
    createdAt: r.created_at,
    usage: r.usage ? parseJson<TurnUsage | undefined>(r.usage, undefined) : undefined,
    error: r.error ?? undefined,
    aborted: bool(r.aborted) || undefined,
  };
}

function summary(r: ConvRow, messageCount: number): ConversationSummary {
  return {
    id: r.id,
    title: r.title,
    agent: r.agent as AgentId,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount,
    parentId: r.parent_id ?? undefined,
  };
}

/* ---------------- Reads ---------------- */

/**
 * The conversations the sidebar shows: top-level ones only.
 *
 * A sub-conversation is a thread on a selection inside another one. It has its own row so it
 * can have its own messages, but it is reached from the message it was opened on, not from
 * the list — putting it there would make one chat look like several.
 */
export function list(userId: string, agent?: AgentId): ConversationSummary[] {
  const rows = agent
    ? all<ConvRow & { n: number }>(
        `select c.*, (select count(*) from messages m where m.conversation_id = c.id) as n
         from conversations c
         where c.user_id = ? and c.agent = ? and c.status = 'active' and c.parent_id is null
         order by c.updated_at desc`,
        userId,
        agent,
      )
    : all<ConvRow & { n: number }>(
        `select c.*, (select count(*) from messages m where m.conversation_id = c.id) as n
         from conversations c
         where c.user_id = ? and c.status = 'active' and c.parent_id is null
         order by c.updated_at desc`,
        userId,
      );
  return rows.map((r) => summary(r, r.n));
}

/** Access outside your own rows reads as not-found, so existence is not disclosed */
function rowOf(id: string, userId: string): ConvRow | undefined {
  return get<ConvRow>('select * from conversations where id = ? and user_id = ?', id, userId);
}

export function exists(id: string, userId: string): boolean {
  return Boolean(rowOf(id, userId));
}

export function meta(
  id: string,
  userId: string,
): (Omit<Conversation, 'messages' | 'totals' | 'messageCount'> & { messageCount: number }) | undefined {
  const r = rowOf(id, userId);
  if (!r) return undefined;
  const n = get<{ n: number }>('select count(*) as n from messages where conversation_id = ?', id)?.n ?? 0;
  return {
    id: r.id,
    userId: r.user_id,
    agent: r.agent as AgentId,
    title: r.title,
    agentSessionId: r.agent_session_id ?? undefined,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    thinking: bool(r.thinking),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: n,
    parentId: r.parent_id ?? undefined,
  };
}

export function full(id: string, userId: string): Conversation | undefined {
  const r = rowOf(id, userId);
  if (!r) return undefined;
  const messages = all<MsgRow>(
    'select * from messages where conversation_id = ? order by seq',
    id,
  ).map(toMessage);

  const t = get<TotalsRow>(
    `select
       coalesce(sum(input_tokens),0)          as input_tokens,
       coalesce(sum(output_tokens),0)         as output_tokens,
       coalesce(sum(cache_read_tokens),0)     as cache_read_tokens,
       coalesce(sum(cache_creation_tokens),0) as cache_creation_tokens,
       coalesce(sum(cost_usd),0)              as cost_usd
     from usage_records where conversation_id = ?`,
    id,
  );

  return {
    id: r.id,
    userId: r.user_id,
    agent: r.agent as AgentId,
    title: r.title,
    agentSessionId: r.agent_session_id ?? undefined,
    model: r.model ?? undefined,
    effort: r.effort ?? undefined,
    thinking: bool(r.thinking),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: messages.length,
    parentId: r.parent_id ?? undefined,
    messages,
    totals: {
      inputTokens: t?.input_tokens ?? 0,
      outputTokens: t?.output_tokens ?? 0,
      cacheReadTokens: t?.cache_read_tokens ?? 0,
      cacheCreationTokens: t?.cache_creation_tokens ?? 0,
      costUsd: t?.cost_usd ?? 0,
    },
  };
}

/**
 * The first few things the user said, oldest first.
 *
 * Its own query rather than a slice of `full()`. Naming a conversation reads five
 * messages, and `full()` reads all of them — every row, every blocks blob parsed — plus a
 * sum() across usage_records, so a five-hundred-message conversation paid for all of that
 * to build a string out of the first five. The rest of what full() returns is thrown away
 * on the next line.
 */
export function openingQuestions(id: string, userId: string, limit: number): StoredMessage[] {
  return all<MsgRow>(
    `select m.* from messages m
       join conversations c on c.id = m.conversation_id
      where m.conversation_id = ? and c.user_id = ? and m.role = 'user'
      order by m.seq limit ?`,
    id,
    userId,
    limit,
  ).map(toMessage);
}

/* ---------------- Writes ---------------- */

export interface CreateInput {
  userId: string;
  agent: AgentId;
  title?: string;
  model?: string;
  effort?: string;
  /** Undefined means on, which is the column's default */
  thinking?: boolean;
  /** Set when this is a sub-conversation: it shares the parent's workspace and CLI session */
  parentId?: string;
}

export function create(input: CreateInput): Conversation {
  const now = nowIso();
  const id = crypto.randomUUID();
  run(
    `insert into conversations (id, user_id, agent, title, model, effort, thinking, status, created_at, updated_at, parent_id)
     values (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    id,
    input.userId,
    input.agent,
    input.title?.trim() || 'New chat',
    input.model?.trim() || null,
    input.effort?.trim() || null,
    flag(input.thinking ?? true),
    now,
    now,
    input.parentId ?? null,
  );
  return full(id, input.userId)!;
}

export interface Patch {
  title?: string;
  /** Set when the title came from the user, which stops anything else renaming it */
  titleCustom?: boolean;
  model?: string;
  effort?: string;
  thinking?: boolean;
  agentSessionId?: string;
}

export function update(id: string, userId: string, patch: Patch): boolean {
  const fields: string[] = [];
  const params: Array<string | number | null> = [];
  if (patch.title !== undefined) {
    fields.push('title = ?');
    params.push(patch.title);
  }
  if (patch.titleCustom !== undefined) {
    fields.push('title_custom = ?');
    params.push(flag(patch.titleCustom));
  }
  if (patch.model !== undefined) {
    fields.push('model = ?');
    params.push(patch.model || null);
  }
  if (patch.effort !== undefined) {
    fields.push('effort = ?');
    params.push(patch.effort || null);
  }
  if (patch.thinking !== undefined) {
    fields.push('thinking = ?');
    params.push(flag(patch.thinking));
  }
  if (patch.agentSessionId !== undefined) {
    fields.push('agent_session_id = ?');
    params.push(patch.agentSessionId || null);
  }
  if (!fields.length) return false;
  fields.push('updated_at = ?');
  params.push(nowIso());
  return (
    run(
      `update conversations set ${fields.join(', ')} where id = ? and user_id = ?`,
      ...params,
      id,
      userId,
    ).changes > 0
  );
}

export function appendMessage(
  conversationId: string,
  userId: string,
  msg: Omit<StoredMessage, 'id'> & { id?: string },
): StoredMessage | undefined {
  if (!exists(conversationId, userId)) return undefined;
  return tx(() => {
    const seq =
      (get<{ n: number | null }>(
        'select max(seq) as n from messages where conversation_id = ?',
        conversationId,
      )?.n ?? -1) + 1;
    const id = msg.id ?? crypto.randomUUID();
    run(
      `insert into messages (id, conversation_id, seq, role, blocks, usage, error, aborted, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      conversationId,
      seq,
      msg.role,
      JSON.stringify(msg.blocks),
      msg.usage ? JSON.stringify(msg.usage) : null,
      msg.error ?? null,
      flag(Boolean(msg.aborted)),
      msg.createdAt,
    );
    run(
      'update conversations set updated_at = ?, last_message_at = ? where id = ?',
      nowIso(),
      msg.createdAt,
      conversationId,
    );
    return { ...msg, id } as StoredMessage;
  });
}

/** One message, with the position that decides whether editing it forks the conversation */
export function messageAt(
  conversationId: string,
  userId: string,
  messageId: string,
): (StoredMessage & { seq: number }) | undefined {
  if (!exists(conversationId, userId)) return undefined;
  const r = get<MsgRow>(
    'select * from messages where conversation_id = ? and id = ?',
    conversationId,
    messageId,
  );
  return r ? { ...toMessage(r), seq: r.seq } : undefined;
}

/** The newest thing the user said, which is the one an edit re-answers in place */
export function lastUserMessage(
  conversationId: string,
  userId: string,
): (StoredMessage & { seq: number }) | undefined {
  if (!exists(conversationId, userId)) return undefined;
  const r = get<MsgRow>(
    `select * from messages where conversation_id = ? and role = 'user' order by seq desc limit 1`,
    conversationId,
  );
  return r ? { ...toMessage(r), seq: r.seq } : undefined;
}

/**
 * The newest thing the agent said — the answer an in-place edit or a retry is about to
 * discard. Captured before the truncation, because afterwards the CLI is the only place it
 * still exists, and its text is what the gateway matches to drop it from later requests.
 */
export function lastAssistantMessage(
  conversationId: string,
  userId: string,
): (StoredMessage & { seq: number }) | undefined {
  if (!exists(conversationId, userId)) return undefined;
  const r = get<MsgRow>(
    `select * from messages where conversation_id = ? and role = 'assistant' order by seq desc limit 1`,
    conversationId,
  );
  return r ? { ...toMessage(r), seq: r.seq } : undefined;
}

/**
 * Replace a message's text, keeping its place.
 *
 * The fork sends the CLI a prompt with the kept conversation wrapped around the question;
 * what belongs in the record is the question. Storing the wrapper would put a replay of the
 * whole branch into the reader's first bubble.
 */
export function rewriteMessage(
  conversationId: string,
  userId: string,
  messageId: string,
  text: string,
): boolean {
  if (!exists(conversationId, userId)) return false;
  return (
    run(
      'update messages set blocks = ? where conversation_id = ? and id = ?',
      JSON.stringify([{ kind: 'text', blockId: 0, text }]),
      conversationId,
      messageId,
    ).changes > 0
  );
}

/**
 * Everything from this position on, gone — and handed back, so it can be put back.
 *
 * A `delete` is the whole of it: the rows carry the only copy of what somebody typed. The
 * cut has to happen before the turn that replaces it, because `startTurn` appends and the
 * new question has to land where the old one was, and that turn can still fail — a quota
 * that ran out, an engine that is down. Returning the rows is what lets the caller undo it
 * rather than answer 402 over an empty space where the question used to be.
 */
export function truncateFrom(
  conversationId: string,
  userId: string,
  seq: number,
): Array<StoredMessage & { seq: number }> {
  if (!exists(conversationId, userId)) return [];
  return tx(() => {
    const cut = all<MsgRow>(
      'select * from messages where conversation_id = ? and seq >= ? order by seq',
      conversationId,
      seq,
    ).map((r) => ({ ...toMessage(r), seq: r.seq }));
    run('delete from messages where conversation_id = ? and seq >= ?', conversationId, seq);
    return cut;
  });
}

/** Put back what `truncateFrom` cut, at the positions it held */
export function restoreMessages(
  conversationId: string,
  userId: string,
  cut: Array<StoredMessage & { seq: number }>,
): void {
  if (!cut.length || !exists(conversationId, userId)) return;
  tx(() => {
    for (const m of cut) {
      run(
        `insert or ignore into messages
           (id, conversation_id, seq, role, blocks, usage, error, aborted, created_at)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        m.id,
        conversationId,
        m.seq,
        m.role,
        JSON.stringify(m.blocks),
        m.usage ? JSON.stringify(m.usage) : null,
        m.error ?? null,
        flag(Boolean(m.aborted)),
        m.createdAt,
      );
    }
  });
}

/** Everything up to but not including this position, oldest first */
export function messagesBefore(
  conversationId: string,
  userId: string,
  seq: number,
): StoredMessage[] {
  if (!exists(conversationId, userId)) return [];
  return all<MsgRow>(
    'select * from messages where conversation_id = ? and seq < ? order by seq',
    conversationId,
    seq,
  ).map(toMessage);
}

export function messageCount(conversationId: string): number {
  return (
    get<{ n: number }>('select count(*) as n from messages where conversation_id = ?', conversationId)
      ?.n ?? 0
  );
}

export function remove(id: string, userId: string): boolean {
  return run('delete from conversations where id = ? and user_id = ?', id, userId).changes > 0;
}

/* ---------------- Sub-conversations: one workspace and one CLI session per family ---------------- */

/**
 * The root of a conversation's family: itself when it has no parent.
 *
 * A sub-conversation shares the parent's workspace and CLI session, so both have to resolve
 * through the chain. The /sub route only ever creates one level of nesting, but walking
 * instead of assuming keeps a grandchild from silently splitting off a third directory.
 */
export function rootOf(conversationId: string, userId: string): string {
  let id = conversationId;
  const seen = new Set<string>();
  while (!seen.has(id)) {
    seen.add(id);
    const r = get<{ parent_id: string | null }>(
      'select parent_id from conversations where id = ? and user_id = ?',
      id,
      userId,
    );
    if (!r?.parent_id) break;
    id = r.parent_id;
  }
  return id;
}

/**
 * The threads opened inside one conversation, newest first.
 *
 * They are kept out of `list()` so the sidebar stays a list of conversations, which left them
 * reachable only while their panel was open — close it and the thread was still on the
 * server with its answer in it and no way back. This is the way back.
 *
 * The label is the passage the thread was opened on, read back out of its own first message:
 * that message is a markdown quotation followed by a question, so the quoted lines are the
 * passage and nothing else has to be stored to say what a thread is about. Falls back to the
 * whole message for a thread whose opener was not a quotation.
 */
export function listThreads(parentId: string, userId: string): ThreadSummary[] {
  if (!exists(parentId, userId)) return [];
  return all<{ id: string; created_at: string; opener: string | null; n: number }>(
    `select c.id, c.created_at,
            (select m.blocks from messages m
              where m.conversation_id = c.id and m.role = 'user'
              order by m.seq limit 1) as opener,
            (select count(*) from messages m where m.conversation_id = c.id) as n
       from conversations c
      where c.parent_id = ? and c.user_id = ? and c.status = 'active'
      order by c.created_at desc`,
    parentId,
    userId,
  ).map((r) => ({
    id: r.id,
    createdAt: r.created_at,
    messageCount: r.n,
    about: passageOf(textOf(parseJson<MessageBlock[]>(r.opener, []))),
  }));
}

/**
 * The passage a thread was opened on, as one line.
 *
 * Its opening prompt is a markdown quotation followed by a question, so the quoted lines are
 * the passage. Read before the whitespace is flattened — afterwards there are no lines left
 * to tell apart, and the label ends up carrying the boilerplate question every thread shares.
 */
function passageOf(text: string): string {
  const quoted = text
    .split('\n')
    .filter((l) => l.startsWith('>'))
    .map((l) => l.replace(/^>\s?/, ''))
    .join(' ');
  return (quoted || text).replace(/\s+/g, ' ').trim();
}

/** Everything a message says, newlines intact */
function textOf(blocks: MessageBlock[]): string {
  return blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('').trim();
}


/**
 * Every conversation sharing this one's CLI session — the family, itself included.
 *
 * One turn at a time per session: the CLI's transcript is a single stream, and two members
 * writing to it concurrently would corrupt it. The busy checks and the abort path both use
 * this, so a turn in the sub-conversation makes the parent busy and vice versa.
 */
export function familyIds(conversationId: string, userId: string): string[] {
  const root = rootOf(conversationId, userId);
  return all<{ id: string }>(
    `with recursive family as (
       select id from conversations where id = ? and user_id = ?
       union all
       select c.id from conversations c join family f on c.parent_id = f.id
       where c.user_id = ?
     )
     select id from family`,
    root,
    userId,
    userId,
  ).map((r) => r.id);
}

export function idsForUser(userId: string): string[] {
  return all<{ id: string }>('select id from conversations where user_id = ?', userId).map((r) => r.id);
}

/** Derive a title from the first user message */
export function deriveTitle(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (!clean) return 'New chat';
  return clean.length > 28 ? `${clean.slice(0, 28)}…` : clean;
}

/**
 * Record that a model was asked to name this one, without giving it a name.
 *
 * `title_at` is the guard on naming, and the question it has to answer is "has this been
 * tried", not "did it work". Only `retitle` used to set it, so an answer the cleaner
 * rejects — a whole sentence, which its own comment calls the failure models cannot be
 * talked out of — left the guard open and bought another call on the next turn, and the
 * turn after that, billed to the user each time.
 */
export function markNamingTried(id: string): void {
  run(
    'update conversations set title_at = ? where id = ? and title_at is null',
    nowIso(),
    id,
  );
}

/**
 * Name a conversation after what it is about, once.
 *
 * Two things stop it. A title the user typed is theirs — an automatic one is a better
 * guess than the opening message, but it is still a guess. And `title_at`, once set, means
 * a model has already named this conversation: renaming it later costs another call and
 * moves a name the user has learned to recognise in their list.
 */
export function retitle(id: string, title: string): boolean {
  const now = nowIso();
  return (
    run(
      `update conversations set title = ?, title_at = ?, updated_at = ?
        where id = ? and title_custom = 0 and title_at is null`,
      title,
      now,
      now,
      id,
    ).changes > 0
  );
}

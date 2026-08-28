import crypto from 'node:crypto';
import { all, bool, flag, get, nowIso, parseJson, run, tx } from './index.js';
import type {
  AgentId,
  Conversation,
  ConversationSummary,
  MessageBlock,
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
  };
}

/* ---------------- Reads ---------------- */

export function list(userId: string, agent?: AgentId): ConversationSummary[] {
  const rows = agent
    ? all<ConvRow & { n: number }>(
        `select c.*, (select count(*) from messages m where m.conversation_id = c.id) as n
         from conversations c
         where c.user_id = ? and c.agent = ? and c.status = 'active'
         order by c.updated_at desc`,
        userId,
        agent,
      )
    : all<ConvRow & { n: number }>(
        `select c.*, (select count(*) from messages m where m.conversation_id = c.id) as n
         from conversations c
         where c.user_id = ? and c.status = 'active'
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
}

export function create(input: CreateInput): Conversation {
  const now = nowIso();
  const id = crypto.randomUUID();
  run(
    `insert into conversations (id, user_id, agent, title, model, effort, thinking, status, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    id,
    input.userId,
    input.agent,
    input.title?.trim() || 'New chat',
    input.model?.trim() || null,
    input.effort?.trim() || null,
    flag(input.thinking ?? true),
    now,
    now,
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

export function messageCount(conversationId: string): number {
  return (
    get<{ n: number }>('select count(*) as n from messages where conversation_id = ?', conversationId)
      ?.n ?? 0
  );
}

export function remove(id: string, userId: string): boolean {
  return run('delete from conversations where id = ? and user_id = ?', id, userId).changes > 0;
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
 * Name a conversation after what it is about, once.
 *
 * Two things stop it. A title the user typed is theirs — an automatic one is a better
 * guess than the opening message, but it is still a guess. And `title_at`, once set, means
 * a model has already named this conversation: renaming it later costs another call and
 * moves a name the user has learned to recognise in their list.
 */
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

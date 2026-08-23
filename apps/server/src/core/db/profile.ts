import { all, get } from './index.js';
import type { StoredMessage } from '../protocol.js';

/**
 * How one person actually works, computed from what is already recorded.
 *
 * Everything here is counting — no model is asked anything, so it is exact, free, and
 * current the moment the page opens.
 *
 * Times are bucketed by **UTC hour of week** and rotated in the browser. The server's clock
 * is whatever the deployment set it to, and a chart of somebody's evenings that is eight
 * hours out is worse than no chart; the viewer's own offset is the only one that is right.
 */

export interface Share {
  key: string;
  n: number;
}

export interface Profile {
  /** The first message, so the rest has a span to be read against */
  since?: string;
  conversations: number;
  messages: number;
  /** Days with at least one message. UTC days: this counts occasions, not clock time. */
  activeDays: number;

  /** 168 buckets, UTC, Sunday 00:00 first. The browser rotates them into local time. */
  hourOfWeek: number[];

  /** Assistant turns, and what happened to them */
  turns: number;
  withTools: number;
  aborted: number;
  failed: number;
  /** Turns per conversation and seconds per turn, as medians */
  turnsPerConversation: number;
  secondsPerTurn: number;
  secondsPerTurnP90: number;

  /** Characters in a question, and how much of it is written in CJK */
  askLength: number;
  askLengthP90: number;
  cjkShare: number;
  /** How many messages the two above were measured over */
  sampled: number;

  agents: Share[];
  models: Share[];
  efforts: Share[];
  /** Turns billed to an API key — that is, from the user's own CLI rather than the web app */
  viaOwnCli: number;
  billedTurns: number;
}

/** Enough to characterise how somebody writes without reading years of messages */
const SAMPLE = 500;

const median = (xs: number[]): number => (xs.length ? xs[Math.floor(xs.length / 2)]! : 0);
const p90 = (xs: number[]): number => (xs.length ? xs[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]! : 0);

/** Han, kana and Hangul: enough to tell "writes Chinese" from "writes English" */
const CJK = /[぀-ヿ㐀-䶿一-鿿가-힯]/gu;

export function of(userId: string): Profile {
  const scale = get<{ conversations: number; messages: number; since: string | null; days: number }>(
    `select
       count(distinct c.id)                          as conversations,
       count(m.id)                                   as messages,
       min(m.created_at)                             as since,
       count(distinct substr(m.created_at, 1, 10))   as days
     from conversations c left join messages m on m.conversation_id = c.id
     where c.user_id = ?`,
    userId,
  );

  const hourOfWeek = new Array<number>(168).fill(0);
  for (const r of all<{ b: number; n: number }>(
    `select cast(strftime('%w', m.created_at) as integer) * 24
            + cast(strftime('%H', m.created_at) as integer) as b,
            count(*) as n
       from messages m join conversations c on c.id = m.conversation_id
      where c.user_id = ? and m.role = 'user'
      group by b`,
    userId,
  )) {
    if (r.b >= 0 && r.b < 168) hourOfWeek[r.b] = r.n;
  }

  // A tool_use block is the difference between answering a question and going and doing
  // something. Matched in the stored JSON rather than parsed: this is a count, not a read.
  const turns = get<{ n: number; tools: number; aborted: number; failed: number }>(
    `select count(*) as n,
            sum(case when m.blocks like '%"kind":"tool_use"%' then 1 else 0 end) as tools,
            sum(m.aborted) as aborted,
            sum(case when m.error is not null then 1 else 0 end) as failed
       from messages m join conversations c on c.id = m.conversation_id
      where c.user_id = ? and m.role = 'assistant'`,
    userId,
  );

  const perConversation = all<{ n: number }>(
    `select count(*) as n
       from messages m join conversations c on c.id = m.conversation_id
      where c.user_id = ? and m.role = 'user'
      group by c.id
      order by n`,
    userId,
  ).map((r) => r.n);

  const durations = all<{ d: number }>(
    `select duration_ms as d from usage_records
      where user_id = ? and duration_ms is not null order by d`,
    userId,
  ).map((r) => r.d);

  // The most recent messages, because how somebody writes now is what matters
  const lengths: number[] = [];
  let cjk = 0;
  let chars = 0;
  for (const row of all<{ blocks: string }>(
    `select m.blocks from messages m join conversations c on c.id = m.conversation_id
      where c.user_id = ? and m.role = 'user'
      order by m.created_at desc limit ?`,
    userId,
    SAMPLE,
  )) {
    const text = textOf(row.blocks);
    if (!text) continue;
    lengths.push(text.length);
    chars += text.length;
    cjk += text.match(CJK)?.length ?? 0;
  }
  lengths.sort((a, b) => a - b);

  const billed = get<{ cli: number; n: number }>(
    `select sum(case when api_key_id is not null and api_key_id != '' then 1 else 0 end) as cli,
            count(*) as n
       from usage_records where user_id = ?`,
    userId,
  );

  return {
    since: scale?.since ?? undefined,
    conversations: scale?.conversations ?? 0,
    messages: scale?.messages ?? 0,
    activeDays: scale?.days ?? 0,
    hourOfWeek,

    turns: turns?.n ?? 0,
    withTools: turns?.tools ?? 0,
    aborted: turns?.aborted ?? 0,
    failed: turns?.failed ?? 0,
    turnsPerConversation: median(perConversation),
    secondsPerTurn: Math.round(median(durations) / 100) / 10,
    secondsPerTurnP90: Math.round(p90(durations) / 100) / 10,

    askLength: median(lengths),
    askLengthP90: p90(lengths),
    cjkShare: chars ? cjk / chars : 0,
    sampled: lengths.length,

    agents: shares(`select agent as key, count(*) as n from conversations where user_id = ? group by agent`, userId),
    models: shares(
      `select model as key, count(*) as n from usage_records
        where user_id = ? and model is not null and model != '' group by model order by n desc limit 8`,
      userId,
    ),
    efforts: shares(
      `select effort as key, count(*) as n from usage_records
        where user_id = ? and effort is not null and effort != '' group by effort order by n desc`,
      userId,
    ),
    viaOwnCli: billed?.cli ?? 0,
    billedTurns: billed?.n ?? 0,
  };
}

function shares(sql: string, userId: string): Share[] {
  return all<Share>(sql, userId).sort((a, b) => b.n - a.n);
}

/** The plain text of a stored message, ignoring thinking and tool blocks */
function textOf(blocks: string): string {
  try {
    return (JSON.parse(blocks) as StoredMessage['blocks'])
      .filter((b) => b.kind === 'text')
      .map((b) => b.text ?? '')
      .join('\n')
      .trim();
  } catch {
    return '';
  }
}

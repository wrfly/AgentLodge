import { all, get, localDay, nowIso, run } from './index.js';
import { quotaAnchor, quotaWeights } from './settings.js';
import {
  periodEndAt,
  periodStartAt,
  type QuotaPeriod,
  type RollingSpec,
} from './period.js';
import * as pricing from './pricing.js';

export type { QuotaPeriod };
import type { AgentId, TurnUsage } from '../protocol.js';

export interface RecordInput {
  userId: string;
  conversationId?: string;
  turnId?: string;
  agent: AgentId;
  model?: string;
  /** The upstream that served it, which is what decides the price when two of them offer the same model */
  providerId?: string;
  effort?: string;
  usage?: TurnUsage;
  status: 'completed' | 'error' | 'aborted';
  /** cli: the turn total the CLI reported. gateway: one row per upstream call, recorded by the gateway. */
  source?: 'cli' | 'gateway';
  /** Non-empty means this usage came from a user's own CLI on a long-lived api key, not from our containers */
  apiKeyId?: string;
  queueWaitMs?: number;
  ttftMs?: number;
}

/**
 * Convert to billable tokens.
 *
 * A cache hit costs far less than ordinary input and output costs more than input, so a
 * plain sum is badly distorted. The weights are adjustable in system settings
 * (quota.weightCacheRead / quota.weightOutput).
 */
export function billable(u: TurnUsage): number {
  const w = quotaWeights();
  return Math.round(
    u.inputTokens * w.input +
      u.cacheReadTokens * w.cacheRead +
      u.cacheCreationTokens * w.cacheCreation +
      u.outputTokens * w.output,
  );
}

export function record(input: RecordInput): void {
  const u = input.usage;
  // A failed turn with no usage still gets a row, for debugging, but is not billed
  run(
    `insert into usage_records
       (user_id, conversation_id, turn_id, agent, model, provider_id, effort,
        input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens,
        billable_tokens, cost_usd, cost_micro, duration_ms, num_turns, status, created_at, day,
        source, queue_wait_ms, ttft_ms, api_key_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.userId,
    input.conversationId ?? null,
    input.turnId ?? null,
    input.agent,
    input.model ?? null,
    input.providerId ?? null,
    input.effort ?? null,
    u?.inputTokens ?? 0,
    u?.cacheReadTokens ?? 0,
    u?.cacheCreationTokens ?? 0,
    u?.outputTokens ?? 0,
    u ? billable(u) : 0,
    u?.costUsd ?? 0,
    u ? pricing.costMicro(input.model, u, undefined, input.providerId) : 0,
    u?.durationMs ?? null,
    u?.numTurns ?? null,
    input.status,
    nowIso(),
    localDay(),
    input.source ?? 'cli',
    input.queueWaitMs ?? null,
    input.ttftMs ?? null,
    input.apiKeyId ?? null,
  );
}

/* ---------------- Aggregates ---------------- */

export interface Totals {
  /** Upstream calls — more than the number of turns, when counted by the gateway */
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  billableTokens: number;
  costUsd: number;
  /** Cost from the price table, in micro-units */
  costMicro: number;
  turns: number;
}

interface TotalsRow {
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  output_tokens: number | null;
  billable_tokens: number | null;
  cost_usd: number | null;
  cost_micro: number | null;
  turns: number | null;
  calls: number | null;
}

/**
 * The aggregate columns.
 *
 * They have to be table-qualified: in a query with a JOIN, a bare id/turn_id collides
 * with the same column on the joined table — measured, as "ambiguous column name: id".
 */
const SUM = (a = ''): string => `
  coalesce(sum(${a}input_tokens),0)          as input_tokens,
  coalesce(sum(${a}cache_read_tokens),0)     as cache_read_tokens,
  coalesce(sum(${a}cache_creation_tokens),0) as cache_creation_tokens,
  coalesce(sum(${a}output_tokens),0)         as output_tokens,
  coalesce(sum(${a}billable_tokens),0)       as billable_tokens,
  coalesce(sum(${a}cost_usd),0)              as cost_usd,
  coalesce(sum(${a}cost_micro),0)            as cost_micro,
  -- The gateway records a row per upstream call, the CLI one per turn.
  -- De-duplicating on turn_id is what makes "turns" mean the same thing either way
  count(distinct coalesce(${a}turn_id, cast(${a}id as text))) as turns,
  count(*)                                   as calls`;

const toTotals = (r?: TotalsRow): Totals => ({
  inputTokens: r?.input_tokens ?? 0,
  cacheReadTokens: r?.cache_read_tokens ?? 0,
  cacheCreationTokens: r?.cache_creation_tokens ?? 0,
  outputTokens: r?.output_tokens ?? 0,
  billableTokens: r?.billable_tokens ?? 0,
  costUsd: r?.cost_usd ?? 0,
  costMicro: r?.cost_micro ?? 0,
  turns: r?.turns ?? 0,
  calls: r?.calls ?? 0,
});

/**
 * Where a period starts and ends.
 *
 * The date arithmetic is in period.ts — pure functions with tests over the awkward cases:
 * the 31st in February, an anchor hour not yet reached, a year boundary. This only feeds
 * it the anchor an administrator configured.
 *
 * No scheduled job is needed. Usage is "the sum where created_at >= periodStart", so once
 * a boundary passes the old rows stop counting and it has reset by itself. That also
 * removes the failure mode where a stuck reset job blocks everyone.
 */
export function periodStart(
  period: QuotaPeriod,
  now = new Date(),
  rolling?: RollingSpec,
): string {
  return periodStartAt(period, now, quotaAnchor(), rolling).toISOString();
}

export function periodEnd(
  period: QuotaPeriod,
  now = new Date(),
  rolling?: RollingSpec,
): string | null {
  return periodEndAt(period, now, quotaAnchor(), rolling)?.toISOString() ?? null;
}

/** A window, inclusive of `from` and exclusive of `to`. Omitting `to` means up to now. */
export interface Range {
  from: string;
  to?: string;
}

const EPOCH = '1970-01-01T00:00:00.000Z';
const FOREVER = '9999-12-31T23:59:59.999Z';
const bounds = (r?: Range | string): [string, string] =>
  typeof r === 'string'
    ? [r, FOREVER]
    : [r?.from ?? EPOCH, r?.to ?? FOREVER];

export function totalsForUser(userId: string, range?: Range | string): Totals {
  const [from, to] = bounds(range);
  return toTotals(
    get<TotalsRow>(
      `select ${SUM()} from usage_records
       where user_id = ? and created_at >= ? and created_at < ?`,
      userId,
      from,
      to,
    ),
  );
}

export function totalsAll(since?: string): Totals {
  return toTotals(
    get<TotalsRow>(
      `select ${SUM()} from usage_records where created_at >= ?`,
      since ?? '1970-01-01T00:00:00.000Z',
    ),
  );
}

export interface DailyPoint extends Totals {
  day: string;
}

export function dailyForUser(userId: string, days = 30): DailyPoint[] {
  const from = localDay(new Date(Date.now() - (days - 1) * 86400_000));
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records
     where user_id = ? and day >= ? group by day order by day`,
    userId,
    from,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

/** A day-by-day breakdown over any window */
export function dailyForUserRange(userId: string, range: Range): DailyPoint[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records
     where user_id = ? and created_at >= ? and created_at < ?
     group by day order by day`,
    userId,
    from,
    to,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

/** Hour by hour — grouping "today" by day is one bar, which says nothing */
export interface HourlyPoint extends Totals {
  hour: string;
}

export function hourlyForUserRange(userId: string, range: Range): HourlyPoint[] {
  const [from, to] = bounds(range);
  // SQLite's datetime functions work in UTC; the localtime modifier moves them to the
  // local timezone
  return all<TotalsRow & { hour: string }>(
    `select strftime('%Y-%m-%d %H:00', created_at, 'localtime') as hour, ${SUM()}
     from usage_records
     where user_id = ? and created_at >= ? and created_at < ?
     group by hour order by hour`,
    userId,
    from,
    to,
  ).map((r) => ({ hour: r.hour, ...toTotals(r) }));
}

export interface AgentBreakdown extends Totals {
  agent: string;
  model: string | null;
}

export function byAgentForUser(userId: string, range?: Range | string): AgentBreakdown[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { agent: string; model: string | null }>(
    `select agent, model, ${SUM()} from usage_records
     where user_id = ? and created_at >= ? and created_at < ?
     group by agent, model order by billable_tokens desc`,
    userId,
    from,
    to,
  ).map((r) => ({ agent: r.agent, model: r.model, ...toTotals(r) }));
}

/** Cumulative usage per API key — shown beside each key on the settings page, so it is visible which one is in use */
export function byApiKeyForUser(userId: string): Array<Totals & { apiKeyId: string }> {
  return all<TotalsRow & { api_key_id: string }>(
    `select api_key_id, ${SUM()} from usage_records
      where user_id = ? and api_key_id is not null
      group by api_key_id`,
    userId,
  ).map((r) => ({ apiKeyId: r.api_key_id, ...toTotals(r) }));
}

export interface ConversationUsage extends Totals {
  conversationId: string;
  title: string;
  agent: string;
  updatedAt: string;
}

export function byConversationForUser(
  userId: string,
  limit = 20,
  range?: Range | string,
): ConversationUsage[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { conversation_id: string; title: string; agent: string; updated_at: string }>(
    `select u.conversation_id, c.title, c.agent, c.updated_at, ${SUM('u.')}
     from usage_records u join conversations c on c.id = u.conversation_id
     where u.user_id = ? and u.created_at >= ? and u.created_at < ?
     group by u.conversation_id
     order by billable_tokens desc
     limit ?`,
    userId,
    from,
    to,
    limit,
  ).map((r) => ({
    conversationId: r.conversation_id,
    title: r.title,
    agent: r.agent,
    updatedAt: r.updated_at,
    ...toTotals(r),
  }));
}

export interface UserLeaderRow extends Totals {
  userId: string;
  username: string;
  email: string;
}

export function topUsers(since?: string, limit = 20): UserLeaderRow[] {
  return all<TotalsRow & { user_id: string; username: string; email: string }>(
    `select u.user_id, us.username, us.email, ${SUM('u.')}
     from usage_records u join users us on us.id = u.user_id
     where u.created_at >= ?
     group by u.user_id
     order by billable_tokens desc
     limit ?`,
    since ?? '1970-01-01T00:00:00.000Z',
    limit,
  ).map((r) => ({ userId: r.user_id, username: r.username, email: r.email, ...toTotals(r) }));
}

export function dailyAll(days = 30): DailyPoint[] {
  const from = localDay(new Date(Date.now() - (days - 1) * 86400_000));
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records where day >= ? group by day order by day`,
    from,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

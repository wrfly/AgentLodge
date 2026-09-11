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

export type TurnStatus = 'completed' | 'error' | 'aborted';

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
  status: TurnStatus;
  /** cli: the turn total the CLI reported. gateway: one row per upstream call, recorded by the gateway. */
  source?: 'cli' | 'gateway';
  /** Non-empty means this usage came from a user's own CLI on a long-lived api key, not from our containers */
  apiKeyId?: string;
  queueWaitMs?: number;
  ttftMs?: number;
}

/**
 * Convert to billable tokens: what the turn cost, expressed as a count.
 *
 * A plain sum of tokens is badly distorted in two directions. Within one turn, a cache hit
 * costs a fraction of ordinary input and output costs several times more. Across models, the
 * prices differ by a factor of ten over a single vendor's range — Claude Fable is $10/$50
 * per MTok against Haiku's $1/$5 — so counting tokens alike means somebody on the expensive
 * model spends ten times as much and draws exactly as much quota.
 *
 * Both come out of the price table, which is where the real numbers already are. The turn is
 * costed, then divided by what one input token costs at the catch-all price — the `*` row,
 * which every table has and which nothing else moves. So a billable token means "one input
 * token at the standard rate", every model converts at the ratio of its own prices, and the
 * awkward cases need no configuring: Claude Fable reads its cache at a fortieth of its input
 * price where the rest of the range is at a tenth, which one global weight cannot say.
 *
 * The weights below are what is left when the table cannot answer — no rows at all, or a
 * model priced at zero. Falling through to zero instead would let a mispriced table quietly
 * make a model free.
 */
export function billable(u: TurnUsage, model?: string | null, providerId?: string | null): number {
  /*
   * Whether the table can price this, not whether the price rounded to something. Gating on
   * a rounded cost put a cliff in the middle of the scale: on an upstream whose input token
   * is 0.435 of a micro-unit, one token billed 1 (rounded to zero, so the weights answered),
   * two through five billed 0, and six billed 1 again. The gateway writes a row per upstream
   * call, so short calls met it one after another.
   */
  const priced = pricing.resolve(model, undefined, providerId);
  const unit = pricing.resolve('*');
  if (priced && unit && unit.priceInput > 0) {
    return Math.round(pricing.costMicroExact(model, u, undefined, providerId) / (unit.priceInput / 1_000_000));
  }

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
    u ? billable(u, input.model, input.providerId) : 0,
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

/**
 * When this account first spent anything, or undefined if it never has.
 *
 * "All time" used to be written as 1970 in the route, which is only ever right by accident:
 * the label claims a period the account did not exist for, and filling the gaps in it means
 * twenty thousand empty days.
 */
export function firstRecordFor(userId: string): string | undefined {
  return get<{ first: string | null }>(
    'select min(created_at) as first from usage_records where user_id = ?',
    userId,
  )?.first ?? undefined;
}

export function totalsAll(since?: string): Totals {
  return toTotals(
    get<TotalsRow>(
      `select ${SUM()} from usage_records where created_at >= ?`,
      since ?? '1970-01-01T00:00:00.000Z',
    ),
  );
}

/**
 * Everybody's consumption over one window, optionally through one upstream.
 *
 * The upstream filter is the point of it. The allowance figures the gateway derives compare
 * this against what a single subscription reports about itself, so counting turns that never
 * touched that subscription would inflate the denominator — see gateway/pool-share.ts. A
 * deployment routing half its traffic to a second provider would otherwise understate every
 * user's share by roughly half.
 */
export function totalsAllInRange(range: Range, providerId?: string): Totals {
  const [from, to] = bounds(range);
  return toTotals(
    providerId === undefined
      ? get<TotalsRow>(
          `select ${SUM()} from usage_records
           where created_at >= ? and created_at < ?`,
          from,
          to,
        )
      : get<TotalsRow>(
          `select ${SUM()} from usage_records
           where provider_id = ? and created_at >= ? and created_at < ?`,
          providerId,
          from,
          to,
        ),
  );
}

/**
 * How many turns ended each way over a window, everybody's.
 *
 * Refusals are not in here — they are not turns and live in their own table. This counts what
 * actually ran, so the console can say how many of them the upstream failed.
 */
export function statusCountsAll(range: Range): Record<TurnStatus, number> {
  const [from, to] = bounds(range);
  const rows = all<{ status: string; n: number }>(
    `select status, count(*) as n from usage_records
     where created_at >= ? and created_at < ? group by status`,
    from,
    to,
  );
  const out: Record<TurnStatus, number> = { completed: 0, error: 0, aborted: 0 };
  // `hasOwn`, not `in`: `'constructor' in {}` is true, and a row with that status would
  // append a number to a function
  for (const r of rows) if (Object.hasOwn(out, r.status)) out[r.status as TurnStatus] += r.n;
  return out;
}

/**
 * A turn the quota gate refused, in the window it was refused in.
 *
 * At most one per person per window, enforced by the table's primary key rather than by
 * looking first: the app and the gateway are separate processes over the same file, so a
 * check-then-insert between them is a race, and a client retrying in a loop would otherwise
 * write a row a second — a figure measuring that client's retry policy and nothing else.
 *
 * Keyed on the window's own boundary. `countsFrom` moves forward when an administrator
 * resets somebody mid-window, which would let the same window record the same person twice.
 */
export function noteRefusal(input: {
  userId: string;
  agent: AgentId;
  scope: string;
  windowStart: string;
}): void {
  run(
    `insert or ignore into quota_refusals (user_id, window_start, agent, scope, created_at)
     values (?, ?, ?, ?, ?)`,
    input.userId,
    input.windowStart,
    input.agent,
    input.scope,
    nowIso(),
  );
}

/** How many people the gate turned away inside this window */
export function refusedCount(range: Range): number {
  const [from, to] = bounds(range);
  return (
    get<{ n: number }>(
      `select count(*) as n from quota_refusals where created_at >= ? and created_at < ?`,
      from,
      to,
    )?.n ?? 0
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

/**
 * What one conversation cost, split by the model that answered.
 *
 * From `usage_records`, which is what the usage page and the quota both read, so the figure
 * in the chat header is the same figure they are. The header used to add up
 * `message.usage.costUsd` — the CLI's own report of what it spent — which is a different
 * number in a different currency from the one this deployment bills in.
 *
 * A turn with no model recorded groups under an empty name; the interface reads that as
 * "whatever the CLI picked".
 */
/**
 * What one conversation cost, per model — threads included.
 *
 * A thread is its own conversation row, so counting `conversation_id` alone left its spend
 * out of the only place a conversation's cost is shown. Threads are kept out of the sidebar
 * on purpose, which means that spend appeared nowhere but the global usage page, even though
 * it came off the same quota and was started from this conversation.
 *
 * The subquery is one level deep because the tree is: a thread cannot have threads of its
 * own, `parent_id` is only ever set to a conversation the user owns, and nothing creates a
 * child of a child.
 */
export function byModelForConversation(conversationId: string): Array<Totals & { model: string }> {
  return all<TotalsRow & { model: string | null }>(
    `select coalesce(model, '') as model, ${SUM()}
       from usage_records
      where conversation_id = ?
         or conversation_id in (select id from conversations where parent_id = ?)
      group by coalesce(model, '')
      order by cost_micro desc`,
    conversationId,
    conversationId,
  ).map((r) => ({ model: r.model ?? '', ...toTotals(r) }));
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

export function topUsers(range?: Range | string, limit = 20): UserLeaderRow[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { user_id: string; username: string; email: string }>(
    `select u.user_id, us.username, us.email, ${SUM('u.')}
     from usage_records u join users us on us.id = u.user_id
     where u.created_at >= ? and u.created_at < ?
     group by u.user_id
     -- Somebody whose only row in the window is a refusal spent nothing, and a list of who
     -- spent the most should not have them in it at all. Spelled as the aggregates rather
     -- than the output aliases: billable_tokens is also a real column, so SQLite binds the
     -- bare name to some arbitrary row of the group and a user with one zero row vanishes.
     having sum(u.billable_tokens) > 0 or sum(u.cost_micro) > 0
     order by billable_tokens desc
     limit ?`,
    from,
    to,
    limit,
  ).map((r) => ({ userId: r.user_id, username: r.username, email: r.email, ...toTotals(r) }));
}

export function dailyAllInRange(range: Range): DailyPoint[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records
     where created_at >= ? and created_at < ? group by day order by day`,
    from,
    to,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

/**
 * The same series with a bucket for every hour or day in the range, spent or not.
 *
 * Padded here rather than in the browser. The keys come out of SQLite's `localtime`, which is
 * the *server's* local time, and a client rebuilding them from its own clock produces keys
 * that match nothing — an admin in Shanghai reading a UTC server saw a chart of empty bars
 * over a headline reading 500,000. Reconstructing them also has to guess whether `from` sits
 * on the bucket grid (a configured reset hour means it does not, and the newest bucket goes
 * missing) and what to do at a DST boundary, where an hour occurs twice or not at all.
 *
 * Walking the calendar from the server's own bucket keys sidesteps all three.
 */
/**
 * More buckets than a chart can draw, past which filling the gaps is not worth the response.
 *
 * `All time` starts at the account's first record, so this is normally the ceiling nobody
 * reaches. It exists because a range that reaches back to the epoch produces 20 000 daily
 * buckets and three megabytes of zeroes — measured, from one caller passing 1970 as `from`.
 * Beyond the cap the rows go out as they came, which is what every chart here did before the
 * gaps were filled at all.
 */
const MAX_BUCKETS = 1_000;

function padded<T extends { t: string }>(
  rows: T[],
  from: string,
  to: string,
  unit: 'hour' | 'day',
  blank: Omit<T, 't'>,
): T[] {
  const hit = new Map(rows.map((r) => [r.t, r]));
  const step = unit === 'hour' ? 3600_000 : 86400_000;
  const start = new Date(from);
  const end = Math.min(new Date(to).getTime(), Date.now());
  if ((end - start.getTime()) / step > MAX_BUCKETS) return rows;
  // Anchor on the bucket the range starts inside, not on `from` itself
  if (unit === 'hour') start.setMinutes(0, 0, 0);
  else start.setHours(0, 0, 0, 0);

  const out: T[] = [];
  for (let ms = start.getTime(); ms <= end; ms += step) {
    const d = new Date(ms);
    // Fixed-size steps drift by an hour across a DST change; re-anchoring each bucket to the
    // calendar is what keeps one bucket per hour and one per day either way
    if (unit === 'hour') d.setMinutes(0, 0, 0);
    else d.setHours(0, 0, 0, 0);
    const key = keyOf(d, unit);
    if (out.length && out[out.length - 1]!.t === key) continue;
    out.push(hit.get(key) ?? ({ ...blank, t: key } as T));
  }
  return out;
}

const two = (n: number) => String(n).padStart(2, '0');
/** The same shape SQLite's `localtime` strftime produces */
const keyOf = (d: Date, unit: 'hour' | 'day'): string =>
  unit === 'hour'
    ? `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:00`
    : `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;

const EMPTY_TOTALS: Totals = {
  calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
  billableTokens: 0, costUsd: 0, costMicro: 0, turns: 0,
};

/** Everybody's series over a range, one point per bucket, empty ones included */
/**
 * One person's series, with a bucket for every hour or day in the range.
 *
 * The everybody version below has been padded since the admin chart was found drawing empty
 * bars over a headline of half a million. This one was not, so a quota month with usage on
 * one day drew a single bar filling the card, labelled with the same date at both ends — it
 * looked like a chart of the whole month and was a chart of one day.
 */
export function seriesForUserInRange(
  userId: string,
  range: Range,
  unit: 'hour' | 'day',
): Array<Totals & { t: string }> {
  const [from, to] = bounds(range);
  const rows: Array<Totals & { t: string }> =
    unit === 'hour'
      ? hourlyForUserRange(userId, range).map(({ hour, ...rest }) => ({ ...rest, t: hour }))
      : dailyForUserRange(userId, range).map(({ day, ...rest }) => ({ ...rest, t: day }));
  return padded(rows, from, to, unit, EMPTY_TOTALS);
}

export function seriesAllInRange(range: Range, unit: 'hour' | 'day'): Array<Totals & { t: string }> {
  const [from, to] = bounds(range);
  const rows: Array<Totals & { t: string }> =
    unit === 'hour'
      ? hourlyAllInRange(range).map(({ hour, ...rest }) => ({ ...rest, t: hour }))
      : dailyAllInRange(range).map(({ day, ...rest }) => ({ ...rest, t: day }));
  return padded(rows, from, to, unit, EMPTY_TOTALS);
}

export function hourlyAllInRange(range: Range): HourlyPoint[] {
  const [from, to] = bounds(range);
  // SQLite's datetime functions work in UTC; the localtime modifier moves them to local
  return all<TotalsRow & { hour: string }>(
    `select strftime('%Y-%m-%d %H:00', created_at, 'localtime') as hour, ${SUM()}
     from usage_records
     where created_at >= ? and created_at < ?
     group by hour order by hour`,
    from,
    to,
  ).map((r) => ({ hour: r.hour, ...toTotals(r) }));
}

export function dailyAll(days = 30): DailyPoint[] {
  const from = localDay(new Date(Date.now() - (days - 1) * 86400_000));
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records where day >= ? group by day order by day`,
    from,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

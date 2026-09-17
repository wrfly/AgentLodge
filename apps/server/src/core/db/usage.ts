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
import type { AgentId, TurnUsage, LimitKind } from '../protocol.js';

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

/**
 * Narrow a report to the traffic that went out through one upstream.
 *
 * `undefined` is no filter. `null` is the rows with no upstream of ours at all — usage the
 * CLI booked itself, which `turns.ts` does only when the gateway was not in the path, and
 * rows written before this column existed. Those are real spend and have to be selectable,
 * or the breakdown's rows would not add up to the total beside them.
 *
 * Spelled as a fragment rather than five copies of the same two lines, because the report is
 * five queries over one table and a filter that reached four of them would be worse than
 * none: the chart would disagree with the figure above it.
 */
export type UpstreamFilter = string | null | undefined;

function onlyUpstream(only: UpstreamFilter, prefix = ''): { sql: string; params: string[] } {
  if (only === undefined) return { sql: '', params: [] };
  return only === null
    ? { sql: ` and ${prefix}provider_id is null`, params: [] }
    : { sql: ` and ${prefix}provider_id = ?`, params: [only] };
}

export function totalsForUser(userId: string, range?: Range | string, only?: UpstreamFilter): Totals {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  return toTotals(
    get<TotalsRow>(
      `select ${SUM()} from usage_records
       where user_id = ? and created_at >= ? and created_at < ?${f.sql}`,
      userId,
      from,
      to,
      ...f.params,
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

/**
 * What one of this user's turns typically costs, in the unit their quota is counted in.
 *
 * For telling somebody how much room they have left in a unit that means something to
 * them. "1.2M billable tokens remaining" answers nothing on its own — the same number is
 * two turns for one person and forty for another, and which they are is not something they
 * can work out. It is derived from what they have actually spent rather than estimated
 * from the model and the context, because a turn's cost depends on how many upstream calls
 * the agent makes, which nobody can know in advance.
 *
 * The median, not the mean: a single runaway turn is exactly the thing somebody wants to
 * be warned about, and it is also the thing that would drag a mean far enough to stop the
 * warning being useful for the other twenty.
 *
 * Zero-cost rows are left out. A failed turn still gets a row, for debugging, and counting
 * those as cheap turns would say somebody has more room than they do.
 *
 * **Bounded to a window on purpose, and not called on the hot path.** `group by` defeats
 * the (user_id, created_at) index, so without `since` this reads every row the user has
 * ever produced and builds a temporary b-tree to sort it — and the gateway writes one row
 * per upstream call, so "ever" grows without limit. It was briefly wired into
 * `quota.status()`, which the gate calls on every single request and the admin user list
 * calls once per user; node:sqlite is synchronous, so that is the event loop. It is asked
 * for explicitly now, by the three surfaces that show it.
 */
export function typicalTurn(
  userId: string,
  kind: LimitKind,
  sample = 20,
  /** How far back to look. A month is long enough to have twenty turns in it and short
   *  enough that the scan stays small — and recent turns are the ones that predict. */
  since = new Date(Date.now() - 30 * 86_400_000).toISOString(),
): number | null {
  const column = kind === 'cost' ? 'cost_micro' : 'billable_tokens';
  const rows = all<{ spent: number }>(
    `select sum(${column}) as spent
     from usage_records
     where user_id = ? and created_at >= ?
     group by coalesce(turn_id, 'row:' || id)
     having spent > 0
     order by max(created_at) desc
     limit ?`,
    userId,
    since,
    sample,
  );
  if (!rows.length) return null;
  // The gateway writes a row per upstream call, so a turn is the group, not the row
  const spent = rows.map((r) => r.spent).sort((a, b) => a - b);
  const mid = Math.floor(spent.length / 2);
  return spent.length % 2 ? spent[mid]! : Math.round((spent[mid - 1]! + spent[mid]!) / 2);
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
export function totalsAllInRange(range: Range, only?: UpstreamFilter): Totals {
  const [from, to] = bounds(range);
  // One query with a fragment, where this was two whole copies of it — and the second could
  // only ask for a named upstream, never for the rows that have none
  const f = onlyUpstream(only);
  return toTotals(
    get<TotalsRow>(
      `select ${SUM()} from usage_records
       where created_at >= ? and created_at < ?${f.sql}`,
      from,
      to,
      ...f.params,
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
export function dailyForUserRange(userId: string, range: Range, only?: UpstreamFilter): DailyPoint[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records
     where user_id = ? and created_at >= ? and created_at < ?${f.sql}
     group by day order by day`,
    userId,
    from,
    to,
    ...f.params,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

/** Hour by hour — grouping "today" by day is one bar, which says nothing */
export interface HourlyPoint extends Totals {
  hour: string;
}

export function hourlyForUserRange(userId: string, range: Range, only?: UpstreamFilter): HourlyPoint[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  // SQLite's datetime functions work in UTC; the localtime modifier moves them to the
  // local timezone
  return all<TotalsRow & { hour: string }>(
    `select strftime('%Y-%m-%d %H:00', created_at, 'localtime') as hour, ${SUM()}
     from usage_records
     where user_id = ? and created_at >= ? and created_at < ?${f.sql}
     group by hour order by hour`,
    userId,
    from,
    to,
    ...f.params,
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

export function byAgentForUser(userId: string, range?: Range | string, only?: UpstreamFilter): AgentBreakdown[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  return all<TotalsRow & { agent: string; model: string | null }>(
    `select agent, model, ${SUM()} from usage_records
     where user_id = ? and created_at >= ? and created_at < ?${f.sql}
     group by agent, model order by billable_tokens desc`,
    userId,
    from,
    to,
    ...f.params,
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

export interface UpstreamUsage extends Totals {
  /** Empty when the gateway was not in the path, so there is no upstream of ours to name */
  providerId: string;
  name: string;
  kind: string;
  /** Which credential it authenticated with, as the credential manager knows it */
  credentialId: string;
}

/**
 * What went out through each upstream, and on whose credential.
 *
 * The join is left, and the missing side is a row rather than a gap: usage recorded when the
 * gateway was not in the path has no provider at all (`turns.ts` books the CLI's own total
 * only in that case), and a provider deleted since still has its spend in the table. Dropping
 * either would make this card disagree with the total above it, which is the one thing a
 * breakdown must not do.
 */
export function byUpstreamForUser(userId: string, range?: Range | string): UpstreamUsage[] {
  return byUpstream(range, userId);
}

/** The same breakdown for everybody, which is what the console asks for */
export function byUpstreamAll(range?: Range | string): UpstreamUsage[] {
  return byUpstream(range);
}

function byUpstream(range?: Range | string, userId?: string): UpstreamUsage[] {
  const [from, to] = bounds(range);
  const mine = userId === undefined ? '' : ' and u.user_id = ?';
  return all<TotalsRow & { provider_id: string | null; name: string | null; kind: string | null; credential_id: string | null }>(
    `select u.provider_id, p.name, p.kind, p.credential_id, ${SUM('u.')}
     from usage_records u left join upstream_providers p on p.id = u.provider_id
     where u.created_at >= ? and u.created_at < ?${mine}
     group by u.provider_id
     order by billable_tokens desc`,
    from,
    to,
    ...(userId === undefined ? [] : [userId]),
  ).map((r) => ({
    providerId: r.provider_id ?? '',
    name: r.name ?? '',
    kind: r.kind ?? '',
    credentialId: r.credential_id ?? '',
    ...toTotals(r),
  }));
}

/** One model's share of one upstream — `providerId` empty for the rows with no upstream of ours */
export interface UpstreamModelUsage extends Totals {
  providerId: string;
  model: string;
}

/**
 * Every (upstream, model) pair over a range, for the console to hang under its upstream rows.
 *
 * One scan for the whole card rather than one per upstream opened. The result is bounded by
 * providers × models — a couple of dozen rows on any deployment that has a price table — so
 * sending it all and letting the page reveal a row's share costs less than a request per
 * click, and the expanded rows are guaranteed to add up to the row they hang under because
 * both came from the same scan.
 *
 * No join at all, which is how spend with no upstream of ours keeps its row: `byUpstream`
 * needs one for the provider's name and credential and makes it a **left** join for exactly
 * this reason, and here there is no name to fetch. Anyone adding one later should make it
 * left too — an inner join would silently drop the not-through-the-gateway bucket, and a
 * breakdown that stops summing to the total above it is the one thing it must not do.
 */
export function byUpstreamModelAll(range?: Range | string): UpstreamModelUsage[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { provider_id: string | null; model: string | null }>(
    `select u.provider_id, coalesce(u.model, '') as model, ${SUM('u.')}
     from usage_records u
     where u.created_at >= ? and u.created_at < ?
     group by u.provider_id, coalesce(u.model, '')
     order by billable_tokens desc`,
    from,
    to,
  ).map((r) => ({
    providerId: r.provider_id ?? '',
    model: r.model ?? '',
    ...toTotals(r),
  }));
}

export function byConversationForUser(
  userId: string,
  limit = 20,
  range?: Range | string,
  only?: UpstreamFilter,
): ConversationUsage[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only, 'u.');
  return all<TotalsRow & { conversation_id: string; title: string; agent: string; updated_at: string }>(
    `select u.conversation_id, c.title, c.agent, c.updated_at, ${SUM('u.')}
     from usage_records u join conversations c on c.id = u.conversation_id
     where u.user_id = ? and u.created_at >= ? and u.created_at < ?${f.sql}
     group by u.conversation_id
     order by billable_tokens desc
     limit ?`,
    userId,
    from,
    to,
    ...f.params,
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
  /** Empty when the account has been deleted and only its spend is left */
  username: string;
  email: string;
}

/**
 * Every account with any activity over a range, heaviest first.
 *
 * This has to **account for the period**, which is what separates it from a leaderboard: the
 * console prints a total above these rows, so every row the total counts has to be here.
 *
 * Two consequences, both deliberate:
 *
 * No `having`. An account whose only turns in the range were refused or errored spent nothing
 * and would be filtered out of a leaderboard as noise — but the total counts its turns, so
 * dropping it leaves a turn count nothing adds up to and no row to attribute the difference
 * to. A row of zeroes is the honest answer to "who was active".
 *
 * A **left** join, like `byUpstream` and for the same reason. `usage_records.user_id` has no
 * foreign key and nothing cascades, so deleting an account leaves its spend in the table; an
 * inner join would drop that spend from the breakdown while the total above it still counted
 * it. `username` comes back empty for those, and the console names the row rather than
 * leaving a gap.
 */
export function allUsersInRange(range: Range): UserLeaderRow[] {
  const [from, to] = bounds(range);
  return all<TotalsRow & { user_id: string; username: string | null; email: string | null }>(
    `select u.user_id, us.username, us.email, ${SUM('u.')}
     from usage_records u left join users us on us.id = u.user_id
     where u.created_at >= ? and u.created_at < ?
     group by u.user_id
     order by billable_tokens desc`,
    from,
    to,
  ).map((r) => ({
    userId: r.user_id,
    username: r.username ?? '',
    email: r.email ?? '',
    ...toTotals(r),
  }));
}

export function dailyAllInRange(range: Range, only?: UpstreamFilter): DailyPoint[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records
     where created_at >= ? and created_at < ?${f.sql} group by day order by day`,
    from,
    to,
    ...f.params,
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
  const keys = bucketKeys(from, to, unit);
  if (!keys) return rows;
  const hit = new Map(rows.map((r) => [r.t, r]));
  return keys.map((t) => hit.get(t) ?? ({ ...blank, t } as T));
}

/**
 * Every bucket key the range covers, in order — or undefined when there are too many to draw.
 *
 * Separated out because this walk is where the bugs were, and it is pure: a range, a unit and
 * a clock in, a list of keys out. The keys are the same strings SQLite's `localtime` produces,
 * so they can be looked up directly against a grouped query.
 *
 * Stepped through the calendar rather than by a fixed number of milliseconds. Adding
 * 86 400 000 across a fall-back lands on 23:00 of the day before, and every later step stays
 * an hour behind — so the walk ends a day early and today's bar vanishes from under a
 * headline that still counts it. On a server in New York on 2026-11-05 that was four buckets
 * ending 11-04 under a total of 12,345. `setDate(+1)` keeps the local wall clock and moves
 * the instant, which is what a day means here.
 *
 * A bucket belongs to the range when its own start does: before `to`, which is exclusive — a
 * custom range written `2026-08-01 ~ 2026-08-15` used to draw a bucket for the 16th and put
 * it on the axis — and not in the future, so a range running to the end of today stops at
 * today.
 */
export function bucketKeys(
  from: string,
  to: string,
  unit: 'hour' | 'day',
  now = Date.now(),
): string[] | undefined {
  const step = unit === 'hour' ? 3600_000 : 86400_000;
  const until = new Date(to).getTime();
  // Anchor on the bucket the range starts inside, not on `from` itself
  const at = new Date(from);
  if (unit === 'hour') at.setMinutes(0, 0, 0);
  else at.setHours(0, 0, 0, 0);
  if ((Math.min(until, now) - at.getTime()) / step > MAX_BUCKETS) return undefined;

  const out: string[] = [];
  while (at.getTime() < until && at.getTime() <= now) {
    const key = keyOf(at, unit);
    // A fall-back repeats a local hour, and SQLite's `localtime` gives both the same key
    if (out[out.length - 1] !== key) out.push(key);
    if (unit === 'hour') at.setHours(at.getHours() + 1);
    else at.setDate(at.getDate() + 1);
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
  only?: UpstreamFilter,
): Array<Totals & { t: string }> {
  const [from, to] = bounds(range);
  const rows: Array<Totals & { t: string }> =
    unit === 'hour'
      ? hourlyForUserRange(userId, range, only).map(({ hour, ...rest }) => ({ ...rest, t: hour }))
      : dailyForUserRange(userId, range, only).map(({ day, ...rest }) => ({ ...rest, t: day }));
  return padded(rows, from, to, unit, EMPTY_TOTALS);
}

export function seriesAllInRange(
  range: Range,
  unit: 'hour' | 'day',
  only?: UpstreamFilter,
): Array<Totals & { t: string }> {
  const [from, to] = bounds(range);
  const rows: Array<Totals & { t: string }> =
    unit === 'hour'
      ? hourlyAllInRange(range, only).map(({ hour, ...rest }) => ({ ...rest, t: hour }))
      : dailyAllInRange(range, only).map(({ day, ...rest }) => ({ ...rest, t: day }));
  return padded(rows, from, to, unit, EMPTY_TOTALS);
}

export function hourlyAllInRange(range: Range, only?: UpstreamFilter): HourlyPoint[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  // SQLite's datetime functions work in UTC; the localtime modifier moves them to local
  return all<TotalsRow & { hour: string }>(
    `select strftime('%Y-%m-%d %H:00', created_at, 'localtime') as hour, ${SUM()}
     from usage_records
     where created_at >= ? and created_at < ?${f.sql}
     group by hour order by hour`,
    from,
    to,
    ...f.params,
  ).map((r) => ({ hour: r.hour, ...toTotals(r) }));
}

export function dailyAll(days = 30): DailyPoint[] {
  const from = localDay(new Date(Date.now() - (days - 1) * 86400_000));
  return all<TotalsRow & { day: string }>(
    `select day, ${SUM()} from usage_records where day >= ? group by day order by day`,
    from,
  ).map((r) => ({ day: r.day, ...toTotals(r) }));
}

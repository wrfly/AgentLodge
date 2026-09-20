import { all, get, localDay, nowIso, run, tx } from './index.js';
import {
  getNumberFresh,
  getString,
  getStringFresh,
  quotaAnchor,
  settingsGeneration,
} from './settings.js';
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

export function record(input: RecordInput): void {
  const u = input.usage;
  /*
   * The currency this turn's money is in: the one on the price row that priced it, so that
   * `cost_micro` and `cost_currency` always come from the same row. Read here rather than
   * from a global setting, because the whole point is that two upstreams bill in two
   * different currencies at the same time.
   */
  const priced = pricing.resolve(input.model, undefined, input.providerId);
  // A failed turn with no usage still gets a row, for debugging, but is not billed
  run(
    `insert into usage_records
       (user_id, conversation_id, turn_id, agent, model, provider_id, effort,
        input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens,
        web_search_requests,
        cost_usd, cost_micro, cost_currency, duration_ms, num_turns, status,
        created_at, day, source, queue_wait_ms, ttft_ms, api_key_id)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    u?.webSearchRequests ?? 0,
    u?.costUsd ?? 0,
    u && priced ? Math.round(pricing.costOf(priced, u)) : 0,
    priced?.currency ?? 'USD',
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

/**
 * Recost every usage row from the price table, once.
 *
 * Two things left the stored money wrong, and neither can be fixed by pricing new turns
 * correctly: a table that never got its Claude rows charged every Claude model at the
 * catch-all for months, and `cost_currency` did not exist, so nothing recorded which money a
 * figure was in. Both are recoverable, because the tokens were always right — the cost is
 * derived, and deriving it again is all this does. No token count is touched.
 *
 * Each row is priced **at its own `created_at`**, not at now. That is what makes a peak-hour
 * DeepSeek turn cost double and an older turn cost whatever the table said when it happened:
 * `resolve()` already takes the instant, filters on `effective_from <= at`, and applies the
 * vendor's peak windows to it. Pricing everything at now would quietly restate history at
 * today's rates.
 *
 * Guarded by a settings flag rather than by looking at the data: "has this run" cannot be
 * inferred from rows that new usage keeps changing, which is the lesson the whole migration
 * layer was rebuilt around.
 */
export function repriceHistory(): void {
  if (repriceMark() === 'done') return;

  /** A page at a time: the gateway writes a row per upstream call, so this table has no ceiling */
  const PAGE = 2_000;
  let after = 0;
  let scanned = 0;
  let changed = 0;
  let wasMicro = 0;
  const now: Money = {};

  for (;;) {
    const rows = all<{
      id: number; model: string | null; provider_id: string | null; created_at: string;
      input_tokens: number; cache_read_tokens: number; cache_creation_tokens: number;
      output_tokens: number; web_search_requests: number; cost_micro: number;
    }>(`select id, model, provider_id, created_at, input_tokens, cache_read_tokens,
               cache_creation_tokens, output_tokens, web_search_requests, cost_micro
          from usage_records where id > ? order by id limit ?`, after, PAGE);
    if (!rows.length) break;
    after = rows[rows.length - 1]!.id;

    /*
     * One transaction per page. Left implicit this is one commit — and under WAL one fsync —
     * per row, on the blocking startup path.
     */
    tx(() => {
      for (const r of rows) {
        const u: TurnUsage = {
          inputTokens: r.input_tokens,
          cacheReadTokens: r.cache_read_tokens,
          cacheCreationTokens: r.cache_creation_tokens,
          outputTokens: r.output_tokens,
          webSearchRequests: r.web_search_requests,
          costUsd: 0,
          durationMs: 0,
          numTurns: 1,
        };
        // Resolved once and costed from that row, rather than resolving again inside costMicro
        const priced = pricing.resolve(r.model, r.created_at, r.provider_id);
        const currency = priced?.currency ?? 'USD';
        const costMicro = priced ? Math.round(pricing.costOf(priced, u)) : 0;

        scanned++;
        wasMicro += r.cost_micro;
        now[currency] = (now[currency] ?? 0) + costMicro;
        if (costMicro !== r.cost_micro) changed++;

        /*
         * Cost is derived from a table that was wrong, so deriving it again is a correction —
         * the tokens it is derived *from* are untouched, and they are what makes that possible.
         */
        run(
          'update usage_records set cost_micro = ?, cost_currency = ? where id = ?',
          costMicro, currency, r.id,
        );
      }
    });
  }

  repriceMark('done');
  if (scanned) {
    const say = (m: Money) => Object.entries(m).map(([c, v]) => `${c} ${(v / 1e6).toFixed(4)}`).join(' + ');
    console.log(
      `[usage] recosted ${scanned} row(s) from the price table, ${changed} of them changed. ` +
        `Was ${(wasMicro / 1e6).toFixed(4)} in one unlabelled figure, now ${say(now)}. ` +
        'Token counts were not touched.',
    );
  }
}

/**
 * One flag, so the recost above runs once and is not inferred from data that keeps moving.
 *
 * Written straight to the settings table rather than through `setSetting`, which validates
 * against the declared spec and would put this in the console among things an operator is
 * meant to change. This is bookkeeping: it records that a one-off job has run.
 */
const REPRICED_KEY = 'usage.repricedAt';

function repriceMark(value?: string): string {
  if (value !== undefined) {
    run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      REPRICED_KEY, value, nowIso(),
    );
    return value;
  }
  return get<{ value: string }>('select value from settings where key = ?', REPRICED_KEY)?.value ?? '';
}

/* ---------------- Aggregates ---------------- */

/**
 * Money, per currency, in micro-units — what was actually charged, before any conversion.
 *
 * Vendors price in their own currency: Anthropic in dollars, DeepSeek in yuan, and the price
 * table holds each at its own published list so an invoice can be checked against it line by
 * line. A turn is recorded in the money it was charged in and stays that way in the database.
 *
 * This is the raw form. `settle()` is what a report shows — one currency, at the one
 * configured rate — and this map is what a reader can open to see where that figure came
 * from. Reports used to print the map itself, "¥12.34 + $5.67", which is honest and
 * unreadable: nobody can tell at a glance whether it is more than last month.
 *
 * A currency with nothing spent in it is absent rather than zero, so `Object.keys` is the
 * list of currencies actually used in whatever was asked about.
 */
export type Money = Record<string, number>;

/**
 * The currency every report, and every ceiling, is expressed in.
 *
 * Upper-cased because the setting is free text: `settlementRates()` compares it against
 * currency codes, and a deployment that typed `cny` would have had its yuan spend divided by
 * the rate and its dollars counted at par — every figure wrong, nothing logged.
 */
export const settlementCurrency = (): string => billing().currency;

/** How many yuan one dollar is worth. The only exchange rate in the system. */
export const cnyPerUsd = (): number => billing().rate;

/**
 * The currency and the rate, read past the settings cache, at most once a second.
 *
 * **Past the cache**, because the gateway is a second container over the same database and
 * `settings.load()` is invalidated only by writes in its own process. An administrator
 * correcting the rate in the console would have moved every report at once and left the gate
 * — the thing that actually refuses turns — enforcing at the rate it booted with, until
 * somebody restarted it. `settle()` promises the correction applies from the moment it is
 * set; that has to be true of the gate too. Caught in review.
 *
 * **At most once a second**, because `settle()` runs once per row of every breakdown, and two
 * uncached reads per row would put a few hundred SQLite round-trips behind one page. A second
 * of staleness on an exchange rate is not a number anybody can perceive; a restart-shaped one
 * is. The window is short enough that the two processes cannot disagree for long, and long
 * enough that a report costs two reads rather than two per row.
 *
 * A write in *this* process skips the wait entirely — `settingsGeneration()` moves on every
 * local save — so the console shows the new rate on the render after the one that saved it.
 * The second is only ever the other container's delay.
 */
let billingAt = 0;
let billingGen = -1;
let billingCache = { currency: 'USD', rate: 7.1 };

function billing(): { currency: string; rate: number } {
  const now = Date.now();
  const gen = settingsGeneration();
  if (gen === billingGen && now - billingAt < 1_000) return billingCache;
  billingGen = gen;
  const currency = (getStringFresh('billing.currency') || 'USD').trim().toUpperCase();
  const raw = getNumberFresh('billing.cnyPerUsd');
  const rate = raw !== undefined && Number.isFinite(raw) && raw > 0 ? raw : 7.1;
  billingCache = { currency, rate };
  billingAt = now;
  return billingCache;
}



/**
 * Collapse money into one number, in the settlement currency.
 *
 * Applied on the way out, to old figures as well as new — nothing stored is rewritten. So a
 * rate typed wrong is corrected in one place and every report is right again, rather than
 * leaving a month of bad numbers behind that only a script could fix. The cost of that is
 * that "last month's total" is not a frozen number; with one rate that moves rarely and
 * visibly, that is the better trade.
 *
 * A currency the rate cannot reach is counted at par and said out loud — wrong, but visible.
 * Silently dropping it would let spend vanish out of a total and out of a ceiling.
 */
export function settle(m: Money): number {
  const to = settlementCurrency();
  const rates = settlementRates();
  let out = 0;
  for (const [currency, micro] of Object.entries(m)) {
    if (currency === to) { out += micro; continue; }
    const rate = rates[currency];
    if (rate === undefined) {
      warnMissingRate(currency, to);
      out += micro;
      continue;
    }
    out += micro * rate;
  }
  return Math.round(out);
}

/**
 * That one rate, as the multipliers `settle()` wants: currency → settlement units per unit.
 *
 * Two vendors and two currencies, so there is one number and two directions to read it in.
 * It used to be a JSON object an operator typed by hand, which was more general than any
 * deployment needed and invited the two mistakes this shape cannot make: an entry for the
 * settlement currency itself, which is dead, and a rate written upside down.
 *
 * **It relates CNY and USD, and claims nothing about anything else.** Settling in a third
 * currency returns no rates at all, so `settle()` counts both sides at par and says so —
 * wrong, and visible. An earlier version returned the CNY multiplier for any settlement
 * currency that was not exactly 'CNY', which converted yuan at the dollar rate and labelled
 * the result €, silently, because a rate *was* defined. Caught in review.
 */
export function settlementRates(): Record<string, number> {
  const to = settlementCurrency();
  const rate = cnyPerUsd();
  if (to === 'CNY') return { USD: rate };
  if (to === 'USD') return { CNY: 1 / rate };
  return {};
}

const warned = new Set<string>();
function warnMissingRate(from: string, to: string): void {
  if (warned.has(from)) return;
  warned.add(from);
  console.warn(
    `[usage] no rate from ${from} to ${to}; it is being counted at par, which under-charges. ` +
      'billing.cnyPerUsd relates CNY and USD only — price that model in one of them, or the ' +
      'figures that include it are wrong.',
  );
}

/**
 * Heaviest first, by the settled figure.
 *
 * **Not `order by sum(cost_micro)`.** That adds yuan to dollars, which is the one thing this
 * module exists to avoid: at a configured rate ¥50 is about $7, but as raw micro-units it
 * outranks $30. The rows themselves were always right — `toTotals` splits them per currency —
 * so a leaderboard came back correctly costed in an order that contradicted its own numbers.
 *
 * `costSettled` is the figure the gate compares a ceiling against, so a list ordered by it
 * and a refusal cannot disagree about who is spending most. It is done here rather than in
 * SQL because the conversion is a setting rather than a column; the queries order by
 * something stable instead, and `sort` is stable, so equal spenders keep that order.
 */
function heaviestFirst<T extends Totals>(rows: T[]): T[] {
  return rows.sort((a, b) => b.costSettled - a.costSettled);
}

export interface Totals {
  /** Upstream calls — more than the number of turns, when counted by the gateway */
  calls: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Cost from the price table, in micro-units, per currency */
  cost: Money;
  /**
   * The same money collapsed into the settlement currency at the one configured rate.
   *
   * **This is what a screen shows** — a report, a quota bar, a ceiling, a share, all of it.
   * `cost` beside it is what was actually charged, and belongs in the hover that explains
   * this figure rather than in place of it. The console has one helper, `money()`, that
   * returns both, so no surface can render the converted number with no way to see behind it.
   */
  costSettled: number;
  turns: number;
}

interface TotalsRow {
  input_tokens: number | null;
  cache_read_tokens: number | null;
  cache_creation_tokens: number | null;
  output_tokens: number | null;
  cost_usd: number | null;
  turns: number | null;
  calls: number | null;
  /**
   * `money_<CODE>` columns, one per currency the table prices in — see SUM().
   *
   * Not `cost_<CODE>`: SQLite matches column names case-insensitively, so `cost_USD` and the
   * CLI's own `cost_usd` are one name to it, and a query selecting both is ambiguous.
   */
  [moneyColumn: string]: number | null | undefined;
}

/** ISO 4217-shaped, which is also what makes it safe to interpolate into a column name */
const CODE = /^[A-Z]{3}$/;

/**
 * The currencies to emit a cost column for.
 *
 * Both sides, and the union matters. The price table alone is not enough: deleting a price row
 * is something the console can do, and a currency that leaves the table would take every
 * figure ever recorded in it out of every total, breakdown and ceiling — silently, because a
 * column that is not emitted is money that simply is not there. The usage table alone is not
 * enough either, since a currency can be priced before anything has been spent in it.
 *
 * `idx_usage_cost_currency` is what keeps the second query off a full table scan; it is the
 * one table that grows without bound.
 */
function pricedCurrencies(): string[] {
  const set = new Set<string>(['USD']);   // what `record()` falls back to when nothing priced a turn
  for (const r of all<{ c: string }>('select distinct currency as c from model_pricing')) {
    if (CODE.test(r.c)) set.add(r.c);
  }
  for (const r of all<{ c: string }>('select distinct cost_currency as c from usage_records')) {
    if (CODE.test(r.c)) set.add(r.c);
  }
  return [...set].sort();
}

/**
 * The aggregate columns.
 *
 * They have to be table-qualified: in a query with a JOIN, a bare id/turn_id collides
 * with the same column on the joined table — measured, as "ambiguous column name: id".
 *
 * Money is emitted as one conditional sum per currency rather than by grouping on the
 * currency, and that is deliberate: grouping would split every row of every breakdown in two
 * and, worse, `turns` is `count(distinct turn_id)` — a turn that called Claude and then
 * DeepSeek would be counted once in each half and twice in their sum. Conditional columns
 * leave the group-by of all twenty-odd aggregates exactly as it was.
 */
const SUM = (a = ''): string => `
  coalesce(sum(${a}input_tokens),0)          as input_tokens,
  coalesce(sum(${a}cache_read_tokens),0)     as cache_read_tokens,
  coalesce(sum(${a}cache_creation_tokens),0) as cache_creation_tokens,
  coalesce(sum(${a}output_tokens),0)         as output_tokens,
  coalesce(sum(${a}cost_usd),0)              as cost_usd,
  ${pricedCurrencies()
    .map((c) => `coalesce(sum(case when ${a}cost_currency = '${c}' then ${a}cost_micro else 0 end),0) as money_${c}`)
    .join(',\n  ')},
  -- The gateway records a row per upstream call, the CLI one per turn.
  -- De-duplicating on turn_id is what makes "turns" mean the same thing either way
  count(distinct coalesce(${a}turn_id, cast(${a}id as text))) as turns,
  count(*)                                   as calls`;

/** The `money_<CODE>` columns, folded back into a map with the empty currencies left out */
function toMoney(r?: TotalsRow): Money {
  const out: Money = {};
  if (!r) return out;
  for (const key of Object.keys(r)) {
    if (!key.startsWith('money_')) continue;
    const code = key.slice(6);
    if (!CODE.test(code)) continue;
    const micro = Number(r[key] ?? 0);
    if (micro) out[code] = micro;
  }
  return out;
}

const toTotals = (r?: TotalsRow): Totals => totalsFrom(toMoney(r), r);

const totalsFrom = (money: Money, r?: TotalsRow): Totals => ({
  inputTokens: r?.input_tokens ?? 0,
  cacheReadTokens: r?.cache_read_tokens ?? 0,
  cacheCreationTokens: r?.cache_creation_tokens ?? 0,
  outputTokens: r?.output_tokens ?? 0,
  costUsd: r?.cost_usd ?? 0,
  cost: money,
  costSettled: settle(money),
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
 * them. "$4.20 remaining" answers nothing on its own — the same figure is two turns for one
 * person and forty for another, and which they are is not something they can work out. It is
 * derived from what they have actually spent rather than estimated
 * from the model and the context, because a turn's cost depends on how many upstream calls
 * the agent makes, which nobody can know in advance.
 *
 * The median, not the mean: a single runaway turn is exactly the thing somebody wants to
 * be warned about, and it is also the thing that would drag a mean far enough to stop the
 * warning being useful for the other twenty.
 *
 * Zero-cost rows are left out. A failed turn still gets a row, for debugging, and counting
 * those as cheap turns would say somebody has more room than they do. "Zero" is the turn's
 * whole cost, not one currency's share of it, so a turn that spent nothing on one upstream and
 * something on another still counts once, for what it cost.
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
  sample = 20,
  /** How far back to look. A month is long enough to have twenty turns in it and short
   *  enough that the scan stays small — and recent turns are the ones that predict. */
  since = new Date(Date.now() - 30 * 86_400_000).toISOString(),
): number | null {
  /*
   * Settled, not summed raw.
   *
   * This figure is divided into a remainder the gate counts in the settlement currency, so a
   * per-turn number that is a mixture of yuan and dollar micro-units answers a different
   * question from the one it is compared against — and on a yuan-heavy account it overstates
   * the turn by the whole exchange rate, telling somebody they have a fraction of the turns
   * the gate will actually let them have.
   */
  /*
   * Grouped by turn alone, with the currencies as conditional columns — the same trick, and
   * for the same reason, as `SUM()`.
   *
   * Adding `cost_currency` to the `group by` is what a first version did, and it splits a turn
   * that crossed two upstreams into two rows. Each half then enters the median as its own
   * cheaper "turn", and `limit 20` samples twenty halves rather than twenty turns — so the
   * remainder is reported as roughly twice the turns the gate will actually allow. It mattered
   * less when only cost-limited accounts took this path; every account takes it now.
   */
  const cols = pricedCurrencies();
  const rows = all<Record<string, number>>(
    `select ${cols
      .map((c) => `coalesce(sum(case when cost_currency = '${c}' then cost_micro else 0 end),0) as money_${c}`)
      .join(',\n           ')},
            sum(cost_micro) as spent
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
  const spent = rows
    .map((r) => settle(Object.fromEntries(cols.map((c) => [c, Number(r[`money_${c}`] ?? 0)]))))
    .sort((a, b) => a - b);
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
 * Keyed on the window's own boundary, which is the same instant for everybody — so one window
 * records one person once.
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
  const rows = all<TotalsRow & { model: string | null }>(
    `select coalesce(model, '') as model, ${SUM()}
       from usage_records
      where conversation_id = ?
         or conversation_id in (select id from conversations where parent_id = ?)
      group by coalesce(model, '')
      -- A stable tie-break only; what is shown is ordered by heaviestFirst, which settles
      -- the currencies first. SQL cannot: the rates are a setting, not a column.
      order by coalesce(model, '')`,
    conversationId,
    conversationId,
  ).map((r) => ({ model: r.model ?? '', ...toTotals(r) }));
  return heaviestFirst(rows);
}

export interface AgentBreakdown extends Totals {
  agent: string;
  model: string | null;
}

export function byAgentForUser(userId: string, range?: Range | string, only?: UpstreamFilter): AgentBreakdown[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only);
  const rows = all<TotalsRow & { agent: string; model: string | null }>(
    `select agent, model, ${SUM()} from usage_records
     where user_id = ? and created_at >= ? and created_at < ?${f.sql}
     group by agent, model order by agent, model`,
    userId,
    from,
    to,
    ...f.params,
  ).map((r) => ({ agent: r.agent, model: r.model, ...toTotals(r) }));
  return heaviestFirst(rows);
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
  const rows = all<TotalsRow & { provider_id: string | null; name: string | null; kind: string | null; credential_id: string | null }>(
    `select u.provider_id, p.name, p.kind, p.credential_id, ${SUM('u.')}
     from usage_records u left join upstream_providers p on p.id = u.provider_id
     where u.created_at >= ? and u.created_at < ?${mine}
     group by u.provider_id
     order by coalesce(p.name, '')`,
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
  return heaviestFirst(rows);
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
  const rows = all<TotalsRow & { provider_id: string | null; model: string | null }>(
    `select u.provider_id, coalesce(u.model, '') as model, ${SUM('u.')}
     from usage_records u
     where u.created_at >= ? and u.created_at < ?
     group by u.provider_id, coalesce(u.model, '')
     order by coalesce(u.provider_id, ''), coalesce(u.model, '')`,
    from,
    to,
  ).map((r) => ({
    providerId: r.provider_id ?? '',
    model: r.model ?? '',
    ...toTotals(r),
  }));
  return heaviestFirst(rows);
}

export function byConversationForUser(
  userId: string,
  limit = 20,
  range?: Range | string,
  only?: UpstreamFilter,
): ConversationUsage[] {
  const [from, to] = bounds(range);
  const f = onlyUpstream(only, 'u.');
  /*
   * The `limit` is applied here rather than in SQL, and that is the point of the slice.
   *
   * "The twenty heaviest" has to be chosen by the same figure it is then ordered by. Chosen in
   * SQL by `sum(cost_micro)` it would be the twenty largest raw sums across currencies, and
   * re-ordering those afterwards only rearranges a selection that already left the right
   * conversations out. One row per conversation, per user, over one period is small enough to
   * settle and cut here.
   */
  const rows = all<TotalsRow & { conversation_id: string; title: string; agent: string; updated_at: string }>(
    `select u.conversation_id, c.title, c.agent, c.updated_at, ${SUM('u.')}
     from usage_records u join conversations c on c.id = u.conversation_id
     where u.user_id = ? and u.created_at >= ? and u.created_at < ?${f.sql}
     group by u.conversation_id
     order by c.updated_at desc`,
    userId,
    from,
    to,
    ...f.params,
  ).map((r) => ({
    conversationId: r.conversation_id,
    title: r.title,
    agent: r.agent,
    updatedAt: r.updated_at,
    ...toTotals(r),
  }));
  return heaviestFirst(rows).slice(0, limit);
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
  const rows = all<TotalsRow & { user_id: string; username: string | null; email: string | null }>(
    `select u.user_id, us.username, us.email, ${SUM('u.')}
     from usage_records u left join users us on us.id = u.user_id
     where u.created_at >= ? and u.created_at < ?
     group by u.user_id
     order by coalesce(us.username, '')`,
    from,
    to,
  ).map((r) => ({
    userId: r.user_id,
    username: r.username ?? '',
    email: r.email ?? '',
    ...toTotals(r),
  }));
  return heaviestFirst(rows);
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
  /*
   * A factory, not an object. Spreading one object into every missing bucket gives them all
   * the same `cost` map, so folding money into a bucket in place writes through to its
   * neighbours — and, when the object was a module-level constant, to every later request in
   * the process. A shallow spread does not copy what it points at.
   */
  blank: () => Omit<T, 't'>,
): T[] {
  const keys = bucketKeys(from, to, unit);
  if (!keys) return rows;
  const hit = new Map(rows.map((r) => [r.t, r]));
  return keys.map((t) => hit.get(t) ?? ({ ...blank(), t } as T));
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

/**
 * A fresh one each time, and that is the whole point of it being a function.
 *
 * As a const it handed every padded bucket the *same* `cost` object. Folding money into a
 * bucket in place — the obvious idiom — then wrote through to the constant, and every empty
 * bucket of every later request in that process carried the leftovers.
 */
const emptyTotals = (): Totals => ({
  calls: 0, inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
  costUsd: 0, cost: {}, costSettled: 0, turns: 0,
});

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
  return padded(rows, from, to, unit, emptyTotals);
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
  return padded(rows, from, to, unit, emptyTotals);
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

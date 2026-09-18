import { all, get, nowIso, run } from './index.js';
import { getString, setSetting } from './settings.js';
import { isPeakAt, parsePeak, WEEKDAYS, type PeakWindows } from '../peak-hours.js';

/**
 * The price table: turning tokens into money.
 *
 * The CLI's own total_cost_usd is essentially always 0 against a third-party endpoint
 * (measured; see DESIGN.md §7.6), so cost has to be computed here as usage × unit price.
 *
 * Everything is in micro-units (1 unit = 1_000_000 micro-units). Floating point
 * accumulates error on money; integer micro-units are precise enough and do not drift.
 */

export const MICRO = 1_000_000;

export interface Pricing {
  id: number;
  /** A model name or prefix; '*' is the catch-all */
  model: string;
  currency: string;
  /** Micro-units per million tokens */
  /** Which upstream this price is for. Empty means any. */
  providerId: string;
  priceInput: number;
  priceCacheRead: number;
  priceCacheWrite: number;
  priceOutput: number;
  effectiveFrom: string;
  note?: string;
  /**
   * What the four prices are multiplied by inside the windows below. 1 means the row has no
   * time of day — which is every row but DeepSeek's.
   */
  peakMultiplier: number;
  peakWindows: PeakWindows | null;
  /**
   * Only set by resolve(), and only when the multiplier was actually applied to the numbers
   * on this object. list() never sets it: what that returns is what is stored, which is
   * what the console edits.
   */
  peakApplied?: boolean;
}

interface Row {
  id: number;
  model: string;
  currency: string;
  provider_id: string | null;
  price_input: number;
  price_cache_read: number;
  price_cache_write: number;
  price_output: number;
  effective_from: string;
  note: string | null;
  created_at: string;
  peak_multiplier: number | null;
  peak_windows: string | null;
}

const toPricing = (r: Row): Pricing => {
  let cached: PeakWindows | null = null;
  let parsed = false;
  return {
  id: r.id,
  model: r.model,
  currency: r.currency,
  providerId: r.provider_id ?? '',
  priceInput: r.price_input,
  priceCacheRead: r.price_cache_read,
  priceCacheWrite: r.price_cache_write,
  priceOutput: r.price_output,
  effectiveFrom: r.effective_from,
  note: r.note ?? undefined,
  // A row written before the column existed reads as "no time of day", which it was
  peakMultiplier: r.peak_multiplier ?? 1,
  /*
   * Parsed when somebody looks, not when the row is mapped.
   *
   * resolve() maps **every** row in the table — its query has no model predicate — and uses
   * one of them, and record() resolves four times for every usage row the gateway writes.
   * Parsing eagerly put a JSON.parse and a full validity walk on that path for each row
   * that carries a schedule. A row without one costs nothing either way, since parsePeak
   * returns on the empty string.
   */
  get peakWindows() {
    if (!parsed) {
      cached = parsePeak(r.peak_windows);
      parsed = true;
    }
    return cached;
  },
  };
};

/**
 * The same row with the time of day applied.
 *
 * Done here rather than at the call sites on purpose. There are four of them, they are the
 * whole of how money and quota are counted, and a call site that forgot would not fail —
 * it would bill the off-peak rate during peak hours and look exactly like one that
 * remembered. So resolve() answers "what this costs at that moment" and there is no second
 * function returning the other thing.
 */
function atMoment(p: Pricing, at: Date): Pricing {
  if (p.peakMultiplier === 1 || !isPeakAt(p.peakWindows, at)) return p;
  const x = p.peakMultiplier;
  return {
    ...p,
    priceInput: p.priceInput * x,
    priceCacheRead: p.priceCacheRead * x,
    priceCacheWrite: p.priceCacheWrite * x,
    priceOutput: p.priceOutput * x,
    peakApplied: true,
  };
}

export function list(): Pricing[] {
  return all<Row>('select * from model_pricing order by model, effective_from desc').map(toPricing);
}

export interface UpsertInput {
  model: string;
  /** The upstream this price applies to. Empty means any of them. */
  providerId?: string;
  currency?: string;
  priceInput: number;
  priceCacheRead: number;
  priceCacheWrite: number;
  priceOutput: number;
  effectiveFrom?: string;
  note?: string;
  /** Left out means 1: the price does not depend on the time of day */
  peakMultiplier?: number;
  peakWindows?: PeakWindows | null;
}

/** A price change inserts a row; past bills keep the price of their time and are never rewritten */
export function add(input: UpsertInput): Pricing {
  const result = run(
    `insert into model_pricing
       (model, provider_id, currency, price_input, price_cache_read, price_cache_write, price_output,
        effective_from, note, created_at, peak_multiplier, peak_windows)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.model.trim(),
    (input.providerId ?? '').trim() || null,
    input.currency ?? getString('billing.currency', 'USD'),
    Math.round(input.priceInput),
    Math.round(input.priceCacheRead),
    Math.round(input.priceCacheWrite),
    Math.round(input.priceOutput),
    input.effectiveFrom ?? nowIso(),
    input.note ?? null,
    nowIso(),
    input.peakMultiplier ?? 1,
    // A multiplier with no windows would never apply, and windows with no multiplier would
    // apply nothing. Storing neither unless both are present keeps the two from drifting.
    input.peakWindows && (input.peakMultiplier ?? 1) !== 1 ? JSON.stringify(input.peakWindows) : null,
  );
  // Return the row just written, not `list()[0]` — the list is ordered by
  // (model, effective_from), so its first row is arbitrary with respect to this
  // insert and any caller reading the returned `.id` got a wrong row.
  const row = get<Row>('select * from model_pricing where id = ?', Number(result.lastInsertRowid));
  return toPricing(row!);
}

export function remove(id: number): boolean {
  return run('delete from model_pricing where id = ?', id).changes > 0;
}

/**
 * The price that applied to a model at a moment, on the upstream that served it.
 *
 * Rows for that upstream are considered first, and rows with no upstream after them: the
 * same model offered by two providers can cost two different amounts, and a price without
 * a provider is the one that applies to whichever of them has nothing more specific.
 *
 * Within each of those two passes: exact match, then longest prefix, then the '*'
 * catch-all — so a new model does not need a price before it can be used.
 *
 * What comes back is **what to charge at `at`**, with any time-of-day surcharge already in
 * the four numbers and `peakApplied` set to say so. list() is the other view — the row as
 * stored, which is what the console edits. Two things called `priceInput` that mean
 * different numbers is a real hazard, and the way it is kept safe is that only one of them
 * is ever used for billing.
 */
export function resolve(
  model: string | null | undefined,
  at = nowIso(),
  providerId?: string | null,
): Pricing | undefined {
  const m = (model ?? '').trim();
  const rows = all<Row>(
    'select * from model_pricing where effective_from <= ? order by effective_from desc',
    at,
  ).map(toPricing);
  if (!rows.length) return undefined;

  /*
   * `at` is an ISO-8601 string in UTC — nowIso() everywhere in production — so this is the
   * same instant the row was selected by. Peak windows are stated in UTC by the vendor and
   * read in UTC by isPeakAt; nothing here touches the server's local zone, which is a
   * different clock entirely (DESIGN.md §16).
   */
  const moment = new Date(at);

  const pass = (candidates: Pricing[]): Pricing | undefined => {
    const exact = candidates.find((r) => r.model === m);
    if (exact) return exact;
    // Longest prefix wins: deepseek-v4-pro matches deepseek-v4, not deepseek
    const prefixes = candidates
      .filter((r) => r.model !== '*' && m.startsWith(r.model))
      .sort((a, b) => b.model.length - a.model.length);
    if (prefixes[0]) return prefixes[0];
    return candidates.find((r) => r.model === '*');
  };

  const provider = (providerId ?? '').trim();
  if (provider) {
    const mine = pass(rows.filter((r) => r.providerId === provider));
    if (mine) return atMoment(mine, moment);
  }
  const global = pass(rows.filter((r) => !r.providerId));
  return global && atMoment(global, moment);
}

export interface TokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** Cost in micro-units. No matching price returns 0, and the interface says the model is unpriced. */
/**
 * What a single input token of one model costs, in micro-units.
 *
 * The unit quota is measured in when `quota.pricingBaseline` names a model: every model's
 * spend is divided by this to get "tokens of the baseline model", which is a number an
 * administrator can set a ceiling in and compare across models.
 */
export function inputMicroPerToken(model: string, at?: string, providerId?: string | null): number {
  const p = resolve(model, at, providerId);
  return p ? p.priceInput / 1_000_000 : 0;
}

/**
 * The same sum, unrounded.
 *
 * A micro-unit is a millionth, and a cheap model's token is a fraction of one — a DeepSeek
 * input token is 0.435 of a micro. Rounding before the caller is done with the number turns
 * that into 0, and a caller that then treats 0 as "cannot price this" gets a cliff: quota
 * measured this way billed one token as 1, two through five as 0, and six as 1 again.
 */
export function costMicroExact(
  model: string | null | undefined,
  u: TokenCounts,
  at?: string,
  providerId?: string | null,
): number {
  const p = resolve(model, at, providerId);
  return p ? costOf(p, u) : 0;
}

/**
 * The same sum against a row already in hand.
 *
 * `resolve()` reads and maps the whole price table, and the two callers that need both the
 * row and its cost — `record()` on the per-turn path and the one-off recost — were doing it
 * twice for the same arguments.
 */
export function costOf(p: Pricing, u: TokenCounts): number {
  const per = (tokens: number, price: number) => (tokens * price) / 1_000_000;
  return (
    per(u.inputTokens, p.priceInput) +
    per(u.cacheReadTokens, p.priceCacheRead) +
    per(u.cacheCreationTokens, p.priceCacheWrite) +
    per(u.outputTokens, p.priceOutput)
  );
}

export function costMicro(
  model: string | null | undefined,
  u: TokenCounts,
  at?: string,
  providerId?: string | null,
): number {
  return Math.round(costMicroExact(model, u, at, providerId));
}

export const formatMoney = (micro: number, currency = 'USD'): string =>
  `${currency === 'CNY' ? '¥' : '$'}${(micro / MICRO).toFixed(4)}`;

/**
 * What every DeepSeek row has to say, because the number in it is only true for part of
 * the week. Shared so that correcting one row cannot leave another explaining itself
 * differently.
 */
export const DEEPSEEK_OFF_PEAK =
  'Off-peak. DeepSeek doubles this Mon–Fri 01:00–04:00 and 06:00–10:00 UTC.';

/**
 * DeepSeek's own schedule, stored on every row it prices.
 *
 * The seeded amounts are the off-peak ones, so the multiplier goes up rather than down —
 * which is also the safer direction to be wrong in: a row that lost its windows bills the
 * cheaper number, and undercharging is visible in the vendor's invoice, where overcharging
 * is only visible to the person who was overcharged.
 */
const PEAK = { peakMultiplier: 2, peakWindows: { days: WEEKDAYS, hours: [[1, 4], [6, 10]] as Array<[number, number]> } };

/** The name outlived the model behind it, and the bill follows the model */
export const DEEPSEEK_RETIRED =
  `Retired 2026-09-10 — served by V4.1-Flash and billed at its price. ${DEEPSEEK_OFF_PEAK}`;

/**
 * Seed DeepSeek's prices on first start.
 *
 * ⚠️ These numbers change. Check them against DeepSeek's own page and correct them in the
 * console before going live — the interface says so too.
 */
/**
 * The published list prices, each in the currency its vendor publishes it in.
 *
 * Units are micro-units per million tokens, so `$10 / MTok` is 10_000_000.
 *
 * Anthropic prices in dollars and DeepSeek in yuan, and both are kept at their own list
 * rather than converted: a converted number cannot be checked against an invoice, and it goes
 * stale the day the rate moves even though the vendor's price did not. `usage_records`
 * carries the currency of the row that priced it, so the amounts are never added across.
 *
 * Cache writes are the standard 1.25× input on Anthropic and free on DeepSeek — a miss there
 * is simply the input price. Cache reads are **not** a standard multiple, which is exactly the
 * sort of thing a table can hold and one global weight cannot.
 */
function seedRows(): UpsertInput[] {
  const now = nowIso();
  /*
   * Published list prices, in US dollars per million tokens.
   *
   * The same numbers the model picker shows — apps/web/src/lib/model-facts.ts — and
   * scripts/check-pricing.mjs fails the build when the two disagree. They have to agree:
   * one is what a user is told a model costs and the other is what they are charged, and
   * nothing else reconciles them.
   *
   * Cache write is the standard 1.25x input and cache read the standard tenth, with one
   * exception spelled out: Claude Fable reads its cache at a fortieth. That exception is
   * the reason quota reads a table instead of a global weight, so the table has to hold it.
   */
  const rate = (
    input: number,
    output: number,
    cacheRead = input / 10,
    // Anthropic charges a premium to write the cache. DeepSeek does not — a miss is simply
    // the input price — so that one is a parameter rather than a constant.
    cacheWrite = input * 1.25,
  ) => ({
    priceInput: Math.round(input * 1_000_000),
    priceCacheRead: Math.round(cacheRead * 1_000_000),
    priceCacheWrite: Math.round(cacheWrite * 1_000_000),
    priceOutput: Math.round(output * 1_000_000),
  });
  const seed: UpsertInput[] = [
    /*
     * The 0.025× cache read is **5.1's alone** — the pricing table's own footnote says so:
     * "Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at
     * 0.025x the base input price. All other models use the standard 0.1x multiplier."
     *
     * Both rows used to carry $0.25, which billed Fable 5's cache reads at a quarter of what
     * they cost. Worth spelling out rather than deriving, because the two rows are otherwise
     * identical and the next person to add a Fable will copy whichever line they see first.
     */
    { model: 'claude-fable-5-1', ...rate(10, 50, 0.25) },
    { model: 'claude-fable-5', ...rate(10, 50) },
    { model: 'claude-opus-5', ...rate(5, 25) },
    { model: 'claude-opus-4-8', ...rate(5, 25) },
    { model: 'claude-opus-4-7', ...rate(5, 25) },
    { model: 'claude-opus-4-6', ...rate(5, 25) },
    { model: 'claude-opus-4-5', ...rate(5, 25) },
    { model: 'claude-sonnet-5', ...rate(2, 10) },
    { model: 'claude-sonnet-4-6', ...rate(3, 15) },
    { model: 'claude-sonnet-4-5', ...rate(3, 15) },
    { model: 'claude-haiku-4-5', ...rate(1, 5) },
    /*
     * DeepSeek, as of 2026-09-10. Two things here are off the Anthropic pattern and both
     * are spelled out rather than derived: a cache read is a fiftieth of the input price
     * on flash and a thirtieth on pro, not the usual tenth; and a cache **write** costs
     * nothing extra, because a miss is just the input price.
     *
     * The amounts are the off-peak ones. DeepSeek doubles everything Monday to Friday,
     * 01:00–04:00 and 06:00–10:00 UTC, and a table row holds one number — so a deployment
     * serving peak hours is undercharging by half until the price table grows a time
     * dimension.
     */
    { model: 'deepseek-flash', currency: 'CNY', ...rate(1, 4, 0.02, 1), ...PEAK, note: DEEPSEEK_OFF_PEAK },
    { model: 'deepseek-v4-pro', currency: 'CNY', ...rate(4.5, 13.5, 0.15, 4.5), ...PEAK, note: DEEPSEEK_OFF_PEAK },
    // Retired on 2026-09-10. The name still resolves, and what answers is V4.1-Flash at
    // the flash price — so the row that keeps the bill right is the flash row, not the one
    // this model used to have. Written on one line like the rest because check-pricing.mjs
    // reads this shape, and a row it cannot parse is a row it silently stops comparing.
    { model: 'deepseek-v4-flash', currency: 'CNY', ...rate(1, 4, 0.02, 1), ...PEAK, note: DEEPSEEK_RETIRED },
    {
      // Also the unit quota is counted in: one billable token is one input token at this rate
      model: '*',
      ...rate(5, 25),
      note: 'The catch-all, used by any model without a price of its own — and the unit billable tokens are counted in',
    },
  ].map((r) => ({ currency: 'USD', ...r, effectiveFrom: now }));
  return seed;
}

/**
 * One flag, so the backfill above happens once rather than on every start.
 *
 * Written straight to the settings table rather than through `setSetting`, which validates
 * against the declared spec and would put this in the console among things an operator is
 * meant to change. This is bookkeeping.
 */
const SEEDED_KEY = 'pricing.backfilledAt';

function seedMark(value?: string): string {
  if (value !== undefined) {
    run(
      `insert into settings (key, value, updated_at) values (?, ?, ?)
       on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
      SEEDED_KEY, value, nowIso(),
    );
    return value;
  }
  return get<{ value: string }>('select value from settings where key = ?', SEEDED_KEY)?.value ?? '';
}

export function seedDefaults(): void {
  if (get('select 1 as x from model_pricing limit 1')) {
    // Non-empty is not the same as complete; see ensureSeedRows
    ensureSeedRows();
  } else {
    for (const s of seedRows()) add(s);
    seedMark('done');
    console.log(
      "[pricing] price table seeded — Claude in USD and DeepSeek in CNY, each at its vendor's own list. " +
        'Check the rates in the console, and add a row for any upstream that is neither.',
    );
  }
  /*
   * Last, and on both paths.
   *
   * A table holding two currencies is not comparable without a rate, and a ceiling needs one
   * number — so this has to happen whether the rows arrived from the seed or from the
   * backfill, and whether or not the backfill had anything to do. Behind either branch's
   * early return is how a deployment ends up counting every yuan as a dollar for ever.
   */
  ensureRates();
}

/**
 * Fill in the seed's rows that this table has never had.
 *
 * "Is the table empty" was the wrong question, and it cost a deployment its Claude prices:
 * migration 13 wrote three DeepSeek rows into an empty table, `seedDefaults()` saw a row and
 * returned, and the install then ran for months charging every Claude model at the catch-all
 * — opus and haiku, whose published prices differ fivefold, billed identically. The guard
 * added at the time patched the single worst symptom, the missing `*` row; this asks the
 * question that was meant all along.
 *
 * Only models with **no row at all** are added. A rate an operator has edited is theirs: the
 * published list is a starting point, not a correction to reapply on every start — reapplying
 * it is how the old migration layer used to rewrite working configurations.
 */
/**
 * A starting rate between the currencies the seed prices in, if there is none.
 *
 * It has to exist the moment a table holds two currencies: quota counts what a turn cost, and
 * without a rate a dollar of Opus and a yuan of DeepSeek are counted as the same money —
 * which under-charges the dollar side by most of its value and is only visible as a quota
 * that never bites.
 *
 * Derived from the vendors' own two lists rather than a market quote: DeepSeek publishes
 * flash at $0.15 and ¥1 per MTok for the same tokens, which is the rate it is willing to be
 * paid at. Both directions are written so the same map serves either settlement currency —
 * only the entry for a currency that is *not* the settlement one is ever read.
 *
 * Never overwritten. A rate is a decision with a date on it, and an operator who has set one
 * has made that decision.
 */
function ensureRates(): void {
  const current = getString('billing.rates', '').trim();
  if (current && current !== '{}') return;
  setSetting('billing.rates', JSON.stringify({ USD: 6.75, CNY: Number((1 / 6.75).toFixed(6)) }));
  console.log(
    '[pricing] no exchange rate was set and the table now prices in two currencies; ' +
      'seeded USD↔CNY at 6.75 from the vendors\' own lists. Check it in the console.',
  );
}

export function ensureSeedRows(): void {
  /*
   * Once, and then never again. The table cannot tell "never seeded" from "removed on
   * purpose", so what an operator deleted would come back on every restart — each time
   * backdated to 1970, claiming to have priced all of history.
   */
  if (seedMark() === 'done') return;
  /*
   * A model, whatever currency or upstream it is priced under, already has a price.
   *
   * Keyed on the name alone, and on every row rather than the unscoped ones. `resolve()` has
   * no notion of currency and takes whichever row is newer, so a second row for a model that
   * has one is not a second price — it is a decoy, listed in the console beside the real one.
   * Measured in production, which carried its own USD DeepSeek rows and came out of the
   * backfill with three CNY duplicates. Scoping the query to `provider_id is null` would
   * reintroduce it for anyone who prices per upstream: their models would read as unpriced,
   * get unscoped rows backdated to 1970, and the recost would then restate history they had
   * already reconciled. The catch-all needs no special case — it is a model name like the
   * rest, and this rule covers it.
   */
  const have = new Set(all<{ model: string }>('select model from model_pricing').map((r) => r.model));
  const missing = seedRows().filter((r) => !have.has(r.model));
  /*
   * Backdated, unlike the seed's own rows.
   *
   * `resolve()` filters on `effective_from <= at` so that a price change never restates an
   * old bill — right for a change, wrong for a backfill. These rows are not a new price; they
   * are the price the vendor was charging all along, for a model this table simply never had.
   * Stamped today they would be invisible to every row already written, and recosting history
   * would find nothing to correct — measured, on a real database: 66 rows, 0 changed.
   */
  const backfilled = missing.map((m) => ({
    ...m,
    effectiveFrom: '1970-01-01T00:00:00.000Z',
    note: [m.note, 'Backfilled: this model had no row, so its usage was costed at the catch-all.']
      .filter(Boolean).join(' '),
  }));
  for (const m of backfilled) add(m);
  /*
   * One mark, and only once the rows are in.
   *
   * An empty `missing` makes the loop above a no-op, so there is nothing to return early for
   * — and an early return would need a second mark, which is two places to keep one invariant
   * ("mark after the writes") and one of them to get wrong next time. Marking before the
   * writes is exactly the bug this line was moved to fix.
   */
  seedMark('done');
  if (missing.length) {
    console.log(
      `[pricing] ${missing.length} published price row(s) had never been seeded and were added ` +
        `(${missing.map((m) => `${m.model} ${m.currency ?? 'USD'}`).join(', ')}). Check them in the console.`,
    );
  }
}

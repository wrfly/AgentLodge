import { all, get, nowIso, run } from './index.js';
import { getString, setSetting } from './settings.js';

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
}

const toPricing = (r: Row): Pricing => ({
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
});

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
}

/** A price change inserts a row; past bills keep the price of their time and are never rewritten */
export function add(input: UpsertInput): Pricing {
  const result = run(
    `insert into model_pricing
       (model, provider_id, currency, price_input, price_cache_read, price_cache_write, price_output,
        effective_from, note, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    if (mine) return mine;
  }
  return pass(rows.filter((r) => !r.providerId));
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
  if (!p) return 0;
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

/** The name outlived the model behind it, and the bill follows the model */
export const DEEPSEEK_RETIRED =
  `Retired 2026-09-10 — served by V4.1-Flash and billed at its price. ${DEEPSEEK_OFF_PEAK}`;

/**
 * Seed DeepSeek's prices on first start.
 *
 * ⚠️ These numbers change. Check them against DeepSeek's own page and correct them in the
 * console before going live — the interface says so too.
 */
export function seedDefaults(): void {
  if (get('select 1 as x from model_pricing limit 1')) return;
  const now = nowIso();
  /*
   * Units are micro-units per million tokens, so `$10 / MTok` is 10_000_000.
   *
   * The published rates, which is more use than a placeholder: quota counts what a turn
   * cost, so an empty table would weigh every model alike, which is the thing that needed
   * fixing. Cache writes are the standard 1.25× input; cache reads are **not** a standard
   * multiple — Claude Fable reads at a fortieth of its input price where the rest of the
   * range is at a tenth, and that is exactly the sort of thing a table can hold and a
   * global weight cannot.
   *
   * An upstream that is not Anthropic — DeepSeek, a local model, a reseller — needs a row
   * of its own; until it has one it is costed at the catch-all below, which is Claude Opus
   * 5's rate. Every row here is in one currency on purpose: the amounts are summed.
   */
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
    { model: 'claude-fable-5-1', ...rate(10, 50, 0.25) },
    { model: 'claude-fable-5', ...rate(10, 50, 0.25) },
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
    { model: 'deepseek-flash', ...rate(0.15, 0.6, 0.003, 0.15), note: DEEPSEEK_OFF_PEAK },
    { model: 'deepseek-v4-pro', ...rate(0.66, 1.98, 0.022, 0.66), note: DEEPSEEK_OFF_PEAK },
    // Retired on 2026-09-10. The name still resolves, and what answers is V4.1-Flash at
    // the flash price — so the row that keeps the bill right is the flash row, not the one
    // this model used to have. Written on one line like the rest because check-pricing.mjs
    // reads this shape, and a row it cannot parse is a row it silently stops comparing.
    { model: 'deepseek-v4-flash', ...rate(0.15, 0.6, 0.003, 0.15), note: DEEPSEEK_RETIRED },
    {
      // Also the unit quota is counted in: one billable token is one input token at this rate
      model: '*',
      ...rate(5, 25),
      note: 'The catch-all, used by any model without a price of its own — and the unit billable tokens are counted in',
    },
  ].map((r) => ({ ...r, currency: 'USD', effectiveFrom: now }));
  for (const s of seed) add(s);
  setSetting('billing.currency', 'USD');
  console.log('[pricing] price table seeded in USD — check the rates in the console, and add a row for any upstream that is not Anthropic');
}

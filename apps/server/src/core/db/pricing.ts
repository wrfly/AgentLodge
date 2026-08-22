import { all, get, nowIso, run } from './index.js';
import { getString } from './settings.js';

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
  run(
    `insert into model_pricing
       (model, currency, price_input, price_cache_read, price_cache_write, price_output,
        effective_from, note, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.model.trim(),
    input.currency ?? getString('billing.currency', 'CNY'),
    Math.round(input.priceInput),
    Math.round(input.priceCacheRead),
    Math.round(input.priceCacheWrite),
    Math.round(input.priceOutput),
    input.effectiveFrom ?? nowIso(),
    input.note ?? null,
    nowIso(),
  );
  return list()[0]!;
}

export function remove(id: number): boolean {
  return run('delete from model_pricing where id = ?', id).changes > 0;
}

/**
 * The price that applied to a model at a moment.
 *
 * Exact match first, then longest prefix, then the '*' catch-all — so a new model does
 * not need a price before it can be used.
 */
export function resolve(model: string | null | undefined, at = nowIso()): Pricing | undefined {
  const m = (model ?? '').trim();
  const rows = all<Row>(
    'select * from model_pricing where effective_from <= ? order by effective_from desc',
    at,
  ).map(toPricing);
  if (!rows.length) return undefined;

  const exact = rows.find((r) => r.model === m);
  if (exact) return exact;

  // Longest prefix wins: deepseek-v4-pro matches deepseek-v4, not deepseek
  const prefixes = rows
    .filter((r) => r.model !== '*' && m.startsWith(r.model))
    .sort((a, b) => b.model.length - a.model.length);
  if (prefixes[0]) return prefixes[0];

  return rows.find((r) => r.model === '*');
}

export interface TokenCounts {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
}

/** Cost in micro-units. No matching price returns 0, and the interface says the model is unpriced. */
export function costMicro(model: string | null | undefined, u: TokenCounts, at?: string): number {
  const p = resolve(model, at);
  if (!p) return 0;
  const per = (tokens: number, price: number) => (tokens * price) / 1_000_000;
  return Math.round(
    per(u.inputTokens, p.priceInput) +
      per(u.cacheReadTokens, p.priceCacheRead) +
      per(u.cacheCreationTokens, p.priceCacheWrite) +
      per(u.outputTokens, p.priceOutput),
  );
}

export const formatMoney = (micro: number, currency = 'CNY'): string =>
  `${currency === 'CNY' ? '¥' : '$'}${(micro / MICRO).toFixed(4)}`;

/**
 * Seed DeepSeek's prices on first start.
 *
 * ⚠️ These numbers change. Check them against DeepSeek's own page and correct them in the
 * console before going live — the interface says so too.
 */
export function seedDefaults(): void {
  if (get('select 1 as x from model_pricing limit 1')) return;
  const now = nowIso();
  const seed: UpsertInput[] = [
    {
      model: 'deepseek',
      currency: 'CNY',
      priceInput: 2_000_000,       // ¥2 / 1M
      priceCacheRead: 200_000,     // ¥0.2 / 1M
      priceCacheWrite: 2_000_000,
      priceOutput: 3_000_000,      // ¥3 / 1M
      effectiveFrom: now,
      note: 'A default — check against DeepSeek\'s own page and correct it',
    },
    {
      model: '*',
      currency: 'CNY',
      priceInput: 2_000_000,
      priceCacheRead: 200_000,
      priceCacheWrite: 2_000_000,
      priceOutput: 3_000_000,
      effectiveFrom: now,
      note: 'The catch-all, used by any model without a price of its own',
    },
  ];
  for (const s of seed) add(s);
  console.log('[pricing] default price table seeded — check the real unit prices in the console');
}

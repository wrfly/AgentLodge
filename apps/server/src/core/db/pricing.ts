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
    input.currency ?? getString('billing.currency', 'CNY'),
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
export function costMicro(
  model: string | null | undefined,
  u: TokenCounts,
  at?: string,
  providerId?: string | null,
): number {
  const p = resolve(model, at, providerId);
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

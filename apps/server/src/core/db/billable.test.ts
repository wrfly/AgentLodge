/**
 * What a token costs, and what it draws — two questions, and they stopped being one.
 *
 * Flat weights treat every model's tokens alike, and across one vendor's range the prices
 * differ by a factor of ten: Claude Fable is $10/$50 per MTok against Haiku's $1/$5. So the
 * **cost** of a turn comes out of the price table, model by model, including the case no
 * single weight can express — Fable reads its cache at a fortieth of its input price where
 * the rest of the range sits at a tenth.
 *
 * Quota used to be that cost divided by the catch-all's input price, which gave a token count
 * that tracked price. That stopped working when two vendors began billing in two currencies:
 * dividing each turn by the catch-all of its own currency makes DeepSeek's cheapest model draw
 * exactly what Opus draws — it *is* the yuan catch-all — and converting instead makes every
 * user's ceiling move when an exchange rate does. A token count cannot carry a price.
 *
 * So a token ceiling counts weighted tokens, in no currency, and a ceiling that should track
 * price is a **cost** ceiling — one number, in the settlement currency, which is the one place
 * an exchange rate belongs. This file pins both halves.
 *
 * Run: npm -w @agentlodge/server run test:billable
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-billable-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('./index.js');
initDb();
const pricing = await import('./pricing.js');
const { billable } = await import('./usage.js');
import type { TurnUsage } from '../protocol.js';

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** Micro-units per million tokens, so `$10 / MTok` is 10 × 1e6 */
const perM = (dollars: number) => Math.round(dollars * 1_000_000);

for (const p of pricing.list()) pricing.remove(p.id);
const now = new Date().toISOString();
// The published rates. Fable's cache read is the interesting one: a fortieth of its input
// price, where the rest of the range sits at a tenth.
pricing.add({ model: 'claude-fable-5-1', currency: 'USD', priceInput: perM(10), priceCacheRead: perM(0.25), priceCacheWrite: perM(12.5), priceOutput: perM(50), effectiveFrom: now });
pricing.add({ model: 'claude-opus-5', currency: 'USD', priceInput: perM(5), priceCacheRead: perM(0.5), priceCacheWrite: perM(6.25), priceOutput: perM(25), effectiveFrom: now });
pricing.add({ model: 'claude-haiku-4-5', currency: 'USD', priceInput: perM(1), priceCacheRead: perM(0.1), priceCacheWrite: perM(1.25), priceOutput: perM(5), effectiveFrom: now });
// DeepSeek, in its own money: the case that broke deriving a token count from a price
pricing.add({ model: 'deepseek-flash', currency: 'CNY', priceInput: perM(1), priceCacheRead: perM(0.02), priceCacheWrite: perM(1), priceOutput: perM(4), effectiveFrom: now });
pricing.add({ model: '*', currency: 'USD', priceInput: perM(5), priceCacheRead: perM(0.5), priceCacheWrite: perM(6.25), priceOutput: perM(25), effectiveFrom: now });

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUsd: 0, durationMs: 0, numTurns: 1, ...over,
});

console.log('\n=== What a turn costs is what the model costs, with nothing to turn on ===');
{
  const c = (model: string, u: TurnUsage) => pricing.costMicro(model, u);
  const input = usage({ inputTokens: 1_000_000 });

  ok('an unpriced model is costed by the catch-all', c('anything-unpriced', input) === perM(5), String(c('anything-unpriced', input)));
  ok('Opus, priced the same as the catch-all, matches it', c('claude-opus-5', input) === perM(5), String(c('claude-opus-5', input)));
  ok('Fable, at twice the price, is twice', c('claude-fable-5-1', input) === perM(10), String(c('claude-fable-5-1', input)));
  ok('Haiku, at a fifth, is a fifth', c('claude-haiku-4-5', input) === perM(1), String(c('claude-haiku-4-5', input)));

  // The whole point: the same work on a costlier model costs more
  ok('so the same turn on Fable costs ten times what it costs on Haiku',
    c('claude-fable-5-1', input) === c('claude-haiku-4-5', input) * 10);

  const output = usage({ outputTokens: 1_000_000 });
  ok('output counts at its own price, five times input', c('claude-opus-5', output) === perM(25), String(c('claude-opus-5', output)));

  /*
   * The case no single global weight can express. Every other model reads its cache at a
   * tenth of input; Fable reads it at a fortieth.
   */
  const cached = usage({ cacheReadTokens: 1_000_000 });
  ok('a cache read on Opus is a tenth of its input', c('claude-opus-5', cached) === perM(0.5), String(c('claude-opus-5', cached)));
  ok('and on Fable a fortieth, which the weights cannot say', c('claude-fable-5-1', cached) === perM(0.25), String(c('claude-fable-5-1', cached)));
}

console.log('\n=== Each vendor in its own money, never added together ===');
{
  const input = usage({ inputTokens: 1_000_000 });
  ok('Claude is priced in dollars', pricing.resolve('claude-opus-5')?.currency === 'USD');
  ok('DeepSeek in yuan', pricing.resolve('deepseek-flash')?.currency === 'CNY');
  /*
   * The numbers are close — $5 against ¥1 — and that is exactly why they must not be summed:
   * the figures alone give no hint which money they are, so a total that added them would
   * look entirely plausible and be wrong by most of its value.
   */
  ok('and the two figures carry no clue of their own',
    pricing.costMicro('claude-opus-5', input) === perM(5)
      && pricing.costMicro('deepseek-flash', input) === perM(1));
}

console.log('\n=== A bigger call never costs less than a smaller one ===');
{
  /*
   * A micro-unit is a millionth, and a cheap model's token is a fraction of one — a DeepSeek
   * input token is 0.435 of a micro. Rounding each call independently is what put a cliff in
   * the middle of the scale, and `costMicro` rounds once at the end for this reason.
   */
  pricing.add({ model: 'cheap', currency: 'USD', priceInput: 435_000, priceCacheRead: 43_500, priceCacheWrite: 435_000, priceOutput: 1_740_000, effectiveFrom: now });
  const at = (n: number) => pricing.costMicro('cheap', usage({ inputTokens: n }));
  const curve = [1, 2, 3, 4, 5, 6, 7, 10, 100].map(at);
  ok('the curve never goes down', curve.every((v, i) => i === 0 || v >= curve[i - 1]!), curve.join(', '));
  ok('and one token never costs more than five', at(1) <= at(5), `${at(1)} vs ${at(5)}`);
  ok('a cheap model stays cheap', at(1_000_000) < perM(1) && at(1_000_000) > 0, String(at(1_000_000)));
}

console.log('\n=== A token ceiling counts tokens, and only tokens ===');
{
  const input = usage({ inputTokens: 1_000_000 });
  /*
   * No model, no currency, no price table. The weights correct the one distortion that is
   * about tokens rather than about money — a cache hit is not an ordinary input token, and
   * an output token is not either.
   */
  ok('a million input tokens is a million', billable(input) === 1_000_000, String(billable(input)));
  ok('the most expensive model weighs the same', billable(input, 'claude-fable-5-1') === 1_000_000,
    String(billable(input, 'claude-fable-5-1')));
  ok('and so does the cheapest, in another currency', billable(input, 'deepseek-flash') === 1_000_000,
    String(billable(input, 'deepseek-flash')));

  ok('a cache read weighs a tenth', billable(usage({ cacheReadTokens: 1_000_000 })) === 100_000,
    String(billable(usage({ cacheReadTokens: 1_000_000 }))));
  ok('an output token half again as much as an input one',
    billable(usage({ outputTokens: 1_000_000 })) === 1_500_000,
    String(billable(usage({ outputTokens: 1_000_000 }))));

  /*
   * It does not consult the table at all, which is what makes it survive an empty one. The
   * old price-derived count fell back to these same weights when the table could not answer;
   * now there is no fall to take.
   */
  const kept = pricing.list();
  for (const p of kept) pricing.remove(p.id);
  ok('an empty price table changes nothing', billable(input) === 1_000_000, String(billable(input)));
  ok('while costing it now yields nothing, which is the table\'s job to fix',
    pricing.costMicro('claude-fable-5-1', input) === 0,
    String(pricing.costMicro('claude-fable-5-1', input)));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

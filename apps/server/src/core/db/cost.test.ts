/**
 * What a turn costs: the price table, model by model, and nothing else.
 *
 * There used to be a second answer beside it — a weighted token count, which quota was
 * measured in. Both halves lived in this file because the whole difficulty was that they
 * disagreed. They disagreed because a token count cannot carry a price: across one vendor's
 * range the prices differ by a factor of ten, and across two vendors they are not even in
 * the same money. Quota is money now, so there is one answer, and this is it.
 *
 * Kept from the old file: everything about the table, including the case no single weight
 * could ever have expressed — Fable reads its cache at a fortieth of its input price where
 * the rest of the range sits at a tenth.
 *
 * Run: npm -w @agentlodge/server run test:cost
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-cost-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('./index.js');
initDb();
const pricing = await import('./pricing.js');
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
   * The case no single global ratio could express — which is why the table carries four
   * prices per model rather than one. Every other model reads its cache at a tenth of
   * input; Fable reads it at a fortieth.
   */
  const cached = usage({ cacheReadTokens: 1_000_000 });
  ok('a cache read on Opus is a tenth of its input', c('claude-opus-5', cached) === perM(0.5), String(c('claude-opus-5', cached)));
  ok('and on Fable a fortieth, which no single ratio could have said', c('claude-fable-5-1', cached) === perM(0.25), String(c('claude-fable-5-1', cached)));
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

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

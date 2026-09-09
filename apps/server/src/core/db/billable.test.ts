/**
 * What a token costs the quota, and why that has to depend on the model.
 *
 * Flat weights treat every model's tokens alike. Across one vendor's range the prices
 * behind them differ by a factor of ten — Claude Fable is $10/$50 per MTok against Haiku's
 * $1/$5 — so somebody working on the expensive model spends ten times as much and, under
 * flat weights, draws exactly as much quota. Naming a baseline model converts every model's
 * tokens to that model's input-token equivalent, out of the price table, which is where the
 * real numbers already live.
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
const { setSetting } = await import('./settings.js');
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

const usage = (over: Partial<TurnUsage> = {}): TurnUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
  costUsd: 0, durationMs: 0, numTurns: 1, ...over,
});

console.log('\n=== Without a baseline, nothing changes ===');
{
  setSetting('quota.pricingBaseline', '');
  const u = usage({ inputTokens: 1000, outputTokens: 1000 });
  // input 1× + output 1.5×, the weights that were always there
  ok('the flat weights still apply', billable(u, 'claude-fable-5-1') === 2500, String(billable(u, 'claude-fable-5-1')));
  ok('and the model makes no difference to them', billable(u, 'claude-haiku-4-5') === billable(u, 'claude-fable-5-1'));
}

console.log('\n=== With one, a token costs what the model costs ===');
{
  setSetting('quota.pricingBaseline', 'claude-opus-5');
  const m = (model: string, u: TurnUsage) => billable(u, model);

  const input = usage({ inputTokens: 1_000_000 });
  ok('a million input tokens of the baseline is a million', m('claude-opus-5', input) === 1_000_000, String(m('claude-opus-5', input)));
  ok('the same on Fable, at twice the price, is two million', m('claude-fable-5-1', input) === 2_000_000, String(m('claude-fable-5-1', input)));
  ok('and on Haiku, at a fifth, is two hundred thousand', m('claude-haiku-4-5', input) === 200_000, String(m('claude-haiku-4-5', input)));

  // The whole point: the same work on a costlier model draws more of the ceiling
  ok(
    'so the same turn on Fable draws ten times what it draws on Haiku',
    m('claude-fable-5-1', input) === m('claude-haiku-4-5', input) * 10,
  );

  const output = usage({ outputTokens: 1_000_000 });
  ok('output counts at its own price, five times input', m('claude-opus-5', output) === 5_000_000, String(m('claude-opus-5', output)));

  /*
   * The case no single global weight can express. Every other model reads its cache at a
   * tenth of input; Fable reads it at a fortieth. Under flat weights both are 0.1.
   */
  const cached = usage({ cacheReadTokens: 1_000_000 });
  ok('a cache read on Opus is a tenth of its input', m('claude-opus-5', cached) === 100_000, String(m('claude-opus-5', cached)));
  ok('and on Fable a fortieth, which the weights cannot say', m('claude-fable-5-1', cached) === 50_000, String(m('claude-fable-5-1', cached)));
}

console.log('\n=== A model with no price is not a free model ===');
{
  setSetting('quota.pricingBaseline', 'claude-opus-5');
  const u = usage({ inputTokens: 1000, outputTokens: 1000 });
  // Falling through to zero would let a mispriced table hand somebody unlimited use
  ok('an unpriced model falls back to the weights', billable(u, 'something-nobody-priced') === 2500, String(billable(u, 'something-nobody-priced')));
  ok('so does a turn with no model recorded at all', billable(u) === 2500, String(billable(u)));

  setSetting('quota.pricingBaseline', 'a-model-with-no-price-row');
  ok('and so does a baseline that is not priced either', billable(u, 'claude-fable-5-1') === 2500, String(billable(u, 'claude-fable-5-1')));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

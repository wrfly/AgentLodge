/**
 * Two vendors, two currencies, and the amounts never added together.
 *
 * Anthropic prices in dollars and DeepSeek in yuan. The price table holds each at its own
 * published list rather than converting, because a converted figure cannot be checked against
 * an invoice and goes stale the day a rate moves — which means `sum(cost_micro)` across the
 * table is a number nothing in the world corresponds to. Every usage row carries the currency
 * of the row that priced it, every aggregate reports a map, and the only place the two are
 * ever collapsed is against a ceiling, which is one number by nature.
 *
 * What this pins:
 *
 * - a turn is costed and stamped in its vendor's currency, breakdowns keep them apart, and a
 *   breakdown's currencies add up to the total's currency by currency;
 * - the settled figure uses the configured rate, and says so loudly when there is none rather
 *   than quietly counting a dollar as a yuan;
 * - the recost restates money from the table without touching a single token count, and runs
 *   once;
 * - a price backfilled for a model that never had a row reaches the rows already written,
 *   which is what `effective_from` would otherwise prevent.
 *
 * Run: npm -w @agentlodge/server run test:currency
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-currency-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const db = await import('./index.js');
db.initDb();
const pricing = await import('./pricing.js');
const usage = await import('./usage.js');
const users = await import('./users.js');
const settings = await import('./settings.js');

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

/**
 * Two money maps holding the same amounts.
 *
 * Not `JSON.stringify`, which is key-order dependent: the aggregate's columns come back
 * sorted and a hand-rolled fold comes back in row-encounter order, so two identical figures
 * compare unequal depending on which currency was spent first.
 */
const sameMoney = (a: Record<string, number>, b: Record<string, number>): boolean => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] ?? 0) !== (b[k] ?? 0)) return false;
  return true;
};

const perM = (n: number) => Math.round(n * 1_000_000);
const alice = users.create({ email: 'a@example.com', username: 'alice', passwordHash: 'x', role: 'user' }).id;

for (const p of pricing.list()) pricing.remove(p.id);
const long_ago = '2000-01-01T00:00:00.000Z';
pricing.add({ model: 'claude-opus-5', currency: 'USD', priceInput: perM(5), priceCacheRead: perM(0.5), priceCacheWrite: perM(6.25), priceOutput: perM(25), effectiveFrom: long_ago });
pricing.add({ model: 'deepseek-flash', currency: 'CNY', priceInput: perM(1), priceCacheRead: perM(0.02), priceCacheWrite: perM(1), priceOutput: perM(4), effectiveFrom: long_ago });
pricing.add({ model: '*', currency: 'USD', priceInput: perM(5), priceCacheRead: perM(0.5), priceCacheWrite: perM(6.25), priceOutput: perM(25), effectiveFrom: long_ago });

const spend = (model: string, inputTokens: number, turnId: string) =>
  usage.record({
    userId: alice, agent: 'claude', model, turnId, status: 'completed',
    usage: { inputTokens, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
             costUsd: 0, durationMs: 1, numTurns: 1 },
  });

console.log('\n=== A turn is costed and stamped in its vendor\'s own money ===');
{
  spend('claude-opus-5', 1_000_000, 't1');      // $5
  spend('deepseek-flash', 2_000_000, 't2');     // ¥2

  const t = usage.totalsForUser(alice);
  ok('two currencies, two entries', Object.keys(t.cost).sort().join(',') === 'CNY,USD',
    JSON.stringify(t.cost));
  ok('the dollar side is the dollar price', t.cost['USD'] === perM(5), String(t.cost['USD']));
  ok('the yuan side is the yuan price', t.cost['CNY'] === perM(2), String(t.cost['CNY']));
  /*
   * $5 and ¥2 — close enough that a total adding them would look entirely plausible. That is
   * the whole reason they are kept apart: neither figure carries a clue of its own, so only
   * the key it is filed under says which money it is.
   */
  ok('each amount is filed under the money it is in, not merged',
    Object.keys(t.cost).length === 2 && t.cost['USD'] !== t.cost['CNY'], JSON.stringify(t.cost));
  const rows = db.all<{ cost_currency: string; model: string }>(
    'select model, cost_currency from usage_records order by turn_id');
  ok('and the stored row says so too',
    rows.find((r) => r.model === 'claude-opus-5')?.cost_currency === 'USD'
      && rows.find((r) => r.model === 'deepseek-flash')?.cost_currency === 'CNY',
    JSON.stringify(rows));
}

console.log('\n=== A breakdown keeps them apart, and adds up currency by currency ===');
{
  const total = usage.totalsForUser(alice);
  const rows = usage.byAgentForUser(alice);
  const summed: Record<string, number> = {};
  for (const r of rows) for (const [c, v] of Object.entries(r.cost)) summed[c] = (summed[c] ?? 0) + v;
  ok('each row carries one currency', rows.every((r) => Object.keys(r.cost).length === 1),
    JSON.stringify(rows.map((r) => [r.model, r.cost])));
  ok('and they add up to the total, currency by currency',
    sameMoney(summed, total.cost),
    `${JSON.stringify(summed)} vs ${JSON.stringify(total.cost)}`);
}

console.log('\n=== Collapsing to one number happens once, against a ceiling ===');
{
  settings.setSetting('billing.currency', 'CNY');
  settings.setSetting('billing.rates', JSON.stringify({ USD: 7 }));
  const t = usage.totalsForUser(alice);
  // ¥2 stays ¥2; $5 becomes ¥35
  ok('the settled figure uses the configured rate', t.costSettled === perM(37), String(t.costSettled));
  ok('while the map is untouched by it',
    t.cost['USD'] === perM(5) && t.cost['CNY'] === perM(2), JSON.stringify(t.cost));

  settings.setSetting('billing.rates', JSON.stringify({ USD: 14 }));
  ok('changing the rate changes what a ceiling sees', usage.totalsForUser(alice).costSettled === perM(72),
    String(usage.totalsForUser(alice).costSettled));
  ok('and nothing stored moved', usage.totalsForUser(alice).cost['USD'] === perM(5));

  /*
   * No rate at all counts the foreign side at par, which under-charges — but it is said out
   * loud on the way past. Dropping the currency instead would make spend vanish from a
   * ceiling, which is the same bug with no warning attached.
   */
  settings.setSetting('billing.rates', '{}');
  ok('with no rate it is counted at par rather than dropped',
    usage.totalsForUser(alice).costSettled === perM(7), String(usage.totalsForUser(alice).costSettled));
  settings.setSetting('billing.rates', JSON.stringify({ USD: 7 }));
}

console.log('\n=== The recost restates money and leaves every token alone ===');
{
  const before = usage.totalsForUser(alice);

  // A price this table never had, for a model already used. Backdated, the way ensureSeedRows
  // writes a backfill — stamped "from now" it would be invisible to the rows already written.
  db.run("update usage_records set cost_micro = 999, cost_currency = 'USD', model = 'gpt-5' where turn_id = 't2'");
  pricing.add({ model: 'gpt-5', currency: 'CNY', priceInput: perM(3), priceCacheRead: perM(0.3), priceCacheWrite: perM(3), priceOutput: perM(12), effectiveFrom: long_ago });

  usage.repriceHistory();
  const after = usage.totalsForUser(alice);

  ok('the wrong figure was restated', after.cost['CNY'] === perM(6), JSON.stringify(after.cost));
  ok('in the currency of the row that priced it', Object.keys(after.cost).sort().join(',') === 'CNY,USD',
    JSON.stringify(after.cost));
  ok('and every token count is exactly where it was',
    after.inputTokens === before.inputTokens
      && after.cacheReadTokens === before.cacheReadTokens
      && after.cacheCreationTokens === before.cacheCreationTokens
      && after.outputTokens === before.outputTokens,
    `${after.inputTokens}/${after.outputTokens} vs ${before.inputTokens}/${before.outputTokens}`);

  // Once. A second call must not re-walk the table on every start.
  db.run("update usage_records set cost_micro = 1 where turn_id = 't2'");
  usage.repriceHistory();
  ok('and it does not run twice', usage.totalsForUser(alice).cost['CNY'] === 1,
    JSON.stringify(usage.totalsForUser(alice).cost));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

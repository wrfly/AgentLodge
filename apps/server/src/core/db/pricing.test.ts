/**
 * The price table and, in particular, what `add` returns.
 *
 * `add` used to answer `list()[0]!` — the first row in (model, effective_from) order —
 * which is only the row just inserted by coincidence. A caller reading the returned
 * `.id` for a later `remove` would have pointed at an arbitrary row. This pins the
 * contract: `add` returns the row it wrote.
 *
 * Run: npm -w @agentlodge/server run test:pricing
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The database path is read from the environment at module load, so point it at a
// fresh directory before importing anything that touches the db.
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-pricing-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('./index.js');
initDb();
const { add, list, remove, resolve } = await import('./pricing.js');

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

console.log('\n=== add returns the row it wrote ===');
{
  // An alphabetically-last model name, so that `list()[0]` (first by model name) would
  // be somebody else's row if the bug were still present.
  add({ model: 'aaa', priceInput: 1_000_000, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 1_000_000 });
  const zebra = add({ model: 'zebra', priceInput: 2_000_000, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 3_000_000 });

  ok('the returned row is the one just inserted', zebra.model === 'zebra', `model=${zebra.model}`);

  const listed = list().filter((p) => p.model === 'zebra');
  ok('the returned id exists in the table', listed.some((p) => p.id === zebra.id), `id=${zebra.id}`);

  // The id must be removable — the caller uses it for DELETE.
  ok('the returned id removes the right row', remove(zebra.id), `id=${zebra.id}`);
  ok('and that row is gone', !list().some((p) => p.id === zebra.id));

  // The alphabetically-first row must be untouched by the removal.
  ok('the other row is still there', list().some((p) => p.model === 'aaa'));
}

console.log('\n=== per-provider pricing resolves, unmatched falls to catch-all ===');
{
  add({ model: 'shared', providerId: 'p1', priceInput: 100, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 100 });
  add({ model: '*', priceInput: 500, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 500 });

  const specific = resolve('shared', undefined, 'p1');
  ok('a provider-specific price wins for that provider', specific?.providerId === 'p1', JSON.stringify(specific));

  // A provider with no row of its own falls back to the provider-agnostic catch-all,
  // which is the documented behaviour (and the reason the seeded "*" exists).
  const generic = resolve('shared', undefined, 'p2');
  ok('an unmatched provider falls to the global catch-all', generic?.model === '*', JSON.stringify(generic));
}

console.log('\n=== a price with a time of day ===');
{
  const { costMicroExact } = await import('./pricing.js');
  const { WEEKDAYS } = await import('../peak-hours.js');

  // Back-dated so that the instants queried below are after it — resolve() only considers
  // rows already in effect, and add() otherwise stamps the row with now.
  add({
    model: 'peaky',
    priceInput: 1_000,
    priceCacheRead: 100,
    priceCacheWrite: 1_000,
    priceOutput: 4_000,
    effectiveFrom: '2020-01-01T00:00:00.000Z',
    peakMultiplier: 2,
    peakWindows: { days: WEEKDAYS, hours: [[1, 4]] },
  });

  // 2026-09-14 is a Monday in UTC
  const PEAK = '2026-09-14T02:00:00.000Z';
  const QUIET = '2026-09-14T05:00:00.000Z';

  const peak = resolve('peaky', PEAK);
  ok('inside the window every price is multiplied', peak?.priceInput === 2_000 && peak?.priceOutput === 8_000,
    JSON.stringify({ in: peak?.priceInput, out: peak?.priceOutput }));
  ok('including the cache prices', peak?.priceCacheRead === 200 && peak?.priceCacheWrite === 2_000);
  ok('and it says that it did', peak?.peakApplied === true);

  const quiet = resolve('peaky', QUIET);
  ok('outside it, the stored price stands', quiet?.priceInput === 1_000 && quiet?.priceOutput === 4_000);
  ok('and it does not claim otherwise', !quiet?.peakApplied);

  // The console edits what is stored, so list() must never show the multiplied number —
  // otherwise saving the row back would double it again.
  const stored = list().find((p) => p.model === 'peaky');
  ok('list() shows the stored price, not the current one', stored?.priceInput === 1_000, String(stored?.priceInput));
  ok('and carries the schedule for the console to render', stored?.peakMultiplier === 2 && !!stored?.peakWindows);

  // What it is all for: the money follows.
  const u = { inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };
  ok('a turn inside the window costs double', costMicroExact('peaky', u, PEAK) === 2 * costMicroExact('peaky', u, QUIET),
    `${costMicroExact('peaky', u, PEAK)} vs ${costMicroExact('peaky', u, QUIET)}`);

  // A row with a multiplier but no windows would apply everywhere or nowhere depending on
  // how it was read; add() refuses to store the pair half-set.
  add({ model: 'half-set', priceInput: 500, priceCacheRead: 0, priceCacheWrite: 0, priceOutput: 500,
        effectiveFrom: '2020-01-01T00:00:00.000Z', peakMultiplier: 2 });
  ok('a multiplier with no windows is stored as no schedule', !list().find((p) => p.model === 'half-set')?.peakWindows);
  ok('and never applies', resolve('half-set', PEAK)?.priceInput === 500);
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

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

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

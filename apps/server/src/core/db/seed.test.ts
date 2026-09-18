/**
 * What a brand-new install comes up with.
 *
 * Nothing asked this before, and the gap had a shape: pricing.test.ts calls initDb() and
 * then inserts its own rows, schema.test.ts checks columns and indexes, and upgrade.test.ts
 * checks that an older file survives. All three were green while a fresh database was
 * coming up with three DeepSeek prices, no Claude prices and no '*' catch-all.
 *
 * How that happened is worth keeping, because the next data migration can do it again.
 * initDb() runs migrate() twice: before schema.sql to repair an existing file, and after it
 * to stamp the version on a new one. Migration 13 was a **data** repair — it prices DeepSeek
 * on databases seeded before those ids existed — and on a new file it ran with nothing to
 * repair, inserted its rows into an empty table, and left seedDefaults() looking at a table
 * that was no longer empty. seedDefaults() returns early on any row at all, so it seeded
 * nothing.
 *
 * The damage was silent, which is the reason for this file. costMicro() returns 0 when no
 * row matches, so every Claude turn was recorded as free; and billable() divides by the '*'
 * row to convert a cost into quota units, so with that row missing it fell through to the
 * flat weights — the accounting the price table exists to replace. No error, no log, and
 * both columns keep being written.
 *
 * Run: npm -w @agentlodge/server run test:seed
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Read at module load, so it has to be set before anything touching the database is imported
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-seed-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('./index.js');
initDb();
const pricing = await import('./pricing.js');
const { billable } = await import('./usage.js');

let pass = 0;
let fail = 0;
const ok = (label: string, cond: boolean, detail = ''): void => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
};

console.log('\n=== a new database is seeded, not half-populated ===');
{
  // Exactly what index.ts does on boot, in the same order
  pricing.seedDefaults();
  const rows = pricing.list();

  ok('the table is seeded', rows.length > 5, `${rows.length} row(s)`);
  ok(
    "the '*' catch-all exists",
    rows.some((r) => r.model === '*'),
    rows.map((r) => r.model).join(', '),
  );
  ok('Claude models are priced', rows.filter((r) => r.model.startsWith('claude')).length >= 5);
  ok('DeepSeek models are priced', rows.filter((r) => r.model.startsWith('deepseek')).length >= 2);

  // The specific way it broke: a data-writing migration got there first, so the table was
  // not empty and the seed declined to run. Any subset of the seed is a failure, not a
  // partial success.
  ok(
    'no row arrived before the seed did',
    rows.filter((r) => r.model.startsWith('claude')).length > 0
      && rows.some((r) => r.model === '*'),
    'a data migration ran on a fresh file and pre-empted seedDefaults()',
  );
}

console.log('\n=== and every lookup a running deployment makes answers ===');
{
  ok("a Claude model resolves", pricing.resolve('claude-opus-5')?.model === 'claude-opus-5');
  ok('a DeepSeek model resolves', pricing.resolve('deepseek-flash')?.model === 'deepseek-flash');
  ok("an unknown model falls to '*'", pricing.resolve('a-model-nobody-configured')?.model === '*');

  // What billable() divides by to turn a cost into quota units. Zero here does not throw —
  // it silently switches quota accounting to the flat weights.
  ok(
    'the catch-all prices an input token above zero',
    pricing.inputMicroPerToken('*') > 0,
    String(pricing.inputMicroPerToken('*')),
  );
}

console.log('\n=== so the same tokens cost what the model costs ===');
{
  const u = {
    inputTokens: 1_000_000,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
    // Not part of the sum; TurnUsage carries them
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
  };

  /*
   * The property that made the price table worth having: a million tokens on a cheap model is
   * not a million tokens on an expensive one. It lives on **money** now rather than on the
   * billable-token count — a count cannot carry it once two vendors bill in two currencies,
   * so a ceiling that should track price is a cost ceiling, not a token one.
   */
  const dear = pricing.costMicro('claude-opus-5', u);
  const cheap = pricing.costMicro('claude-haiku-4-5', u);
  ok('an expensive model costs more for the same tokens', dear > cheap * 4, `${dear} vs ${cheap}`);
  ok('and neither is zero', cheap > 0 && dear > 0, `${cheap} / ${dear}`);
  ok('each in its vendor\'s own currency',
    pricing.resolve('claude-opus-5')?.currency === 'USD'
      && pricing.resolve('deepseek-flash')?.currency === 'CNY',
    `${pricing.resolve('claude-opus-5')?.currency} / ${pricing.resolve('deepseek-flash')?.currency}`);

  /*
   * And the token count is what it says: weighted counts, no money in it at all. A model
   * nobody priced and the most expensive one on the list weigh the same, because that is what
   * a token ceiling means.
   */
  const reference = billable(u, 'a-model-nobody-configured');
  ok('a token ceiling counts tokens', reference === 1_000_000, String(reference));
  ok('whatever the model costs', billable(u, 'claude-opus-5') === reference,
    `${billable(u, 'claude-opus-5')} vs ${reference}`);
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

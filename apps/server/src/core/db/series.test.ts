/**
 * The chart's buckets, and why they are cut here rather than in the browser.
 *
 * Three separate bugs came out of a client rebuilding these keys from its own clock:
 *
 *   - The keys are SQLite's `localtime`, which is the *server's*. An admin in Shanghai
 *     reading a UTC server got a chart of empty bars over a headline reading 500,000.
 *   - `from` is not always on the bucket grid. A configured reset hour makes the month start
 *     at 09:00 local, and stepping from there never generates today's bucket — every morning
 *     the chart was missing today and disagreeing with the total printed above it.
 *   - Stepping by a fixed 3600000 across a DST change emits an hour twice, or skips a day.
 *
 * Run: npm -w @agentlodge/server run test:series
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-series-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, run } = await import('./index.js');
initDb();
const usage = await import('./usage.js');
const users = await import('./users.js');

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

const alice = users.create({
  email: 'a@example.com', username: 'alice', passwordHash: 'x', role: 'user',
}).id;
const SPEND = {
  inputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 100,
  costUsd: 0, durationMs: 1_000, numTurns: 1,
};
/** The local wall-clock keys the server cuts, in both units */
const two = (n: number) => String(n).padStart(2, '0');
const dayKey = (d: Date) =>
  `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
const hourKey = (d: Date) => `${dayKey(d)} ${two(d.getHours())}:00`;

/**
 * A row at a chosen instant, since `record` stamps with now.
 *
 * `day` is the *local* date, which is what `record` writes and what the daily grouping reads.
 * Slicing the ISO string gives the UTC one, and east of Greenwich an evening row then labels
 * itself the day before — the fixture would be testing a different bug than the one here.
 */
function spendAt(at: Date): void {
  const before = new Date().toISOString();
  usage.record({ userId: alice, agent: 'claude', status: 'completed', usage: SPEND });
  run(
    `update usage_records set created_at = ?, day = ? where user_id = ? and created_at >= ?`,
    at.toISOString(), dayKey(at), alice, before,
  );
}

console.log('\n=== Every bucket in the range, spent or not ===');
{
  const now = new Date();
  const start = new Date(now.getTime() - 5 * 3600_000);
  start.setMinutes(0, 0, 0);
  const busy = new Date(start.getTime() + 2 * 3600_000);
  spendAt(busy);

  const s = usage.seriesAllInRange(
    { from: start.toISOString(), to: new Date(start.getTime() + 6 * 3600_000).toISOString() },
    'hour',
  );
  ok('a quiet stretch is drawn as quiet, not as one full bar', s.length >= 5, String(s.length));
  ok('the busy hour is in there, at the key the server cut', s.some((p) => p.t === hourKey(busy)),
    JSON.stringify(s.map((p) => p.t)));
  ok('and it carries the spend', (s.find((p) => p.t === hourKey(busy))?.billableTokens ?? 0) > 0);
  ok('the empty ones are zero, not missing', s.filter((p) => p.billableTokens === 0).length >= 4);
  ok('no bucket appears twice', new Set(s.map((p) => p.t)).size === s.length);
  ok('they run in order', s.every((p, i) => i === 0 || p.t > s[i - 1]!.t));
}

console.log('\n=== A range that does not start on the bucket grid still reaches its last bucket ===');
{
  /*
   * The failing shape: `quota.anchorHour` puts the month's start at 09:00 local, and stepping
   * whole days from there lands at 09:00 every day — so the newest bucket was one behind and
   * any usage in it vanished from the chart while staying in the total beside it.
   *
   * Wholly in the past on purpose. With a range ending at `now` this reproduces only when the
   * suite happens to run before the anchor hour, which is a test that passes by luck.
   */
  const day = 86400_000;
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  from.setTime(from.getTime() - 3 * day);
  from.setHours(9, 0, 0, 0);          // off the grid, the way an anchor hour leaves it
  const last = new Date(from.getTime() + 2 * day);
  last.setHours(0, 0, 0, 0);          // the final bucket
  const to = new Date(last.getTime() + 6 * 3600_000);   // range ends inside it, at 06:00

  spendAt(new Date(last.getTime() + 5 * 3600_000));

  const range = { from: from.toISOString(), to: to.toISOString() };
  const s = usage.seriesAllInRange(range, 'day');
  ok('the last bucket is generated', s.some((p) => p.t === dayKey(last)),
    JSON.stringify(s.map((p) => p.t)));
  ok('carrying what was spent in it', (s.find((p) => p.t === dayKey(last))?.billableTokens ?? 0) > 0);
  const charted = s.reduce((n, p) => n + p.billableTokens, 0);
  const total = usage.totalsAllInRange(range).billableTokens;
  ok('and the chart adds up to the number printed above it', charted === total, `${charted} vs ${total}`);
}

console.log('\n=== Nothing spent at all ===');
{
  const from = new Date('2020-01-01T00:00:00.000Z');
  const s = usage.seriesAllInRange(
    { from: from.toISOString(), to: new Date(from.getTime() + 3 * 86400_000).toISOString() },
    'day',
  );
  ok('is still a shape, not an empty list', s.length === 3 || s.length === 4, String(s.length));
  ok('all of it zero', s.every((p) => p.billableTokens === 0 && p.turns === 0));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

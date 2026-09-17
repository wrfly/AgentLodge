/**
 * A refusal leaves a trace, in its own table, and only one per person per window.
 *
 * The gate answers 402 and writes no usage row — there is nothing to bill and no upstream
 * call to attribute — so a platform turning people away was invisible everywhere except the
 * status code the client got.
 *
 * Two things about it have failure modes. Recording it *once*: a client retrying a refused
 * request in a loop would otherwise write a row a second, and the console's number would
 * measure that client's retry policy. And keeping it *out of* `usage_records`: every
 * aggregate over that table reads a row as a turn that ran, so a refusal filed there put a
 * phantom line on the user's own usage page and counted itself as a turn in every total.
 *
 * Run: npm -w @agentlodge/server run test:refusal
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'UTC';
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-refusal-')));
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

const mk = (username: string) =>
  users.create({ email: `${username}@example.com`, username, passwordHash: 'x', role: 'user' }).id;
/** Anything `record` writes lands at or after this */
const REAL_NOW = new Date().toISOString();
const alice = mk('alice');
const bob = mk('bob');

/** Enough of a turn to be worth listing */
const SPEND = {
  inputTokens: 1_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 100,
  costUsd: 0, durationMs: 1_000, numTurns: 1,
};

const WINDOW = { from: '2026-08-23T14:00:00.000Z', to: '2026-08-23T19:00:00.000Z' };
const NEXT = { from: '2026-08-23T19:00:00.000Z', to: '2026-08-24T00:00:00.000Z' };
/**
 * Move whatever was just written to a chosen instant, since `record` stamps it with now.
 *
 * Only rows still carrying a real timestamp — matching on the user alone would drag every
 * earlier row along too, and the fixture would silently be testing one window instead of two.
 */
const backdate = (userId: string, at: string) =>
  run(
    `update usage_records set created_at = ?, day = ? where user_id = ? and created_at >= ?`,
    at,
    at.slice(0, 10),
    userId,
    REAL_NOW,
  );

const refuse = (userId: string, windowStart: string, at: string) => {
  usage.noteRefusal({ userId, agent: 'claude', scope: 'window', windowStart });
  run(`update quota_refusals set created_at = ? where user_id = ? and window_start = ?`,
    at, userId, windowStart);
};

console.log('\n=== One row per person per window, however many attempts ===');
{
  for (let i = 0; i < 5; i++) refuse(alice, WINDOW.from, '2026-08-23T15:00:00.000Z');
  ok('five attempts leave one row', usage.refusedCount(WINDOW) === 1, String(usage.refusedCount(WINDOW)));
  ok('and nothing is billed for it', usage.totalsAllInRange(WINDOW).billableTokens === 0);
}

console.log('\n=== A second person is a second row ===');
{
  refuse(bob, WINDOW.from, '2026-08-23T16:30:00.000Z');
  ok('two people, two rows', usage.refusedCount(WINDOW) === 2);
}

console.log('\n=== The next window starts over ===');
{
  /*
   * Keyed on the window's own boundary, so it cannot silence a refusal in the window after
   * it — which would be the same as not recording refusals at all for somebody who is over
   * their quota for a whole day.
   */
  refuse(alice, NEXT.from, '2026-08-23T20:00:00.000Z');
  ok('the same person is recorded again', usage.refusedCount(NEXT) === 1);
  ok('and the earlier window is untouched', usage.refusedCount(WINDOW) === 2);
}

console.log('\n=== And it is not a turn ===');
{
  /*
   * The reason this lives in its own table. Filed as a fourth `usage_records.status` it put a
   * `(claude, null)` line on the user's own "by agent and model" table reading one turn and
   * nothing else, and `count(distinct coalesce(turn_id, id))` counted it as a turn in every
   * total the user sees.
   */
  usage.record({ userId: alice, agent: 'claude', status: 'completed', usage: SPEND });
  backdate(alice, '2026-08-23T20:15:00.000Z');
  const mine = usage.totalsForUser(alice, NEXT);
  ok('the user is charged one turn, not two', mine.turns === 1, String(mine.turns));
  ok('and one upstream call', mine.calls === 1, String(mine.calls));
  const rows = usage.byAgentForUser(alice, NEXT);
  ok('with no phantom line beside it', rows.length === 1, JSON.stringify(rows.map((r) => [r.agent, r.model, r.turns])));
  ok('while the refusal is still counted where it belongs', usage.refusedCount(NEXT) === 1);
}

console.log('\n=== The console\'s list of who was active accounts for the period ===');
{
  /*
   * This list used to be a leaderboard, and the filter that kept zero-spend accounts out of
   * it was a HAVING on a name that is both an output alias and a real column. SQLite binds
   * the bare name to an arbitrary row of the group, so `having billable_tokens > 0` dropped
   * every user with even one zero row: the list came back empty while the total beside it
   * read 459,000.
   *
   * The filter is gone — the console prints a total above these rows and every row it counts
   * has to be here — so that exact bug cannot recur. What the aggregate has to keep getting
   * right is the sum itself, which is what these cases now pin.
   */
  /*
   * Distinct instants, zero rows on both sides of the spend. Which row SQLite reads a bare
   * column from inside an aggregate is not defined and depends on the index it walks, so the
   * group has to look like a real one — several rows, spread over the window — for the test
   * to mean anything. This shape is the one that came back empty in a live console.
   */
  usage.record({ userId: alice, agent: 'claude', status: 'error' });
  backdate(alice, '2026-08-23T20:10:00.000Z');
  usage.record({ userId: alice, agent: 'claude', status: 'aborted' });
  backdate(alice, '2026-08-23T22:30:00.000Z');
  // Somebody whose only turn in the window failed: zero of everything, but a turn the total
  // above these rows still counts
  usage.record({ userId: bob, agent: 'claude', status: 'error' });
  backdate(bob, '2026-08-23T21:00:00.000Z');
  const rows = usage.allUsersInRange(NEXT);
  ok('the spender is listed', rows.some((u) => u.username === 'alice' && u.billableTokens > 0),
    JSON.stringify(rows.map((u) => [u.username, u.billableTokens])));
  /*
   * The bug this pins: `billable_tokens` is both an output alias and a real column, so an
   * aggregate that names it bare lets SQLite read some arbitrary row of the group — and a
   * spender whose group also holds zero rows came back as zero, or vanished entirely.
   */
  ok('and zero rows alongside do not swallow their spend',
    rows.find((u) => u.username === 'alice')?.billableTokens === usage.totalsAllInRange(NEXT).billableTokens,
    JSON.stringify(rows.map((u) => [u.username, u.billableTokens])));
  /*
   * Somebody whose only turns were refused belongs here as a row of zeroes. This list accounts
   * for a period rather than ranking it: the console prints a total above these rows, and that
   * total counts bob's turns, so dropping his row would leave a figure nothing adds up to.
   */
  const bobRow = rows.find((u) => u.username === 'bob');
  ok('somebody with only a refusal is a row of zeroes, not a gap',
    bobRow !== undefined && bobRow.billableTokens === 0, JSON.stringify(bobRow));
  ok('and their turns are counted, which is why the row has to be there',
    (bobRow?.turns ?? 0) > 0, String(bobRow?.turns));
  ok('the rows account for the period',
    rows.reduce((n, u) => n + u.billableTokens, 0) === usage.totalsAllInRange(NEXT).billableTokens,
    String(rows.reduce((n, u) => n + u.billableTokens, 0)));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

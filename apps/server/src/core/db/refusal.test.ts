/**
 * A refusal leaves a trace, and only one per person per window.
 *
 * The gate answers 402 and writes no usage row — there is nothing to bill and no upstream
 * call to attribute — so a platform turning people away was invisible everywhere except the
 * status code the client got. Recording it is easy; recording it once is the part with a
 * failure mode. A client that retries a refused request in a loop would write a row a second
 * for as long as it runs, and the console's number would measure that client's retry policy
 * rather than anything an operator can act on.
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

console.log('\n=== One row per person per window, however many attempts ===');
{
  for (let i = 0; i < 5; i++) {
    usage.noteRefusal({ userId: alice, agent: 'claude', since: WINDOW.from });
    backdate(alice, '2026-08-23T15:00:00.000Z');
  }
  const counts = usage.statusCountsAll(WINDOW);
  ok('five attempts leave one row', counts.refused === 1, String(counts.refused));
  ok('and nothing is billed for it', usage.totalsAllInRange(WINDOW).billableTokens === 0);
  ok('nor counted as a turn that ran', counts.completed === 0 && counts.error === 0);
}

console.log('\n=== A second person is a second row ===');
{
  usage.noteRefusal({ userId: bob, agent: 'codex', since: WINDOW.from });
  backdate(bob, '2026-08-23T16:30:00.000Z');
  ok('two people, two rows', usage.statusCountsAll(WINDOW).refused === 2);
}

console.log('\n=== The next window starts over ===');
{
  /*
   * The dedupe key is the window's own start, so it cannot silence a refusal in the window
   * after it — which would be the same as not recording refusals at all for anybody who is
   * over their quota for a whole day.
   */
  usage.noteRefusal({ userId: alice, agent: 'claude', since: NEXT.from });
  backdate(alice, '2026-08-23T20:00:00.000Z');
  ok('the same person is recorded again', usage.statusCountsAll(NEXT).refused === 1);
  ok('and the earlier window is untouched', usage.statusCountsAll(WINDOW).refused === 2);
}

console.log('\n=== A refusal is not a failure ===');
{
  usage.record({ userId: bob, agent: 'claude', status: 'error' });
  backdate(bob, '2026-08-23T20:30:00.000Z');
  const c = usage.statusCountsAll(NEXT);
  ok('the two are counted apart', c.refused === 1 && c.error === 1, JSON.stringify(c));
}

console.log('\n=== Who spent the most does not list people who spent nothing ===');
{
  /*
   * A refusal row has zero of everything, so somebody refused and nothing else would sit in
   * the leaderboard at 0 — and, worse, the filter that keeps them out is a HAVING on a name
   * that is both an output alias and a real column. SQLite binds the bare name to an
   * arbitrary row of the group, so `having billable_tokens > 0` dropped every user with even
   * one zero row: the list came back empty while the total beside it read 459,000.
   */
  /*
   * Distinct instants, zero rows on both sides of the spend. Which row SQLite reads a bare
   * column from inside an aggregate is not defined and depends on the index it walks, so the
   * group has to look like a real one — several rows, spread over the window — for the test
   * to mean anything. This shape is the one that came back empty in a live console.
   */
  usage.record({ userId: alice, agent: 'claude', status: 'error' });
  backdate(alice, '2026-08-23T20:10:00.000Z');
  usage.record({ userId: alice, agent: 'claude', status: 'completed', usage: SPEND });
  backdate(alice, '2026-08-23T21:00:00.000Z');
  usage.record({ userId: alice, agent: 'claude', status: 'aborted' });
  backdate(alice, '2026-08-23T22:30:00.000Z');
  const top = usage.topUsers(NEXT, 10);
  ok('the spender is listed', top.some((u) => u.username === 'alice' && u.billableTokens > 0),
    JSON.stringify(top.map((u) => [u.username, u.billableTokens])));
  ok('and having a zero row alongside does not hide them', top.length === 1, String(top.length));
  ok('while somebody with only a refusal is left out', !top.some((u) => u.username === 'bob'));
  ok('the total counts the same spend', usage.totalsAllInRange(NEXT).billableTokens > 0);
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

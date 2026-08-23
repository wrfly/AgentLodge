/**
 * The three windows, and the fact that they belong to the platform.
 *
 * The failure this is written against: windows measured from each user's own first message.
 * Somebody who starts at four is then told their allowance runs until nine, while the pool
 * empties at seven — and they are refused with most of their quota unspent. Nothing about
 * that shows up as an error; it shows up as a confusing refusal.
 *
 * Run: npm -w @agentlodge/server run test:quota
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-quota-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, run } = await import('./db/index.js');
initDb();
const users = await import('./db/users.js');
const settings = await import('./db/settings.js');
const quota = await import('./quota.js');

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

function makeUser(email: string): string {
  return users.create({ email, username: email.split('@')[0]!, passwordHash: 'x', role: 'user' }).id;
}

/** A usage record at a given instant, in billable tokens */
function spend(userId: string, at: Date, tokens: number): void {
  // id is an autoincrement integer, so it is left to the database
  run(
    `insert into usage_records
       (user_id, agent, model, billable_tokens, cost_micro, status, created_at, day, source)
     values (?, 'claude', 'm', ?, ?, 'completed', ?, ?, 'gateway')`,
    userId,
    tokens,
    tokens,
    at.toISOString(),
    at.toISOString().slice(0, 10),
  );
}

const alice = makeUser('alice@example.com');
const bob = makeUser('bob@example.com');

console.log('\n=== The 5-hour window follows the upstream, for everybody at once ===');
{
  // The upstream says its window resets at 19:00, so everyone's runs 14:00 → 19:00
  settings.setSetting('quota.windowResetAt', '2026-08-23T19:00:00.000Z');
  const now = new Date('2026-08-23T18:00:00.000Z');
  const a = quota.boundsOf('window', now);
  ok('it starts five hours before the upstream’s reset', a.start.toISOString() === '2026-08-23T14:00:00.000Z', a.start.toISOString());
  ok('and ends at it', a.end.toISOString() === '2026-08-23T19:00:00.000Z');

  // Whoever asks, whenever they started
  const b = quota.boundsOf('window', new Date('2026-08-23T14:00:01.000Z'));
  ok('the same boundaries for a user who just arrived', b.start.getTime() === a.start.getTime() && b.end.getTime() === a.end.getTime());

  const next = quota.boundsOf('window', new Date('2026-08-23T19:30:00.000Z'));
  ok('the next window follows on', next.start.toISOString() === '2026-08-23T19:00:00.000Z');
}
{
  /*
   * A reset seen days ago still sets the phase: the cadence carries forward in whole
   * windows. It does not land on the same wall-clock time, and it should not — five hours
   * does not divide a day, so the upstream's own windows walk around the clock too.
   */
  const observed = '2026-08-20T19:00:00.000Z';
  settings.setSetting('quota.windowResetAt', observed);
  const now = new Date('2026-08-23T18:00:00.000Z');
  const w = quota.boundsOf('window', now);
  const gap = w.end.getTime() - Date.parse(observed);
  ok('a stale observation keeps the phase rather than being discarded', gap % (5 * 3600_000) === 0, w.end.toISOString());
  ok('and still contains the moment asked about', w.start <= now && now < w.end, `${w.start.toISOString()}..${w.end.toISOString()}`);
  settings.setSetting('quota.windowResetAt', '2026-08-23T19:00:00.000Z');
}

console.log('\n=== Usage is counted inside those boundaries ===');
{
  users.setQuota(alice, { window: 1000, week: null, month: null });
  const now = new Date('2026-08-23T18:00:00.000Z');
  spend(alice, new Date('2026-08-23T13:00:00.000Z'), 500); // before the window opened
  spend(alice, new Date('2026-08-23T15:00:00.000Z'), 300); // inside
  spend(alice, new Date('2026-08-23T17:00:00.000Z'), 100); // inside

  const s = quota.status(alice, now);
  ok('only what was spent inside counts', s.windows.window.used === 400, String(s.windows.window.used));
  ok('the ceiling is what was set', s.windows.window.limit === 1000);
  ok('and the ratio follows', Math.round(s.windows.window.ratio * 100) === 40);
  ok('an unlimited window reports no ceiling', s.windows.week.limit === null && s.windows.week.ratio === 0);
  ok('the tightest window is the only limited one', s.tightest === 'window');
}
{
  // One user's spending is invisible to another; only the boundaries are shared
  users.setQuota(bob, { window: 1000 });
  const s = quota.status(bob, new Date('2026-08-23T18:00:00.000Z'));
  ok('another user in the same window starts at nothing', s.windows.window.used === 0);
}

console.log('\n=== Any window over its ceiling refuses, and says which ===');
{
  // The week's boundary is the configured anchor in local time, so what falls inside it is
  // not the same set as the 5-hour window's — which is the point of having both
  users.setQuota(alice, { window: 1000, week: 50, month: null });
  const s = quota.status(alice, new Date('2026-08-23T18:00:00.000Z'));
  ok('the weekly one is over', s.windows.week.exceeded, JSON.stringify(s.windows.week));
  ok('so the quota as a whole is', s.exceeded);
  ok('and that is the tightest', s.tightest === 'week');
}
{
  users.setQuota(alice, { window: 1000, week: 50 });
  const v = quota.check(alice, new Date('2026-08-23T18:00:00.000Z'));
  ok('a hard quota refuses', !v.allow);
  ok('naming the window that ran out', v.reason?.includes('week') === true, String(v.reason));
}
{
  users.setQuota(alice, { hardStop: false });
  const v = quota.check(alice, new Date('2026-08-23T18:00:00.000Z'));
  ok('a soft quota allows, and still reports the state', v.allow && v.status.exceeded);
  users.setQuota(alice, { hardStop: true });
}

console.log('\n=== A top-up lifts one window and expires with it ===');
{
  users.setQuota(alice, { window: 1000, week: 50, month: null });
  const ends = quota.boundsOf('week', new Date('2026-08-23T18:00:00.000Z')).end.toISOString();
  users.grantBoost(alice, 'week', 500, ends);

  const s = quota.status(alice, new Date('2026-08-23T18:00:00.000Z'));
  ok('the ceiling it applies to goes up', s.windows.week.limit === 550, String(s.windows.week.limit));
  ok('and says how much of it is a top-up', s.windows.week.boost === 500);
  ok('the other windows are untouched', s.windows.window.limit === 1000 && s.windows.window.boost === 0);
  ok('so the refusal is lifted', !s.exceeded);
}
{
  // Expiry is the window's own boundary, not a clock of the user's own
  users.grantBoost(alice, 'week', 500, '2026-08-20T00:00:00.000Z');
  const s = quota.status(alice, new Date('2026-08-23T18:00:00.000Z'));
  ok('an expired top-up counts for nothing', s.windows.week.limit === 50 && s.windows.week.boost === 0);
  users.clearBoost(alice);
}

console.log('\n=== A manual reset moves the counting start, not the boundary ===');
{
  users.setQuota(alice, { window: 1000, week: null, month: null });
  users.resetUsage(alice, '2026-08-23T16:00:00.000Z');
  const now = new Date('2026-08-23T18:00:00.000Z');
  const s = quota.status(alice, now);
  ok('what came before the reset stops counting', s.windows.window.used === 100, String(s.windows.window.used));
  ok('the window still ends when everybody else’s does', s.windows.window.endsAt === '2026-08-23T19:00:00.000Z');
  users.undoResetUsage(alice);
  ok('undoing brings it back', quota.status(alice, now).windows.window.used === 400);
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

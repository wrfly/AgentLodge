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

/*
 * Pinned, because the windows this file is about are cut on local time: a week begins at
 * midnight wherever the machine thinks it is. The fixtures below are written as UTC
 * instants, so anywhere but UTC they land in a different week and the suite passes or
 * fails by where it is run — which is how this went green here and red in CI.
 */
process.env.TZ = 'UTC';

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

/** A usage record at a given instant, in micro-units of money — what a ceiling is counted in */
function spend(userId: string, at: Date, micro: number): void {
  // id is an autoincrement integer, so it is left to the database
  run(
    `insert into usage_records
       (user_id, agent, model, cost_micro, status, created_at, day, source)
     values (?, 'claude', 'm', ?, 'completed', ?, ?, 'gateway')`,
    userId,
    micro,
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

console.log('\n=== And so does the week, once the upstream has stated one ===');
{
  const at = new Date('2026-08-23T18:00:00.000Z');
  const configured = quota.boundsOf('week', at);

  settings.setSetting('quota.weekResetAt', '2026-08-27T05:00:00.000Z');
  const w = quota.boundsOf('week', at);
  ok('the week ends where the upstream says its 7d does', w.end.toISOString() === '2026-08-27T05:00:00.000Z', w.end.toISOString());
  ok('seven days after it began', w.end.getTime() - w.start.getTime() === 7 * 24 * 3600_000);
  ok('which is not where the calendar week ended', configured.end.getTime() !== w.end.getTime(), configured.end.toISOString());

  /*
   * Cleared again, because everything below is written against the configured week — and
   * because this is the guarantee for deployments that have never seen an upstream reading:
   * without one, the boundary is exactly what it was before any of this existed.
   */
  settings.setSetting('quota.weekResetAt', '');
  ok('with no reading it is the configured week again', quota.boundsOf('week', at).end.getTime() === configured.end.getTime());
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
  const at = new Date('2026-08-23T18:00:00.000Z');
  users.setQuota(alice, { window: 1000, week: 500, month: null });

  // Refused first, or "the refusal is lifted" would pass on someone who was never refused
  ok('over the ceiling to begin with', quota.status(alice, at).exceeded);

  const ends = quota.boundsOf('week', at).end.toISOString();
  users.grantBoost(alice, 'week', 500, ends);

  const s = quota.status(alice, at);
  ok('the ceiling it applies to goes up', s.windows.week.limit === 1000, String(s.windows.week.limit));
  ok('and says how much of it is a top-up', s.windows.week.boost === 500);
  ok('the other windows are untouched', s.windows.window.limit === 1000 && s.windows.window.boost === 0);
  ok('so the refusal is lifted', !s.exceeded,
    `week ${s.windows.week.used}/${s.windows.week.limit} · tightest ${s.tightest}`);
}
{
  // Expiry is the window's own boundary, not a clock of the user's own
  users.grantBoost(alice, 'week', 500, '2026-08-20T00:00:00.000Z');
  const s = quota.status(alice, new Date('2026-08-23T18:00:00.000Z'));
  ok('an expired top-up counts for nothing', s.windows.week.limit === 500 && s.windows.week.boost === 0);
  users.clearBoost(alice);
}

/*
 * Zeroing one account's usage is gone, and with it the only thing that could make a window
 * start at a different instant for different people.
 *
 * It used to move the counting start forward inside a running window, which meant the gate
 * counted from the reset and the usage report counted from the boundary — two right answers
 * about one window, and a `countsFrom`/`spent` pair on every window everywhere to reconcile
 * them. What replaces it is a top-up: it raises the ceiling instead of hiding the spend, says
 * so on the row, and expires on the window's own boundary.
 */
console.log('\n=== A window begins at its boundary, the same one for everybody ===');
{
  users.setQuota(alice, { window: 1000, week: null, month: null });
  const now = new Date('2026-08-23T18:00:00.000Z');
  const s = quota.status(alice, now).windows.window;
  ok('everything spent inside the window counts', s.used === 400, String(s.used));
  ok('it starts where everybody else’s does', s.startsAt === '2026-08-23T14:00:00.000Z', s.startsAt);
  ok('and ends when everybody else’s does', s.endsAt === '2026-08-23T19:00:00.000Z', s.endsAt);
  /*
   * The gate's figure and the usage report's are now one number by construction. There is no
   * second start to report from, so there is nothing for a page to reconcile — which is why
   * `countsFrom` and `spent` are off the protocol rather than always equal to their partners.
   */
  ok('with one figure, not two', !('countsFrom' in s) && !('spent' in s), JSON.stringify(Object.keys(s)));
  /*
   * The admin user list draws this same five-hour figure. It used to have to call the shared
   * `countStartOf` to agree with the gate; now agreeing means reading the same boundary, and
   * a boundary is not something two callers can disagree about.
   */
  const boundary = quota.boundsOf('window', now);
  ok('which the list can reach without a rule of its own',
    s.startsAt === boundary.start.toISOString(), `${s.startsAt} vs ${boundary.start.toISOString()}`);
}

console.log('\n=== The ceiling the gate enforces, top-up included ===');
{
  /*
   * The admin list draws a bar against this. It divided by the configured ceiling, so a user
   * who had just been topped up read past 100% in the list while the gate was still letting
   * them through — the console saying "refused" about somebody it was not refusing.
   */
  const at = new Date('2026-08-23T18:00:00.000Z');
  users.setQuota(alice, { window: 1000, week: null, month: null });
  ok('with no top-up it is the configured ceiling',
    quota.effectiveCeiling(users.getQuota(alice), 'window', at) === 1000);

  users.grantBoost(alice, 'window', 500, '2026-08-23T19:00:00.000Z');
  ok('a live top-up raises it', quota.effectiveCeiling(users.getQuota(alice), 'window', at) === 1500);
  ok('and it matches what the gate reports', quota.status(alice, at).windows.window.limit === 1500);
  ok('a top-up on one window leaves the others alone',
    quota.effectiveCeiling(users.getQuota(alice), 'week', at) === null);

  const after = new Date('2026-08-23T19:30:00.000Z');
  ok('an expired top-up counts for nothing',
    quota.effectiveCeiling(users.getQuota(alice), 'window', after) === 1000);
  users.clearBoost(alice);
}

console.log('\n=== what a turn typically costs, for saying the remainder in turns ===');
{
  const usageRepo = await import('./db/usage.js');
  const carol = makeUser('carol@example.com');

  ok('with nothing spent there is no typical turn', usageRepo.typicalTurn(carol) === null);

  // The gateway writes one row per upstream call, so a turn is the group of rows sharing a
  // turn_id — not a row. Three calls of 100 are one turn of 300, and reading them as three
  // turns of 100 would promise three times the runway.
  const call = (turnId: string | null, micro: number) =>
    run(
      `insert into usage_records
         (user_id, turn_id, agent, model, cost_micro, status, created_at, day, source)
       values (?, ?, 'claude', 'm', ?, 'completed', ?, ?, 'gateway')`,
      carol,
      turnId,
      micro,
      new Date().toISOString(),
      new Date().toISOString().slice(0, 10),
    );

  call('t1', 100);
  call('t1', 100);
  call('t1', 100);
  ok('calls sharing a turn are one turn', usageRepo.typicalTurn(carol) === 300);

  call('t2', 500);
  call('t3', 400);
  // 300, 400, 500 — the middle one
  ok('three turns give the median', usageRepo.typicalTurn(carol) === 400);

  // The median rather than the mean, because one runaway turn is the thing somebody wants
  // warning about and also the thing that would drag a mean past usefulness.
  call('t4', 1_000_000);
  ok('a runaway turn does not move it much', usageRepo.typicalTurn(carol) === 450, String(usageRepo.typicalTurn(carol)));

  // A failed turn still gets a row, for debugging. Counting those as cheap turns would say
  // somebody has more room than they have.
  call('t5', 0);
  call('t6', 0);
  ok('turns that cost nothing are left out', usageRepo.typicalTurn(carol) === 450);

  /*
   * A turn that crossed two upstreams is still one turn.
   *
   * Grouped by turn *and* currency it becomes two, each entering the median as its own
   * cheaper turn — so somebody is told they have about twice the runway the gate will give
   * them. `settle` converts CNY at the configured rate, so the yuan half is worth its rate.
   */
  const { setSetting } = await import('./db/settings.js');
  setSetting('billing.currency', 'USD');
  setSetting('billing.rates', JSON.stringify({ CNY: 0.5 }));
  const split = (turnId: string, micro: number, currency: string) =>
    run(
      `insert into usage_records
         (user_id, turn_id, agent, model, cost_micro, cost_currency, status, created_at, day, source)
       values (?, ?, 'claude', 'm', ?, ?, 'completed', ?, ?, 'gateway')`,
      carol, turnId, micro, currency,
      new Date().toISOString(), new Date().toISOString().slice(0, 10),
    );
  const before = usageRepo.typicalTurn(carol);
  // 400 USD-micro + 400 CNY-micro at 0.5 = 600 settled, in one turn
  split('t7', 400, 'USD');
  split('t7', 400, 'CNY');
  const sample = usageRepo.typicalTurn(carol, 200);
  ok('a turn split across two currencies is one turn, not two cheaper ones',
    sample !== null && sample >= (before ?? 0),
    `${before} -> ${sample}`);
  const one = usageRepo.typicalTurn(carol, 1);
  ok('and it is worth both halves, settled', one === 600, String(one));

  // A row with no turn_id — the CLI path writes one row per turn — is its own turn, not
  // lumped with every other turn-less row into one enormous one.
  const dave = makeUser('dave@example.com');
  const noTurn = (micro: number) =>
    run(
      `insert into usage_records
         (user_id, agent, model, cost_micro, status, created_at, day, source)
       values (?, 'claude', 'm', ?, 'completed', ?, ?, 'cli')`,
      dave,
      micro,
      new Date().toISOString(),
      new Date().toISOString().slice(0, 10),
    );
  noTurn(10);
  noTurn(20);
  noTurn(30);
  ok('rows with no turn id count one each', usageRepo.typicalTurn(dave) === 20, String(usageRepo.typicalTurn(dave)));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

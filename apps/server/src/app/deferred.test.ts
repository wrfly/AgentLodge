/**
 * A question over the ceiling waits instead of being refused.
 *
 * The three things here that can go wrong quietly:
 *
 * **Which window is waited for.** `check()` names the *first* window it finds over, which
 * is the right thing to tell somebody; how long the wait is, is a different question. A
 * turn held until the 5-hour window resets, on a month that is also exhausted, comes back
 * at two o'clock and is refused again having waited for nothing. So the release instant is
 * the latest of the exceeded windows, not the first.
 *
 * **What the horizon is for.** One window length, which makes the rule mean one thing: a
 * turn blocked on the 5-hour window is always held, and a week or a month only in the last
 * five hours of one. Without it the feature quietly becomes "your question is asked
 * automatically nineteen days from now".
 *
 * **That the sweeper re-asks.** It would be natural to trust `release_at` — it is right
 * there in the row — and it is wrong twice over: an administrator's top-up would do nothing
 * until the window it was granted to work around had ended anyway, and a second window
 * still over its ceiling would release a turn straight into a 402.
 *
 * Run: npm -w @agentlodge/server run test:deferred
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'Asia/Shanghai';
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-deferred-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, run } = await import('../core/db/index.js');
initDb();
const users = await import('../core/db/users.js');
const convRepo = await import('../core/db/conversations.js');
const usage = await import('../core/db/usage.js');
const repo = await import('../core/db/deferred.js');
const quota = await import('../core/quota.js');
const deferred = await import('./deferred.js');

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

const SPEND = {
  inputTokens: 1_000_000, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0,
  costUsd: 0, durationMs: 1_000, numTurns: 1,
};

/** Burn `turns` million billable tokens, which is `turns` million of a tokens ceiling */
function burn(userId: string, turns: number): void {
  for (let i = 0; i < turns; i++) {
    usage.record({
      userId,
      agent: 'claude',
      model: 'a-model-nobody-configured',
      usage: SPEND,
      status: 'completed',
    });
  }
}

const alice = mk('alice');
users.setQuota(alice, { limitKind: 'tokens', window: 2_000_000, hardStop: true });
const conv = convRepo.create({ userId: alice, agent: 'claude', title: 'held' });

/* ---------------- clearsAt: the latest window over, not the first ---------------- */
{
  burn(alice, 3);
  const s = quota.status(alice);
  ok('the 5-hour window is over', s.windows.window.exceeded);

  const clears = quota.clearsAt(s);
  ok('clearsAt answers with an instant', clears !== null);
  ok(
    'and it is the 5-hour window, the only one limited',
    clears?.toISOString() === s.windows.window.endsAt,
    `${clears?.toISOString()} vs ${s.windows.window.endsAt}`,
  );

  // Both windows over. The 5-hour one resets first and is the one `check()` names; waiting
  // for it would release the turn into a month that is still exhausted.
  users.setQuota(alice, { window: 2_000_000, month: 1_000_000, hardStop: true });
  const both = quota.status(alice);
  ok('both windows are over', both.windows.window.exceeded && both.windows.month.exceeded);
  ok(
    'clearsAt waits for the month, not the window that resets first',
    quota.clearsAt(both)?.toISOString() === both.windows.month.endsAt,
  );
  ok(
    'which is later than the one check() names',
    new Date(both.windows.month.endsAt) > new Date(both.windows.window.endsAt),
  );

  // A soft quota refuses nobody, so it has nobody waiting
  users.setQuota(alice, { hardStop: false });
  ok('a soft quota clears at nothing', quota.clearsAt(quota.status(alice)) === null);
  users.setQuota(alice, { window: 2_000_000, month: null, hardStop: true });
}

/* ---------------- tryDefer: the horizon ---------------- */
{
  const status = quota.status(alice);
  const held = deferred.tryDefer({
    conversationId: conv.id,
    userId: alice,
    body: 'the question',
    status,
  });
  ok('a turn blocked on the 5-hour window is held', held !== null);
  ok('it keeps what was typed', held?.body === 'the question');
  ok('it names the window it is waiting for', held?.scope === 'window');
  ok(
    'and says when that is',
    held?.releaseAt === status.windows.window.endsAt,
    `${held?.releaseAt} vs ${status.windows.window.endsAt}`,
  );
  ok('the row is there', repo.forConversation(conv.id, alice)?.id === held?.id);

  /*
   * The same call from a moment far enough before the reset that the wait exceeds the
   * horizon. Rather than fabricate a month, this asks with a `now` in the past: the
   * distance to the same reset instant is then more than one window length, which is
   * exactly the condition a month-blocked turn meets.
   */
  const longAgo = new Date(new Date(status.windows.window.endsAt).getTime() - 6 * 3600_000);
  const tooFar = deferred.tryDefer({
    conversationId: conv.id,
    userId: alice,
    body: 'x',
    status,
    now: longAgo,
  });
  ok('a wait longer than one window is refused rather than held', tooFar === null);
}

/* ---------------- one per conversation, and threads are not held ---------------- */
{
  const second = deferred.tryDefer({
    conversationId: conv.id,
    userId: alice,
    body: 'i changed my mind',
    status: quota.status(alice),
  });
  ok('asking again replaces rather than queues a second', second !== null);
  ok(
    'and the newer text is the one that will be sent',
    repo.forConversation(conv.id, alice)?.body === 'i changed my mind',
  );
  ok('still only one row for this conversation', repo.countForUser(alice) === 1);

  const thread = convRepo.create({
    userId: alice,
    agent: 'claude',
    title: 'a thread',
    parentId: conv.id,
  });
  const threadHeld = deferred.tryDefer({
    conversationId: thread.id,
    userId: alice,
    body: 'about that passage',
    status: quota.status(alice),
  });
  // The panel a thread lives in has no line to say a turn is waiting and no way to take it
  // back; a hold nobody can see or cancel is worse than the refusal it replaced.
  ok('a thread is refused, not held', threadHeld === null);
  ok('and leaves no row', repo.forConversation(thread.id, alice) === undefined);
}

/* ---------------- cancel hands the text back ---------------- */
{
  const gone = deferred.cancel(conv.id, alice);
  ok('cancelling returns what was being held', gone?.body === 'i changed my mind');
  ok('and the row is gone', repo.forConversation(conv.id, alice) === undefined);
  ok('cancelling nothing is not an error', deferred.cancel(conv.id, alice) === undefined);

  // Another user's conversation id is a 404, not a cancellation
  const bob = mk('bob');
  deferred.tryDefer({
    conversationId: conv.id,
    userId: alice,
    body: 'mine',
    status: quota.status(alice),
  });
  ok('somebody else cannot cancel it', deferred.cancel(conv.id, bob) === undefined);
  ok('and it is still there', repo.forConversation(conv.id, alice)?.body === 'mine');
}

/* ---------------- the sweep re-asks rather than trusting release_at ---------------- */
{
  // Still over: nothing goes, and the row stays. `startTurn` is never reached, so this
  // exercises the decision without needing a container engine.
  const before = repo.forConversation(conv.id, alice);
  const released = await deferred.sweep();
  ok('nothing is released while the ceiling is still exceeded', released === 0);
  ok('and the question is still waiting', repo.forConversation(conv.id, alice)?.id === before?.id);

  /*
   * A top-up, which is the case `release_at` gets wrong.
   *
   * It grants allowance on the window that is blocking, expiring when that window ends —
   * so the person is under the ceiling now, hours before the instant the row advertises. A
   * sweeper reading the row would leave them waiting for a reset they no longer need.
   */
  const end = quota.status(alice).windows.window.endsAt;
  users.grantBoost(alice, 'window', 10_000_000, end);
  ok('the top-up puts them back under the ceiling', !quota.status(alice).exceeded);
  ok(
    'so the row now advertises a reset that is no longer being waited for',
    repo.forConversation(conv.id, alice)?.releaseAt === end,
  );

  /*
   * The release itself ends in `startTurn`, which pulls up a container — out of reach
   * here. Pointing the conversation at an agent that does not exist makes that call throw
   * after the point this module hands over, which is the branch worth pinning: whatever
   * refused it, what was typed is a reason to wait rather than to discard.
   */
  run('update conversations set agent = ? where id = ?', 'no-such-agent', conv.id);
  const n = await deferred.sweep();
  ok('a release that fails releases nothing', n === 0);
  ok(
    'and puts the question back rather than losing it',
    repo.forConversation(conv.id, alice)?.body === 'mine',
  );

  /*
   * And does not try again straight away.
   *
   * A conversation whose agent an administrator has turned off fails every time, and the
   * engine being down fails *every* held row at once. Retried each pass, that is a
   * container start and a log line every twenty seconds until the day is up. The proof is
   * that the row is untouched rather than re-added: `add` writes a new id, so an id that
   * has not changed is an attempt that did not happen.
   */
  const after = repo.forConversation(conv.id, alice);
  await deferred.sweep();
  ok(
    'a failed release is left alone on the next pass',
    repo.forConversation(conv.id, alice)?.id === after?.id,
  );
  // Far enough ahead that the back-off has lapsed; it tries again and fails again, which is
  // a new row — the back-off delays retries, it does not end them.
  await deferred.sweep(new Date(Date.now() + 5 * 60_000));
  ok(
    'and is tried again once the back-off lapses',
    repo.forConversation(conv.id, alice)?.id !== after?.id,
  );
  run('update conversations set agent = ? where id = ?', 'claude', conv.id);
}

/* ---------------- the banner names the window it is actually waiting for ---------------- */
{
  /*
   * With two windows over, `tightest` and the window being waited for are different
   * answers, and the sweeper used to reschedule with the first while displaying the
   * second's time — a banner reading "waiting for the 5h quota" beside a month's date.
   */
  users.clearBoost(alice);
  users.setQuota(alice, { window: 2_000_000, month: 1_000_000, hardStop: true });
  const s = quota.status(alice);
  ok('the tightest window is not the one that clears last', s.tightest === 'window');

  const held = deferred.tryDefer({
    conversationId: conv.id,
    userId: alice,
    body: 'two windows over',
    status: s,
    // Inside the horizon of the month's own reset, so it is held rather than refused
    now: new Date(new Date(s.windows.month.endsAt).getTime() - 60_000),
  });
  ok('it is held', held !== null);
  ok('and it names the month, which is what it waits for', held?.scope === 'month');
  ok('with the month\'s instant', held?.releaseAt === s.windows.month.endsAt);

  /*
   * The same question of the sweeper, which is where this was wrong.
   *
   * `tryDefer` matched the instant from the start; the *reschedule* branch — a turn still
   * blocked when the thing it was waiting for has moved — reached for `tightest` instead,
   * so a hold that outlived one window ended up labelled with the window furthest along
   * rather than the one whose date was printed next to it. Putting a stale instant on the
   * row is what makes the sweeper take that branch.
   */
  repo.reschedule(held!.id, s.windows.window.endsAt, 'window');
  // Past the back-off the failing release above left on this conversation — without that
  // the sweep skips the row and this asserts nothing, which is how it first went green
  await deferred.sweep(new Date(Date.now() + 10 * 60_000));
  const fixed = repo.forConversation(conv.id, alice);
  ok('the sweeper corrects a stale instant', fixed?.releaseAt === s.windows.month.endsAt);
  ok(
    'and labels it with the window that clears last, not the tightest',
    fixed?.scope === 'month',
    `got ${fixed?.scope}, tightest is ${s.tightest}`,
  );

  deferred.cancel(conv.id, alice);
  // Back to one window over, which is what the block below assumes
  users.setQuota(alice, { window: 2_000_000, month: null });
}

/* ---------------- a deleted conversation takes its held turn with it ---------------- */
{
  const doomed = convRepo.create({ userId: alice, agent: 'claude', title: 'doomed' });
  users.clearBoost(alice);
  deferred.tryDefer({
    conversationId: doomed.id,
    userId: alice,
    body: 'never asked',
    status: quota.status(alice),
  });
  ok('it is held', repo.forConversation(doomed.id, alice) !== undefined);
  convRepo.remove(doomed.id, alice);
  ok(
    'and deleting the conversation takes the row with it',
    repo.forConversation(doomed.id, alice) === undefined,
  );
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

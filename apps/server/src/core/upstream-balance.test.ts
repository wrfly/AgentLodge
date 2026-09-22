/**
 * The interval a subscription's spend is reported over.
 *
 * Cursor's plan is a monthly dollar pot, not a rolling window: it reports a
 * `subscriptionCycleStart` and refills on it. So the console reports what this platform
 * billed through that upstream over *that* interval — the one the vendor's own invoice is
 * cut at — rather than over the 5-hour quota window, which for a Cursor subscription is a
 * boundary that exists only here.
 *
 * Two things can go wrong quietly. The interval can be somebody else's: counting from 1970
 * puts lifetime spend beside a monthly ceiling, and counting on our anchor while calling it
 * the vendor's cycle reads as the vendor's invoice. And the figure can belong to the wrong
 * upstream: one row on a Claude subscription must not appear on Cursor's card.
 *
 * Run: npm -w @agentlodge/server run test:upstream-balance
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.TZ = 'UTC';
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-balance-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, run } = await import('./db/index.js');
initDb();
const users = await import('./db/users.js');
const usageRepo = await import('./db/usage.js');
const { cycleOf } = await import('./upstream-balance.js');

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

const who = users.create({
  email: 'spender@example.com',
  username: 'spender',
  passwordHash: 'x',
  role: 'user',
}).id;

/** A priced call against one upstream at one instant */
function spend(providerId: string | null, at: Date, micro: number): void {
  run(
    `insert into usage_records
       (user_id, agent, model, provider_id, cost_micro, cost_currency, status, created_at, day, source)
     values (?, 'claude', 'm', ?, ?, 'USD', 'completed', ?, ?, 'gateway')`,
    who,
    providerId,
    micro,
    at.toISOString(),
    at.toISOString().slice(0, 10),
  );
}

const CURSOR = 'provider-cursor';
const OTHER = 'provider-claude';
const now = new Date();
const hoursAgo = (n: number) => new Date(now.getTime() - n * 3600_000);

console.log("\n=== The vendor's own cycle, when it reports one ===");
{
  const reported = hoursAgo(48).toISOString();
  spend(CURSOR, hoursAgo(72), 5_000_000);  // before the cycle opened
  spend(CURSOR, hoursAgo(24), 3_000_000);  // inside it
  spend(CURSOR, hoursAgo(1), 1_000_000);   // inside it
  spend(OTHER, hoursAgo(24), 9_000_000);   // another subscription, same instant

  const c = cycleOf(CURSOR, reported);
  ok('the interval is the one the vendor reported', c.from === reported, c.from);
  ok('and it is marked as the vendor’s', c.source === 'upstream', c.source);
  ok('only what was spent inside it counts', c.totals.cost.USD === 4_000_000, String(c.totals.cost.USD));
  ok('and only on this upstream', c.totals.calls === 2, String(c.totals.calls));
}

console.log('\n=== Our own monthly anchor, when it reports none ===');
{
  const c = cycleOf(CURSOR, null);
  ok('it falls back to the monthly anchor', c.from === usageRepo.periodStart('monthly'), c.from);
  /*
   * And says whose boundary that is. The console prints this: a figure cut on a month we
   * chose must not read as the line on the vendor's invoice.
   */
  ok('and says the boundary is ours', c.source === 'anchor', c.source);
  ok('it is not 1970 — that would be lifetime spend against a monthly pot',
    new Date(c.from).getUTCFullYear() > 2000, c.from);
}

console.log('\n=== An upstream with nothing billed through it ===');
{
  const c = cycleOf('provider-unused', null);
  ok('reports no spend rather than everybody’s', c.totals.cost.USD === undefined || c.totals.cost.USD === 0,
    String(c.totals.cost.USD));
  ok('and still names an interval', Boolean(c.from));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

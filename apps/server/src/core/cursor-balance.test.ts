/**
 * Cursor's prepaid reading, from the dashboard JSON, without a network.
 *
 * Cursor does not send Anthropic's 5-hour headers. An Enterprise token-based seat
 * has a monthly dollar ceiling and a spend in cents; GetHardLimit's per-user figure
 * is the on-demand default and is not that ceiling.
 *
 * Run: npm -w @agentlodge/server run test:cursor-balance
 */
import { readCursorBalance, seatFromTeamSpend } from './cursor-balance.js';

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

console.log('\n=== Cursor prepaid, as the dashboard answers it ===');
{
  const empty = readCursorBalance({
    period: { billingCycleStart: Date.now(), billingCycleEnd: Date.now() },
    plan: { planName: 'Enterprise', billingCycleEnd: '1790812800000' },
    grants: {},
    hard: { hardLimit: 9_612_200, hardLimitPerUser: 500 },
    hadTeamId: true,
  });
  ok('a team on-demand default is not the account pot', empty.limit === null && empty.remaining === null);
  ok('an empty usage object is not a zero spend', empty.used === null);
  ok('the org pool is not this seat', empty.limit !== 9_612_200);
  ok('a cycle that starts and ends now is not a reset', empty.resetsAt === null && empty.cycleStart === null);
  ok('the plan name survives a flat GetPlanInfo', empty.planName === 'Enterprise');
}

{
  const seat = readCursorBalance({
    hard: { hardLimit: 9_612_200, hardLimitPerUser: 500 },
    hadTeamId: true,
    seat: {
      monthlyLimitDollars: 4000,
      effectivePerUserLimitDollars: 4000,
      overallSpendCents: 284_915,
      spendCents: 284_915,
    },
  });
  ok('the monthly seat limit is the pot, in dollars', seat.limit === 4000);
  ok('spend is cents turned into dollars', Math.abs((seat.used ?? 0) - 2849.15) < 0.001);
  ok('remaining is the monthly limit minus that spend', Math.abs((seat.remaining ?? 0) - 1150.85) < 0.001);
  ok('the $500 on-demand default is not used', seat.limit !== 500);
}

{
  const nested = readCursorBalance({
    plan: { planInfo: { planName: 'Pro', billingCycleEnd: String(Date.now() + 10 * 86_400_000) } },
    period: {
      planUsage: { totalSpend: 1_250, remaining: 8_750, limit: 10_000 },
    },
  });
  ok('planUsage is cents, remaining is dollars', nested.used === 12.5 && nested.remaining === 87.5 && nested.limit === 100);
  ok('a cycle a few days out is a reset', nested.resetsAt !== null);
  ok('a nested planInfo still names the plan', nested.planName === 'Pro');
}

{
  const grants = readCursorBalance({
    grants: { remainingCents: 4_321, totalCents: 10_000 },
  });
  ok('grant credit is the remaining when nothing else speaks', grants.remaining === 43.21 && grants.prepaid === 43.21);
}

{
  const teamPool = readCursorBalance({
    hard: { hardLimit: 9_612_200 },
    hadTeamId: true,
  });
  ok('a team without a per-user cap does not inherit the org pool', teamPool.limit === null && teamPool.remaining === null);
}

{
  const personal = readCursorBalance({
    hard: { hardLimit: 20 },
    hadTeamId: false,
  });
  ok('a personal hardLimit is the ceiling', personal.limit === 20 && personal.remaining === 20);
}

{
  const picked = seatFromTeamSpend(
    {
      subscriptionCycleStart: '1700000000000',
      nextCycleStart: '1702592000000',
      teamMemberSpend: [
        { userId: 1, monthlyLimitDollars: 30, overallSpendCents: 100, email: 'a@example.com', name: 'A' },
        { userId: 42, monthlyLimitDollars: 4000, effectivePerUserLimitDollars: 4000, overallSpendCents: 50, email: 'b@example.com', name: 'B' },
      ],
    },
    42,
  );
  ok('only this seat is kept', picked.seat?.monthlyLimitDollars === 4000 && picked.seat?.overallSpendCents === 50);
  ok('names and emails are not copied', !('email' in (picked.seat ?? {})) && !('name' in (picked.seat ?? {})));
  ok('the other seat is not kept', picked.seat?.monthlyLimitDollars !== 30);
}

if (fail) {
  console.log(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}
console.log(`\n${pass} passed`);

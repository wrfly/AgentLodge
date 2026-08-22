import { periodStartAt, periodEndAt, describeAnchor } from './period.js';

let pass = 0, fail = 0;
const fmt = (d: Date | null) =>
  d === null ? 'null' : `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:00`;

function check(label: string, actual: Date | null, expected: string) {
  const got = fmt(actual);
  if (got === expected) { pass++; console.log(`  ✓ ${label.padEnd(52)} ${got}`); }
  else { fail++; console.log(`  ✗ ${label.padEnd(52)} expected ${expected}, got ${got}`); }
}

const at = (s: string) => new Date(s);

console.log('=== Monthly: anchored on day 15 at 09:00 ===');
const m = { dayOfMonth: 15, dayOfWeek: 1, hour: 9 };
check('8/20 → the period began 8/15',        periodStartAt('monthly', at('2026-08-20T12:00:00'), m), '2026-08-15 09:00');
check('8/15 08:00, before the hour → 7/15', periodStartAt('monthly', at('2026-08-15T08:00:00'), m), '2026-07-15 09:00');
check('8/15 09:00, exactly on it → 8/15', periodStartAt('monthly', at('2026-08-15T09:00:00'), m), '2026-08-15 09:00');
check('8/10 → last month, 7/15',           periodStartAt('monthly', at('2026-08-10T23:59:00'), m), '2026-07-15 09:00');
check('1/5 → across the year to 12/15',           periodStartAt('monthly', at('2026-01-05T00:00:00'), m), '2025-12-15 09:00');
check('the period containing 8/20 ends 9/15',       periodEndAt('monthly', at('2026-08-20T12:00:00'), m),   '2026-09-15 09:00');

console.log('\n=== Monthly: anchored on day 31, which shorter months clamp ===');
const m31 = { dayOfMonth: 31, dayOfWeek: 1, hour: 0 };
check('2026-02-20 → 1/31',            periodStartAt('monthly', at('2026-02-20T00:00:00'), m31), '2026-01-31 00:00');
check('2026-03-01 → 2/28, clamped by February', periodStartAt('monthly', at('2026-03-01T00:00:00'), m31), '2026-02-28 00:00');
check('2026-03-05 ends 3/31',       periodEndAt('monthly', at('2026-03-05T00:00:00'), m31),   '2026-03-31 00:00');
check('2024, a leap year: 3/1 → 2/29',         periodStartAt('monthly', at('2024-03-01T00:00:00'), m31), '2024-02-29 00:00');
check('4/20 → 3/31, ending 4/30 after clamping',  periodEndAt('monthly', at('2026-04-20T00:00:00'), m31),   '2026-04-30 00:00');

console.log('\n=== Weekly: anchored Thursday at 18:00 ===');
const w = { dayOfMonth: 1, dayOfWeek: 4, hour: 18 };
check('Friday 8/21 → Thursday 8/20 18:00',  periodStartAt('weekly', at('2026-08-21T10:00:00'), w), '2026-08-20 18:00');
check('Thursday 17:00, before the hour → the Thursday before',   periodStartAt('weekly', at('2026-08-20T17:00:00'), w), '2026-08-13 18:00');
check('Thursday 18:00, exactly on it → that day',       periodStartAt('weekly', at('2026-08-20T18:00:00'), w), '2026-08-20 18:00');
check('Monday 8/17 → the previous Thursday, 8/13',      periodStartAt('weekly', at('2026-08-17T09:00:00'), w), '2026-08-13 18:00');
check('Sunday 8/23 → Thursday 8/20',        periodStartAt('weekly', at('2026-08-23T23:00:00'), w), '2026-08-20 18:00');
check('the period ends the following Thursday',              periodEndAt('weekly', at('2026-08-21T10:00:00'), w),   '2026-08-27 18:00');

console.log('\n=== Daily: anchored at 09:00 ===');
const d9 = { dayOfMonth: 1, dayOfWeek: 1, hour: 9 };
check('14:00 → 09:00 that day',            periodStartAt('daily', at('2026-08-18T14:00:00'), d9), '2026-08-18 09:00');
check('08:00, before the hour → 09:00 yesterday',    periodStartAt('daily', at('2026-08-18T08:00:00'), d9), '2026-08-17 09:00');
check('00:30 → 09:00 yesterday',            periodStartAt('daily', at('2026-08-18T00:30:00'), d9), '2026-08-17 09:00');
check('it ends at 09:00 the next day',             periodEndAt('daily', at('2026-08-18T14:00:00'), d9),   '2026-08-19 09:00');
check('across a month end: 8/31 08:00 → 8/30',     periodStartAt('daily', at('2026-08-31T08:00:00'), d9), '2026-08-30 09:00');

console.log('\n=== Invalid input is clamped into range ===');
// 99 clamps to 31. On 8/20 the 31st has not arrived, so the period began 7/31 — correct
check('dayOfMonth=99 clamps to 31, so the period began 7/31', periodStartAt('monthly', at('2026-08-20T00:00:00'), { dayOfMonth: 99, dayOfWeek: 1, hour: 0 }), '2026-07-31 00:00');
check('with dayOfMonth=99 the period ends 8/31',        periodEndAt('monthly', at('2026-08-20T00:00:00'), { dayOfMonth: 99, dayOfWeek: 1, hour: 0 }), '2026-08-31 00:00');
check('hour=-5 becomes 0',                periodStartAt('daily', at('2026-08-18T14:00:00'), { dayOfMonth: 1, dayOfWeek: 1, hour: -5 }), '2026-08-18 00:00');
check('undefined defaults to day 1 at 00:00',     periodStartAt('monthly', at('2026-08-20T00:00:00'), undefined), '2026-08-01 00:00');

console.log('\n=== The descriptions ===');
for (const [p, a] of [['monthly', m], ['monthly', m31], ['weekly', w], ['daily', d9], ['total', m]] as const)
  console.log(`  ${p.padEnd(8)} → ${describeAnchor(p as any, a)}`);

console.log(`\n${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);

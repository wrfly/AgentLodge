/**
 * A surcharge that has to land on the vendor's hours, not the deployment's.
 *
 * The whole risk in time-of-day pricing is that getting the zone wrong produces a
 * completely plausible answer. A deployment on TZ=Asia/Shanghai reading these windows
 * locally would apply DeepSeek's surcharge from 01:00 to 04:00 *Shanghai* time — eight
 * hours early, on hours that look exactly as right as the correct ones, and the only place
 * the mistake shows up is a monthly invoice that disagrees with the bill by a few percent.
 *
 * So the first thing this file does is pin a non-UTC zone, and then assert that none of the
 * answers move. Every other suite that pins TZ pins it to UTC (quota.test.ts:21,
 * refusal.test.ts:20, pool-share.test.ts:17), which is the one value that could not catch
 * this.
 *
 * Run: npm -w @agentlodge/server run test:peak-hours
 */

// Before importing anything that touches a Date. Chosen for being a whole number of hours
// off UTC with no DST, so a failure here is unambiguously about the zone and not about a
// transition.
process.env.TZ = 'Asia/Shanghai';

const { describePeak, isPeakAt, parsePeak, parsePeakError, validatePeak, WEEKDAYS } = await import(
  './peak-hours.js'
);

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

/** DeepSeek's, verbatim: Mon–Fri 01:00–04:00 and 06:00–10:00 UTC */
const DEEPSEEK = { days: WEEKDAYS, hours: [[1, 4], [6, 10]] as Array<[number, number]> };
const at = (iso: string) => new Date(iso);

console.log(`\n=== the zone this runs in is ${process.env.TZ}, and it must not matter ===`);
{
  // 2026-09-14 is a Monday in UTC. At 02:00Z it is 10:00 in Shanghai — outside both
  // windows if anyone read the hours locally.
  ok('02:00 UTC on a Monday is peak', isPeakAt(DEEPSEEK, at('2026-09-14T02:00:00Z')));

  // And the mirror: 18:00Z Monday is 02:00 Tuesday in Shanghai, which a local reader would
  // call peak. It is not.
  ok('18:00 UTC on a Monday is not', !isPeakAt(DEEPSEEK, at('2026-09-14T18:00:00Z')));

  // Same instant, written with an offset instead of Z. Date parses both to the same moment,
  // and getUTC* is what reads it — so the answer has to agree.
  ok(
    'an offset-form timestamp gives the same answer as its Z form',
    isPeakAt(DEEPSEEK, at('2026-09-14T10:00:00+08:00')) === isPeakAt(DEEPSEEK, at('2026-09-14T02:00:00Z')),
  );
}

console.log('\n=== the windows themselves ===');
{
  ok('00:59 is before the first window', !isPeakAt(DEEPSEEK, at('2026-09-14T00:59:00Z')));
  ok('01:00 opens it', isPeakAt(DEEPSEEK, at('2026-09-14T01:00:00Z')));
  ok('03:59 is still inside', isPeakAt(DEEPSEEK, at('2026-09-14T03:59:59Z')));
  // Half-open: the end belongs to the next range, not this one. Otherwise two adjacent
  // windows would both claim the boundary and the answer would depend on their order.
  ok('04:00 closes it', !isPeakAt(DEEPSEEK, at('2026-09-14T04:00:00Z')));
  ok('05:00 falls in the gap between the two windows', !isPeakAt(DEEPSEEK, at('2026-09-14T05:00:00Z')));
  ok('06:00 opens the second', isPeakAt(DEEPSEEK, at('2026-09-14T06:00:00Z')));
  ok('09:59 is inside it', isPeakAt(DEEPSEEK, at('2026-09-14T09:59:00Z')));
  ok('10:00 closes it', !isPeakAt(DEEPSEEK, at('2026-09-14T10:00:00Z')));
  ok('a half hour past the open is inside', isPeakAt(DEEPSEEK, at('2026-09-14T01:30:00Z')));
}

console.log('\n=== the days ===');
{
  ok('Friday 2026-09-18 at 02:00 is peak', isPeakAt(DEEPSEEK, at('2026-09-18T02:00:00Z')));
  ok('Saturday 2026-09-19 at 02:00 is not', !isPeakAt(DEEPSEEK, at('2026-09-19T02:00:00Z')));
  ok('Sunday 2026-09-20 at 02:00 is not', !isPeakAt(DEEPSEEK, at('2026-09-20T02:00:00Z')));

  // The Shanghai trap in its sharpest form: Saturday 02:00 local is Friday 18:00 UTC —
  // off-peak — while Monday 02:00 local is Sunday 18:00 UTC, also off-peak. A local reader
  // gets the weekend boundary wrong in both directions.
  ok('Saturday 02:00 Shanghai is Friday 18:00 UTC, and off-peak', !isPeakAt(DEEPSEEK, at('2026-09-18T18:00:00Z')));
}

console.log('\n=== a row with no schedule ===');
{
  ok('null windows are never peak', !isPeakAt(null, at('2026-09-14T02:00:00Z')));
}

console.log('\n=== what may be stored ===');
{
  ok('DeepSeek’s own schedule validates', validatePeak(DEEPSEEK) === undefined);
  ok('null is allowed — it means no schedule', validatePeak(null) === undefined);
  ok('a day outside 0–6 is refused', validatePeak({ days: [7], hours: [[1, 2]] }) !== undefined);
  ok('no days is refused', validatePeak({ days: [], hours: [[1, 2]] }) !== undefined);
  ok('no hours is refused', validatePeak({ days: [1], hours: [] }) !== undefined);
  ok('an hour past 24 is refused', validatePeak({ days: [1], hours: [[20, 25]] }) !== undefined);
  // An inverted range is the dangerous one: it parses, stores, and silently never matches,
  // so the surcharge just never applies and the table still looks configured.
  ok('an inverted range is refused', validatePeak({ days: [1], hours: [[10, 6]] }) !== undefined);
  ok('an empty range is refused', validatePeak({ days: [1], hours: [[6, 6]] }) !== undefined);
  ok('a single number instead of a pair is refused', validatePeak({ days: [1], hours: [[6]] }) !== undefined);
}

console.log('\n=== reading it back ===');
{
  ok('a stored schedule round-trips', JSON.stringify(parsePeak(JSON.stringify(DEEPSEEK))) === JSON.stringify(DEEPSEEK));
  ok('nothing stored reads as no schedule', parsePeak(null) === null);
  ok('empty text reads as no schedule', parsePeak('') === null);
  // Unusable values read as "no schedule" on the pricing path rather than throwing, because
  // that path prices every request. parsePeakError is how a caller says so out loud.
  ok('broken JSON reads as no schedule', parsePeak('{oh dear') === null);
  ok('and it can say why', parsePeakError('{oh dear') === 'peak windows are not valid JSON');
  ok('a structurally wrong value reads as no schedule', parsePeak('{"days":[9],"hours":[[1,2]]}') === null);
  ok('and it can say why too', (parsePeakError('{"days":[9],"hours":[[1,2]]}') ?? '').includes('day of the week'));
}

console.log('\n=== how it reads in the console ===');
{
  ok(
    'a contiguous run of days is a range',
    describePeak(DEEPSEEK) === 'Mon–Fri 01–04, 06–10 UTC',
    describePeak(DEEPSEEK),
  );
  ok(
    'a gap in the days is listed rather than smoothed over',
    describePeak({ days: [1, 2, 4], hours: [[1, 2]] }) === 'Mon, Tue, Thu 01–02 UTC',
    describePeak({ days: [1, 2, 4], hours: [[1, 2]] }),
  );
  ok(
    'a range with minutes still prints them',
    describePeak({ days: [1], hours: [[1.5, 2]] }) === 'Mon 01:30–02 UTC',
    describePeak({ days: [1], hours: [[1.5, 2]] }),
  );
  ok('no schedule describes as nothing', describePeak(null) === '');
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

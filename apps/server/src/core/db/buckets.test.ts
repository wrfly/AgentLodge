/**
 * The chart's bucket walk, driven across daylight saving with a fixed clock.
 *
 * This is the part that had the bugs, and both needed a date the calendar will not hand you
 * on demand: a fall-back that has already happened, read from a machine standing in the
 * middle of a later day. So the timezone and the clock are both arguments here rather than
 * whatever the test machine happens to be — the rest of the series tests run against the
 * ambient zone and cannot reach these cases at all.
 *
 * Run: npm -w @agentlodge/server run test:buckets
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-buckets-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('./index.js');
initDb();
const { bucketKeys } = await import('./usage.js');

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

/** Local wall-clock time in whichever zone is set, as an instant */
const local = (s: string) => new Date(s).getTime();

function inZone(tz: string, body: () => void): void {
  const had = process.env.TZ;
  process.env.TZ = tz;
  try {
    body();
  } finally {
    process.env.TZ = had;
  }
}

console.log('\n=== A fall-back does not cost the chart its last day ===');
inZone('America/New_York', () => {
  /*
   * New York puts its clocks back on 2026-11-01, so that day is 25 hours long. Stepping by a
   * fixed 86 400 000 from the 1st lands on the 1st at 23:00, and every step after it stays an
   * hour behind — so producing today's bucket needs a moment 23 hours into the future and the
   * walk stops a day short. The day's usage is still in the total printed above the chart,
   * which is the report: the bars add up to less than the headline.
   */
  const from = new Date('2026-11-01T00:00:00').toISOString();
  const to = new Date('2026-11-06T00:00:00').toISOString();   // end of the 5th
  const now = local('2026-11-05T10:00:00');
  const keys = bucketKeys(from, to, 'day', now);
  ok('one bucket per calendar day up to today', keys?.length === 5, JSON.stringify(keys));
  ok('and the last one is today', keys?.at(-1) === '2026-11-05', String(keys?.at(-1)));
  ok('no day is missing from the middle',
    JSON.stringify(keys) === JSON.stringify(
      ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']),
    JSON.stringify(keys));
});

console.log('\n=== A spring-forward does not double one either ===');
inZone('America/New_York', () => {
  // 2026-03-08 is 23 hours long
  const keys = bucketKeys(
    new Date('2026-03-06T00:00:00').toISOString(),
    new Date('2026-03-11T00:00:00').toISOString(),
    'day',
    local('2026-03-10T10:00:00'),
  );
  ok('five days, none repeated', keys?.length === 5, JSON.stringify(keys));
  ok('the short day is one bucket like any other', keys?.includes('2026-03-08') === true, JSON.stringify(keys));
});

console.log('\n=== The repeated hour is one bucket, because the query groups it as one ===');
inZone('America/New_York', () => {
  /*
   * 01:00 happens twice on the morning of a fall-back, and SQLite's `strftime(…, 'localtime')`
   * gives both the same key — so the grouped row holds both hours and the walk must not ask
   * for it twice.
   */
  const keys = bucketKeys(
    new Date('2026-11-01T00:00:00').toISOString(),
    new Date('2026-11-01T05:00:00').toISOString(),
    'hour',
    local('2026-11-02T00:00:00'),
  );
  ok('no key appears twice', new Set(keys).size === keys?.length, JSON.stringify(keys));
  ok('and they are in order',
    JSON.stringify(keys) === JSON.stringify([...(keys ?? [])].sort()), JSON.stringify(keys));
});

console.log('\n=== The end of the range is exclusive ===');
inZone('Asia/Shanghai', () => {
  /*
   * A custom range typed as two bare dates is stored with `to` moved to the following
   * midnight, so the day the user named is included whole. The walk used to emit a bucket
   * starting exactly at that boundary — always empty, and the chart prints the last key as
   * its right-hand axis label, so the card read `08-01 ~ 08-15` over an axis ending 08-16.
   */
  const keys = bucketKeys(
    new Date('2026-08-01T00:00:00').toISOString(),
    new Date('2026-08-16T00:00:00').toISOString(),
    'day',
    local('2026-09-01T00:00:00'),
  );
  ok('fifteen days, not sixteen', keys?.length === 15, String(keys?.length));
  ok('ending on the day that was asked for', keys?.at(-1) === '2026-08-15', String(keys?.at(-1)));
});

console.log('\n=== Nothing in the future, and nothing unbounded ===');
inZone('Asia/Shanghai', () => {
  const keys = bucketKeys(
    new Date('2026-09-01T00:00:00').toISOString(),
    new Date('2026-10-01T00:00:00').toISOString(),
    'day',
    local('2026-09-11T10:00:00'),
  );
  ok('a month still running stops at today', keys?.at(-1) === '2026-09-11', String(keys?.at(-1)));
  ok('and has as many buckets as days so far', keys?.length === 11, String(keys?.length));

  const epoch = bucketKeys('1970-01-01T00:00:00.000Z', new Date('2026-09-12T00:00:00').toISOString(), 'day');
  ok('a range back to the epoch is refused rather than filled', epoch === undefined, String(epoch?.length));
});

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * What the administrator's console is told about the shared plan.
 *
 * The failures worth catching are quiet ones: a window parsed under the wrong name shows an
 * empty card, a reset left as unix seconds prints as 1787485541, and a response that carries
 * no limit headers at all — a mock upstream, a 429 from our own gate — must not erase the
 * last real reading.
 *
 * Run: npm -w @agentlodge/server run test:upstream-allowance
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * A database, because record() writes the two resets it sees into settings — that is how the
 * quota windows come to be cut on the upstream's own boundaries. Set up before the module
 * loads: config reads DATA_DIR when it is imported, and static imports run first.
 */
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-allowance-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('../core/db/index.js');
initDb();
const { getStringFresh, setSetting } = await import('../core/db/settings.js');
const { record, recordCodex, refusesOnlySomeModels, reset, snapshot, snapshotFor, snapshots } = await import('./upstream-allowance.js');

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

/**
 * The resets the fixtures carry, as unix seconds.
 *
 * Relative to now rather than the instants the capture was taken at: a reading is dropped
 * once its own reset has passed, so a fixture pinned to a date in 2026 would start failing
 * the day the suite outlived it — which is exactly the behaviour under test, arriving as a
 * false alarm. `R_PAST` is the one that is deliberately behind us.
 */
const epoch = (msFromNow: number): string => String(Math.round((Date.now() + msFromNow) / 1000));
const iso = (secs: string): string => new Date(Number(secs) * 1000).toISOString();
const HOUR = 3_600_000;
const R_5H = epoch(3 * HOUR);
const R_7D = epoch(60 * HOUR);
const R_7D_ALT = epoch(90 * HOUR);
const R_OI = epoch(100 * HOUR);
const R_PAST = epoch(-HOUR);

/** A real capture, taken through the audit proxy against the official endpoint */
const CAPTURED: Record<string, string> = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': R_5H,
  'anthropic-ratelimit-unified-5h-utilization': '0.22',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': R_7D,
  'anthropic-ratelimit-unified-7d-utilization': '0.59',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-reset': R_5H,
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'content-type': 'text/event-stream',
  'request-id': 'req_011',
};

/**
 * The 429 when Fable's weekly allowance ran out, captured the same way. Only the Fable window
 * is rejected; the 5-hour and weekly ones are still open, and retry-after runs to the weekly
 * reset five days out.
 */
const FABLE_REFUSED: Record<string, string> = {
  'anthropic-ratelimit-unified-status': 'rejected',
  'anthropic-ratelimit-unified-representative-claim': 'seven_day_overage_included',
  'anthropic-ratelimit-unified-reset': '1789992000',
  'anthropic-ratelimit-unified-fallback': 'available',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-utilization': '0.68',
  'anthropic-ratelimit-unified-5h-reset': '1789557600',
  'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
  'anthropic-ratelimit-unified-7d-utilization': '0.78',
  'anthropic-ratelimit-unified-7d-reset': '1789992000',
  'anthropic-ratelimit-unified-7d-surpassed-threshold': '0.75',
  'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
  'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
  'anthropic-ratelimit-unified-7d_oi-reset': '1789992000',
  'anthropic-ratelimit-unified-7d_oi-surpassed-threshold': '1.0',
  'retry-after': '436688',
  'x-should-retry': 'true',
  'content-type': 'application/json',
};

const headers = (o: Record<string, string>): Headers => new Headers(o);

console.log('\n=== A real header set, parsed ===');
{
  reset();
  record('anthropic-official', 'anthropic', headers(CAPTURED));
  const a = snapshot()!;
  ok('it recorded something', a !== null);
  ok('the provider is named', a.provider === 'anthropic-official');
  ok('the top-level status', a.status === 'allowed');
  ok('the representative window', a.representative === 'five_hour');
  ok('the 5h window is utilization on the header scale', a.windows['5h']?.utilization === 0.22, JSON.stringify(a.windows['5h']));
  ok('the 7d window too', a.windows['7d']?.utilization === 0.59);
  ok(
    'unix seconds became a timestamp',
    a.windows['5h']?.resetsAt === iso(R_5H),
    String(a.windows['5h']?.resetsAt),
  );
  ok('the top-level reset too', a.resetsAt === iso(R_5H));
  ok('per-window status is kept', a.windows['5h']?.status === 'allowed');
  ok('overage is a window of its own', a.windows.overage?.status === 'rejected', JSON.stringify(a.windows.overage));
}

console.log('\n=== The raw copy is complete, and only about limits ===');
{
  reset();
  record('p', 'anthropic', headers(CAPTURED));
  const raw = snapshot()!.raw;
  ok('every ratelimit header survives', Object.keys(raw).length === 12, String(Object.keys(raw).length));
  ok('including ones we do not parse', raw['anthropic-ratelimit-unified-fallback-percentage'] === '0.5');
  ok('content-type is not allowance information', raw['content-type'] === undefined);
  ok('nor is the request id', raw['request-id'] === undefined);
}

console.log('\n=== A response that says nothing keeps the last real reading ===');
{
  reset();
  record('p', 'anthropic', headers(CAPTURED));
  record('p', 'anthropic', headers({ 'content-type': 'application/json' }));
  ok('the reading survives', snapshot()?.windows['5h']?.utilization === 0.22);
}

console.log('\n=== Codex reports in the body, not in headers ===');
{
  reset();
  const rl = { primary: { used_percent: 73.4, window_minutes: 300 } };
  recordCodex('codex-sub', 'responses', rl);
  const a = snapshot()!;
  ok('it is kept as sent', JSON.stringify(a.codex) === JSON.stringify(rl));
  ok('the provider is named', a.provider === 'codex-sub');
  ok('with no header windows invented', Object.keys(a.windows).length === 0);
}
{
  reset();
  record('same', 'responses', headers(CAPTURED));
  recordCodex('same', 'responses', { primary: { used_percent: 1 } });
  ok('headers and body figures from one provider coexist', snapshot()?.windows['5h']?.utilization === 0.22 && snapshot()?.codex !== undefined);
}
{
  reset();
  recordCodex('codex-sub', 'responses', { primary: {} });
  record('anthropic-official', 'anthropic', headers(CAPTURED));
  ok(
    "another provider's body figures are not carried over",
    snapshot()?.provider === 'anthropic-official',
  );
}

console.log('\n=== Before anything has come back ===');
{
  reset();
  ok('there is nothing rather than an empty shell', snapshot() === null);
}

console.log('\n=== Junk in a header does not become a number ===');
{
  reset();
  record('p', 'anthropic', headers({
    'anthropic-ratelimit-unified-5h-utilization': 'n/a',
    'anthropic-ratelimit-unified-5h-reset': 'soon',
  }));
  ok('an unparseable utilization is null, not NaN', snapshot()?.windows['5h']?.utilization === null);
  ok('an unparseable reset is null, not Invalid Date', snapshot()?.windows['5h']?.resetsAt === null);
}

console.log('\n=== A window nobody mentioned this time is still the last thing said ===');
{
  // Fable is the only model whose responses carry 7d_oi, so every other turn — including
  // the naming call on haiku — used to wipe it a second after it arrived
  record('Claude', 'anthropic', headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.10',
    'anthropic-ratelimit-unified-7d-utilization': '0.40',
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.25',
    'anthropic-ratelimit-unified-7d_oi-reset': R_OI,
  }));
  const fable = snapshot()?.windows['7d_oi'];

  record('Claude', 'anthropic', headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.11',
    'anthropic-ratelimit-unified-7d-utilization': '0.41',
  }));
  const after = snapshot();

  ok('the windows this response carried are current', after?.windows['5h']?.utilization === 0.11);
  ok("the one it did not is still there", after?.windows['7d_oi']?.utilization === 0.25, JSON.stringify(after?.windows));
  ok('with the reset it came with', after?.windows['7d_oi']?.resetsAt === fable?.resetsAt);
  ok('and its own timestamp, not this response\'s', after?.windows['7d_oi']?.observedAt === fable?.observedAt);
  ok('while a window this response did carry is stamped now', after?.windows['5h']?.observedAt === after?.observedAt);

  // A different upstream is a different plan; nothing carries over
  record('DeepSeek', 'anthropic', headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.02' }));
  ok('another provider starts clean', snapshot()?.windows['7d_oi'] === undefined, JSON.stringify(snapshot()?.windows));
  ok(
    'the previous upstream is still on file',
    snapshotFor('Claude')?.windows['7d_oi']?.utilization === 0.25,
    JSON.stringify(snapshotFor('Claude')?.windows),
  );
  ok('and both appear on the console list', snapshots().some((a) => a.provider === 'Claude') && snapshots().some((a) => a.provider === 'DeepSeek'));
}

console.log('\n=== The resets are written down, so the quota windows can follow them ===');
{
  reset(); // also clears what has already been persisted, so the next record() writes
  setSetting('quota.windowResetAt', 'stale');
  setSetting('quota.weekResetAt', 'stale');
  record('anthropic-official', 'anthropic', headers(CAPTURED));
  ok(
    'the 5-hour reset is kept',
    getStringFresh('quota.windowResetAt') === iso(R_5H),
    String(getStringFresh('quota.windowResetAt')),
  );
  ok(
    'and the weekly one, which used to be the administrator’s calendar week',
    getStringFresh('quota.weekResetAt') === iso(R_7D),
    String(getStringFresh('quota.weekResetAt')),
  );
}
{
  /*
   * Every response for the next five hours repeats the same reset. Writing it each time
   * would be a settings write per upstream call, on the response path.
   */
  setSetting('quota.weekResetAt', 'sentinel');
  record('anthropic-official', 'anthropic', headers(CAPTURED));
  ok('an unchanged reset is not written again', getStringFresh('quota.weekResetAt') === 'sentinel', String(getStringFresh('quota.weekResetAt')));

  record('anthropic-official', 'anthropic', headers({ ...CAPTURED, 'anthropic-ratelimit-unified-7d-reset': R_7D_ALT }));
  ok(
    'a different one is',
    getStringFresh('quota.weekResetAt') === iso(R_7D_ALT),
    String(getStringFresh('quota.weekResetAt')),
  );
  ok('and the 5-hour key it shares the response with is untouched by that', getStringFresh('quota.windowResetAt') === iso(R_5H));
}

console.log('\n=== A reading does not outlive the window it describes ===');
{
  /*
   * The console used to print "100%, resets 20:00" at 21:00, because nothing refreshes a
   * window until some model counts against it again — days, for Fable's weekly one. What
   * replaces the figure is nothing rather than zero: the headers say when the limit lifts,
   * never what the next window opens at.
   */
  reset();
  record('Claude', 'anthropic', headers({
    'anthropic-ratelimit-unified-5h-status': 'allowed',
    'anthropic-ratelimit-unified-5h-utilization': '0.22',
    'anthropic-ratelimit-unified-5h-reset': R_5H,
    'anthropic-ratelimit-unified-7d_oi-status': 'rejected',
    'anthropic-ratelimit-unified-7d_oi-utilization': '1.0',
    'anthropic-ratelimit-unified-7d_oi-reset': R_PAST,
  }));
  const oi = snapshot()?.windows['7d_oi'];
  ok('a window past its reset is marked expired', oi?.expired === true, JSON.stringify(oi));
  ok('its utilization is dropped, not zeroed', oi?.utilization === null);
  ok('and so is the status it was rejected under', oi?.status === null);
  ok('the reset it expired at is kept, to explain why', oi?.resetsAt === iso(R_PAST));
  ok('as is when it was read', typeof oi?.observedAt === 'string');
  ok('a window still inside its own window is untouched', snapshot()?.windows['5h']?.utilization === 0.22);
  ok('every reader sees the same', snapshotFor('Claude')?.windows['7d_oi']?.utilization === null);
  ok('including the console list', snapshots()[0]?.windows['7d_oi']?.expired === true);

  // The next response that mentions it is a real reading again, expired flag and all
  record('Claude', 'anthropic', headers({
    'anthropic-ratelimit-unified-7d_oi-utilization': '0.05',
    'anthropic-ratelimit-unified-7d_oi-reset': R_OI,
  }));
  const fresh = snapshot()?.windows['7d_oi'];
  ok('a fresh reading clears the mark', fresh?.expired === undefined, JSON.stringify(fresh));
  ok('with the new figure', fresh?.utilization === 0.05);

  // A window with no reset at all has nothing to outlive
  reset();
  record('p', 'anthropic', headers({ 'anthropic-ratelimit-unified-5h-utilization': '0.3' }));
  ok('a window with no reset never expires', snapshot()?.windows['5h']?.expired === undefined);
}

console.log('\n=== A refusal says whether it closes the plan or only some models ===');
{
  ok('the captured Fable refusal closes only some models', refusesOnlySomeModels(429, headers(FABLE_REFUSED)));

  const refusal = (claim: string, extra: Record<string, string> = {}): Headers =>
    headers({ 'anthropic-ratelimit-unified-representative-claim': claim, ...extra });

  for (const claim of ['seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet']) {
    ok(`${claim} refuses only some models`, refusesOnlySomeModels(429, refusal(claim)));
  }
  for (const claim of ['five_hour', 'seven_day', 'overage']) {
    ok(`${claim} refuses the whole plan`, !refusesOnlySomeModels(429, refusal(claim)));
  }
  ok('a claim nobody has listed is taken as the narrower kind', refusesOnlySomeModels(429, refusal('seven_day_something_new')));
  ok('a 429 that names no claim is a rate limit', !refusesOnlySomeModels(429, headers({ 'retry-after': '5' })));
  // Successful responses name a claim too, so the status is what makes it a refusal
  ok('a 200 refuses nothing', !refusesOnlySomeModels(200, refusal('seven_day_overage_included')));
  ok(
    'a 429 whose allowance is still allowed is a rate limit',
    !refusesOnlySomeModels(429, refusal('seven_day_overage_included', { 'anthropic-ratelimit-unified-status': 'allowed' })),
  );
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

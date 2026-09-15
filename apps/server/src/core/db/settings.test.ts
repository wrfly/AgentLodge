/**
 * The gateway's per-user slot limit as a setting: what it accepts, and how the other
 * container reads it.
 *
 * Two things that only look like one. The value has to be refused when it is unusable —
 * the gate falls back to its configured limit for anything it cannot use, so a zero typed
 * into the box would be stored, silently overridden, and leave somebody looking at a saved
 * setting that does nothing. And it has to be readable past the per-process cache, because
 * the console writes it in the app container and the gate reads it in the gateway one.
 *
 * Run: npm -w @agentlodge/server run test:settings
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-settings-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
// The variable under test is a fallback read from the ambient environment — and a machine
// set up to run this deployment is exactly the machine that exports it. Owned here.
delete process.env.PER_USER_INFLIGHT_MAX;

const { initDb, run } = await import('./index.js');
initDb();
const { setSetting, getNumber, getNumberFresh, listSettings } = await import('./settings.js');

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

const KEY = 'gateway.perUserInflightMax';
const refused = (v: string): string | undefined => {
  try {
    setSetting(KEY, v);
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

console.log('\n=== A limit the gate cannot use is refused, not stored ===');
{
  for (const v of ['0', '-1', 'abc', '2.5', '999']) {
    ok(`${JSON.stringify(v)} is refused`, refused(v) !== undefined, `stored as ${getNumberFresh(KEY)}`);
  }
  ok('and the message says what is wanted', /1 to 64/.test(refused('0') ?? ''), refused('0'));
  ok('a whole number in range goes in', refused('4') === undefined);
  ok('and is what comes back', getNumberFresh(KEY) === 4, String(getNumberFresh(KEY)));
  /*
   * Empty is not zero: it is "never set", which is what the box shows before anybody touches
   * it and what clearing it has to mean. The environment variable, then the default.
   */
  ok('empty is allowed', refused('') === undefined);
  ok('and falls back to the default', getNumberFresh(KEY) === 2, String(getNumberFresh(KEY)));
}

console.log('\n=== The environment variable is the fallback, not the value ===');
{
  process.env.PER_USER_INFLIGHT_MAX = '7';
  ok('an unset setting takes it', getNumberFresh(KEY) === 7, String(getNumberFresh(KEY)));
  setSetting(KEY, '3');
  ok('and a set one wins over it', getNumberFresh(KEY) === 3, String(getNumberFresh(KEY)));
  setSetting(KEY, '');
  ok('clearing hands it back', getNumberFresh(KEY) === 7, String(getNumberFresh(KEY)));
  delete process.env.PER_USER_INFLIGHT_MAX;
  ok('with neither, the default', getNumberFresh(KEY) === 2, String(getNumberFresh(KEY)));
}

console.log('\n=== Read past the cache, because the reader is another container ===');
{
  /*
   * The cache is per process and invalidated only by a write in that process. The gateway
   * never writes this one, so a cached read there is whatever it happened to load first —
   * a restart behind the page that offers to change it. Written straight to the table here,
   * which is what the other process's write looks like from this one: no invalidation.
   */
  setSetting(KEY, '5');
  ok('both agree to start with', getNumber(KEY) === 5 && getNumberFresh(KEY) === 5,
    `${getNumber(KEY)} / ${getNumberFresh(KEY)}`);

  run('update settings set value = ? where key = ?', '9', KEY);
  ok('the cached read is now stale', getNumber(KEY) === 5, String(getNumber(KEY)));
  ok('and the fresh one is not', getNumberFresh(KEY) === 9, String(getNumberFresh(KEY)));
}

console.log('\n=== It reaches the console as a field of its own ===');
{
  const row = listSettings().find((s) => s.key === KEY);
  ok('the console is offered it', Boolean(row), 'missing from listSettings()');
  ok('in a group of its own', row?.group === 'gateway', String(row?.group));
  ok('as a number', row?.type === 'number', String(row?.type));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

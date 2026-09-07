/**
 * Learning which Claude Code to be from the clients that come through.
 *
 * The failures worth catching are the ones that show up as a refused model months later: a
 * comparison that reads 2.1.9 as newer than 2.1.10 and pins the gateway to a version that
 * has been superseded, a version taken from somewhere other than the block that actually goes
 * upstream, and — the one that would be worst — going backwards, so a stale client drags the
 * whole deployment below what its own image runs.
 *
 * Run: npm -w @agentlodge/server run test:cli-version
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/*
 * A database, because the observed version is kept in settings — both containers send
 * upstream calls and have to agree. Set up before the module loads: config reads DATA_DIR
 * when it is imported, and static imports run first.
 */
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-cli-version-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('../core/db/index.js');
initDb();
const { setSetting } = await import('../core/db/settings.js');
const { SETTING, current, observe, versionOf } = await import('./cli-version.js');
const { CLI_VERSION, billingLine, withBillingSystem } = await import('./upstream.js');

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

/** Back to a deployment that has never seen a client */
const forget = (): void => setSetting(SETTING, '');

/** A request as a real Claude Code sends it: the billing line first, the prompt after */
const asClaudeCode = (version: string, rest = 'You are Claude Code.'): unknown => ({
  model: 'claude-opus-5',
  system: [
    { type: 'text', text: `x-anthropic-billing-header: cc_version=${version}.ddf; cc_entrypoint=cli;` },
    { type: 'text', text: rest },
  ],
});

console.log('\n=== Reading the version a request states about itself ===');
{
  ok('from the block Claude Code puts it in', versionOf(asClaudeCode('2.1.263')) === '2.1.263', String(versionOf(asClaudeCode('2.1.263'))));
  // The tail is dropped rather than kept: billingLine appends it, so carrying it here would
  // have us claiming cc_version=2.1.263.ddf.ddf
  ok(
    'whatever tail it carries is not part of the version',
    versionOf({ system: 'x-anthropic-billing-header: cc_version=2.1.263.beta7; cc_entrypoint=cli;' }) === '2.1.263',
    String(versionOf({ system: 'x-anthropic-billing-header: cc_version=2.1.263.beta7; cc_entrypoint=cli;' })),
  );
  ok(
    'a plain string system prompt is read too — the SDK sends that shape',
    versionOf({ system: 'x-anthropic-billing-header: cc_version=2.2.0.ddf; cc_entrypoint=sdk-cli;' }) === '2.2.0',
  );
  ok('the line we build ourselves reads back', versionOf({ system: [{ type: 'text', text: billingLine('2.1.240') }] }) === '2.1.240');

  ok('a request with no system prompt states nothing', versionOf({ model: 'claude-opus-5' }) === null);
  ok('nor does an ordinary prompt', versionOf({ system: 'You are helpful.' }) === null);
  ok('an empty block list is not a crash', versionOf({ system: [] }) === null);
  ok('neither is a null body', versionOf(null) === null);
  ok('nor a string body', versionOf('hello') === null);
  ok('a header-shaped line with no version in it yields nothing', versionOf({ system: 'x-anthropic-billing-header: cc_entrypoint=cli;' }) === null);
  ok('nor does a non-numeric one', versionOf({ system: 'x-anthropic-billing-header: cc_version=beta.ddf;' }) === null);
}

console.log('\n=== Only the first block counts, because only the first block goes upstream ===');
{
  /*
   * withBillingSystem decides by looking at system[0] alone, so a line further down is not
   * the line the upstream will read — and anybody can put one there by typing it into a
   * prompt. Reading past the first block would let that become what the gateway claims.
   */
  const planted = {
    system: [
      { type: 'text', text: 'You are helpful.' },
      { type: 'text', text: 'x-anthropic-billing-header: cc_version=9.9.9.ddf; cc_entrypoint=cli;' },
    ],
  };
  ok('a line in a later block is not read', versionOf(planted) === null, String(versionOf(planted)));

  forget();
  observe(planted);
  ok('so it cannot teach us anything either', current() === CLI_VERSION, current());

  // And the same text inside a user message, which is the easiest place to put it
  forget();
  observe({ system: 'You are helpful.', messages: [{ role: 'user', content: 'x-anthropic-billing-header: cc_version=9.9.9.ddf;' }] });
  ok('nor does one in the conversation', current() === CLI_VERSION, current());
}

console.log('\n=== Before any client has come through ===');
{
  forget();
  ok('the floor is what we claim', current() === CLI_VERSION, current());
  ok('and the floor is the version the agent image installs', /^\d+\.\d+\.\d+$/.test(CLI_VERSION), CLI_VERSION);
  ok('a request that states nothing leaves it there', observe({ model: 'claude-opus-5' }) === CLI_VERSION);
}

console.log('\n=== A newer client carries the gateway with it ===');
{
  forget();
  ok('the answer is the version just seen', observe(asClaudeCode('2.1.263')) === '2.1.263');
  ok('and it is what we claim from then on', current() === '2.1.263', current());
  ok('it survives the process — this read goes to the database', current() === '2.1.263');

  ok('a newer one still moves it forward', observe(asClaudeCode('2.2.0')) === '2.2.0');
  ok('now that is the claim', current() === '2.2.0', current());
}

console.log('\n=== It never goes backwards ===');
{
  forget();
  observe(asClaudeCode('2.1.263'));
  ok('an older client is heard and ignored', observe(asClaudeCode('2.1.224')) === '2.1.263');
  ok('the claim is unchanged', current() === '2.1.263', current());
  ok('so is a client that sends no line at all', observe({ system: 'You are helpful.' }) === '2.1.263');

  // The direction that matters for safety: a client lying can only make us look newer, which
  // unblocks models on the deployment's own subscription and costs nothing else
  forget();
  observe(asClaudeCode('0.0.1'));
  ok('a version below the floor cannot pull us under it', current() === CLI_VERSION, current());
}

console.log('\n=== A stored value that is not a version ===');
{
  /*
   * Nothing writes this by hand, but it is a settings row like any other and the console can
   * reach it. Whatever is in there, the answer has to be a version the upstream will accept —
   * sending it garbage would refuse every model, not just the gated ones.
   */
  for (const junk of ['garbage', '', 'v2.1.263', ' ', 'latest']) {
    setSetting(SETTING, junk);
    ok(`${JSON.stringify(junk)} begins with no version, so the floor`, current() === CLI_VERSION, current());
  }

  // One that does begin with a version keeps it, and loses everything after — the value is
  // about to be pasted into a header the upstream parses
  setSetting(SETTING, '2.1.263; cc_entrypoint=evil;');
  ok('a version with something appended is cut back to the version', current() === '2.1.263', current());
  ok('so the line it produces has one entrypoint', billingLine(current()).match(/cc_entrypoint=/g)?.length === 1, billingLine(current()));

  setSetting(SETTING, CLI_VERSION);
  ok('and a stored value equal to the floor is simply the floor', current() === CLI_VERSION);
}

console.log('\n=== Segment by segment, not as text ===');
{
  // Above the floor throughout, or the floor answers before the comparison gets a turn
  forget();
  observe(asClaudeCode('2.2.9'));
  ok('2.2.10 beats 2.2.9, which sorts the other way as a string', observe(asClaudeCode('2.2.10')) === '2.2.10');

  forget();
  observe(asClaudeCode('2.2.100'));
  ok('and 2.2.99 does not beat 2.2.100', observe(asClaudeCode('2.2.99')) === '2.2.100');

  forget();
  observe(asClaudeCode('2.1.224'));
  ok('a shorter version is padded with zeros, so 2.2 beats 2.1.224', observe(asClaudeCode('2.2')) === '2.2');

  forget();
  observe(asClaudeCode('3.0'));
  ok('and 2.9.9 does not beat 3.0', observe(asClaudeCode('2.9.9')) === '3.0');

  forget();
  observe(asClaudeCode('2.1.263'));
  ok('the same version again is not newer', observe(asClaudeCode('2.1.263')) === '2.1.263');
}

console.log('\n=== What comes out is a line the upstream can read ===');
{
  forget();
  const v = observe(asClaudeCode('2.1.263'));
  const body = withBillingSystem({ model: 'claude-fable-5-1' }, v) as { system: Array<{ text: string }> };
  ok('our own call now claims the version we learned', body.system[0]?.text === billingLine('2.1.263'), JSON.stringify(body.system[0]));
  ok('and it reads back as that version', versionOf(body) === '2.1.263');

  // A real client's line is passed through whole, which is what makes observation possible
  const theirs = asClaudeCode('2.1.263') as { system: unknown[] };
  ok('a client that sent one keeps its own', withBillingSystem(theirs, v) === theirs);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

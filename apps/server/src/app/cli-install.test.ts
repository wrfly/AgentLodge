/**
 * The install script, actually run.
 *
 * Asserting on the text would have missed both bugs this file was written after:
 *   a backtick in a comment — an unquoted heredoc substitutes it, so the script died with
 *     "Syntax error: || unexpected" before writing anything
 *   grep -v exiting 1 when it filters out every line — the case where the rc file holds our
 *     line and nothing else, so uninstall silently left it behind
 * Neither is visible in a string comparison. So the script is executed against a temporary
 * HOME with a stand-in `claude` on PATH, and the filesystem is what gets checked.
 *
 * Run: npm -w @agentlodge/server run test:cli-install
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installScript } from './cli-install.js';

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

const TEXT = {
  installed: 'installed',
  openShell: 'open a new terminal',
  keyFile: 'to swap the key later',
  undo: 'undo:',
  noClaude: 'claude was not found',
  usage: 'takes your key as an argument',
  noKeyFile: 'the key file is missing',
};

const KEY = 'al_testkey';
const BASE = 'https://lodge.example';

/** A fresh HOME with a stand-in claude, so nothing outside the temporary directory is read or written */
function sandbox(rcContents: string): { home: string; bin: string; rc: string; run: (script: string) => string } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlodge-cli-'));
  const bin = path.join(home, 'fakebin');
  fs.mkdirSync(bin);
  // Echoes back the two variables the wrapper is supposed to set
  fs.writeFileSync(
    path.join(bin, 'claude'),
    '#!/bin/sh\necho "CFG=$CLAUDE_CONFIG_DIR"\necho "BASE=$ANTHROPIC_BASE_URL"\necho "KEYVAR=${ANTHROPIC_API_KEY-unset}/${ANTHROPIC_AUTH_TOKEN-unset}"\necho "ARGS=$*"\n',
    { mode: 0o755 },
  );
  const rc = path.join(home, '.bashrc');
  fs.writeFileSync(rc, rcContents);
  const run = (script: string, key = KEY): string => {
    const file = path.join(home, 'run.sh');
    fs.writeFileSync(file, script);
    return execFileSync('sh', [file, key], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        SHELL: '/bin/bash',
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        // The user's own key must not decide the outcome of this test
        ANTHROPIC_API_KEY: 'sk-ant-should-be-unset',
        ANTHROPIC_AUTH_TOKEN: 'should-be-unset',
      },
    });
  };
  return { home, bin, rc, run };
}

const script = (): string => installScript(BASE, TEXT);

console.log('\n=== It runs, and writes only inside its own directory ===');
{
  const s = sandbox('export EDITOR=vim\n');
  const out = s.run(script());
  ok('it reports success', out.includes('installed'), out);
  const root = path.join(s.home, '.agentlodge');
  ok('a key file of its own', fs.existsSync(path.join(root, 'key')));
  ok('a config directory for the CLI', fs.existsSync(path.join(root, 'claude')));
  ok('a wrapper named claude', fs.existsSync(path.join(root, 'bin', 'claude')));
  ok('an uninstaller', fs.existsSync(path.join(root, 'uninstall.sh')));
  ok('the real binary is remembered', fs.readFileSync(path.join(root, 'real-claude'), 'utf8').trim() === path.join(s.bin, 'claude'));
  ok('~/.claude is not created', !fs.existsSync(path.join(s.home, '.claude')));
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== The key lives on its own, and the credential is built from it ===');
{
  const s = sandbox('');
  s.run(script());
  const keyFile = path.join(s.home, '.agentlodge', 'key');
  ok('the key is a file of its own', fs.readFileSync(keyFile, 'utf8').trim() === KEY);
  ok('readable by its owner only', (fs.statSync(keyFile).mode & 0o777) === 0o600, (fs.statSync(keyFile).mode & 0o777).toString(8));

  // Built by the wrapper, not by the installer — that is what makes swapping the key one edit
  execFileSync(path.join(s.home, '.agentlodge', 'bin', 'claude'), [], { encoding: 'utf8', env: { ...process.env, HOME: s.home } });
  const file = path.join(s.home, '.agentlodge', 'claude', '.credentials.json');
  const cred = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
  ok('the key reached accessToken', cred.accessToken === KEY, String(cred.accessToken));
  ok('user:inference — without it the session is not signed in', cred.scopes.includes('user:inference'));
  ok('user:profile — what the account panel checks', cred.scopes.includes('user:profile'));
  ok('an absolute expiry, in milliseconds, still ahead', typeof cred.expiresAt === 'number' && cred.expiresAt > Date.now());
  ok('the credential is owner-only too', (fs.statSync(file).mode & 0o777) === 0o600, (fs.statSync(file).mode & 0o777).toString(8));
  ok('no temporary file left beside it', fs.readdirSync(path.join(s.home, '.agentlodge', 'claude')).every((f) => !f.includes('.json.')), fs.readdirSync(path.join(s.home, '.agentlodge', 'claude')).join(','));
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== The first-run wizard is not the user\'s problem ===');
{
  const s = sandbox('');
  s.run(script());
  const cfg = path.join(s.home, '.agentlodge', 'claude', '.claude.json');
  ok('a config directory of our own is marked as onboarded', JSON.parse(fs.readFileSync(cfg, 'utf8')).hasCompletedOnboarding === true);
  fs.rmSync(s.home, { recursive: true, force: true });
}
{
  // What the CLI leaves behind after it has been run once without the flag — which is what
  // an install made before this existed looks like
  const s = sandbox('');
  s.run(script());
  const cfg = path.join(s.home, '.agentlodge', 'claude', '.claude.json');
  fs.writeFileSync(cfg, '{\n  "firstStartTime": "2026-08-23T10:40:21.767Z",\n  "machineID": "abc"\n}\n');
  s.run(script());
  const after = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  ok('installing again repairs it', after.hasCompletedOnboarding === true, fs.readFileSync(cfg, 'utf8'));
  ok('without losing what was there', after.machineID === 'abc' && after.firstStartTime === '2026-08-23T10:40:21.767Z');
  fs.rmSync(s.home, { recursive: true, force: true });
}
{
  const s = sandbox('');
  s.run(script());
  const cfg = path.join(s.home, '.agentlodge', 'claude', '.claude.json');
  fs.writeFileSync(cfg, '{"hasCompletedOnboarding":true,"theme":"dark"}');
  s.run(script());
  ok('and leaves an already-marked one alone', fs.readFileSync(cfg, 'utf8') === '{"hasCompletedOnboarding":true,"theme":"dark"}');
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== The status line says what the /usage panel cannot ===');
{
  const s = sandbox('');
  s.run(script());
  const root = path.join(s.home, '.agentlodge');
  const line = path.join(root, 'bin', 'statusline');
  ok('a status line script is installed', fs.existsSync(line));
  ok('and it is executable', (fs.statSync(line).mode & 0o111) !== 0, (fs.statSync(line).mode & 0o777).toString(8));

  const settings = path.join(root, 'claude', 'settings.json');
  ok('settings.json names it', JSON.parse(fs.readFileSync(settings, 'utf8')).statusLine.command === line);

  /** What Claude Code puts on the script's stdin */
  const feed = (json: string): string => execFileSync('sh', [line], { input: json, encoding: 'utf8' });

  // Captured from a real 2.1.250 session, driven against a stand-in gateway answering with
  // the headers unifiedHeaders() writes for a user at 37% of the window and 12% of the week
  const captured =
    '{"model":{"id":"claude-opus-5","display_name":"Opus 5"},"rate_limits":{"five_hour":{"used_percentage":37,"resets_at":1787911394},"seven_day":{"used_percentage":12,"resets_at":1788249794}}}';
  ok('both windows, as the CLI reported them', feed(captured) === '5h 37% · 7d 12%', feed(captured));

  ok(
    'a fraction is rounded rather than printed',
    feed('{"rate_limits":{"five_hour":{"used_percentage":37.62,"resets_at":1},"seven_day":{"used_percentage":8.4,"resets_at":2}}}') === '5h 38% · 7d 8%',
  );
  ok(
    'one window alone does not drag a separator along',
    feed('{"rate_limits":{"five_hour":{"used_percentage":99.9,"resets_at":1}}}') === '5h 100%',
  );
  // The order of the keys inside a window is the CLI's to change, and one day it will
  ok(
    'resets_at first is read the same',
    feed('{"rate_limits":{"seven_day":{"resets_at":2,"used_percentage":50}}}') === '7d 50%',
  );
  // rate_limits only appears once a response has carried the headers
  ok(
    'before the first turn it says nothing rather than something wrong',
    feed('{"model":{"display_name":"Opus 5"},"workspace":{"current_dir":"/tmp"}}') === '',
  );
  fs.rmSync(s.home, { recursive: true, force: true });
}
{
  const s = sandbox('');
  s.run(script());
  const settings = path.join(s.home, '.agentlodge', 'claude', 'settings.json');

  fs.writeFileSync(settings, '{"statusLine":{"type":"command","command":"mine"},"theme":"dark"}');
  s.run(script());
  ok(
    'a status line the user chose survives a reinstall',
    fs.readFileSync(settings, 'utf8') === '{"statusLine":{"type":"command","command":"mine"},"theme":"dark"}',
    fs.readFileSync(settings, 'utf8'),
  );

  fs.writeFileSync(settings, '{\n  "theme": "dark",\n  "model": "opus"\n}\n');
  s.run(script());
  const merged = JSON.parse(fs.readFileSync(settings, 'utf8'));
  ok('a settings.json without one gets it', merged.statusLine?.command.endsWith('/bin/statusline'), fs.readFileSync(settings, 'utf8'));
  ok('and keeps what was already there', merged.theme === 'dark' && merged.model === 'opus');
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== Swapping the key is one edit, no reinstall ===');
{
  const s = sandbox('');
  s.run(script());
  fs.writeFileSync(path.join(s.home, '.agentlodge', 'key'), 'al_replaced\n');
  const out = execFileSync(path.join(s.home, '.agentlodge', 'bin', 'claude'), [], { encoding: 'utf8', env: { ...process.env, HOME: s.home } });
  const cred = JSON.parse(fs.readFileSync(path.join(s.home, '.agentlodge', 'claude', '.credentials.json'), 'utf8')).claudeAiOauth;
  ok('the next run uses the new key', cred.accessToken === 'al_replaced', String(cred.accessToken));
  ok('and nothing else had to change', out.includes(`CFG=${path.join(s.home, '.agentlodge', 'claude')}`), out);

  fs.rmSync(path.join(s.home, '.agentlodge', 'key'));
  let refused = false;
  let err = '';
  try {
    execFileSync(path.join(s.home, '.agentlodge', 'bin', 'claude'), [], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: s.home } });
  } catch (e) {
    refused = true;
    err = String((e as { stderr?: string }).stderr ?? '');
  }
  ok('a missing key file is refused, not run with a stale credential', refused);
  ok('and says so', err.includes('the key file is missing'), err);
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== The wrapper sets the session up and steps aside ===');
{
  const s = sandbox('');
  s.run(script());
  const out = execFileSync(path.join(s.home, '.agentlodge', 'bin', 'claude'), ['-p', 'hi'], {
    encoding: 'utf8',
    env: { ...process.env, HOME: s.home, ANTHROPIC_API_KEY: 'sk-ant-leftover', ANTHROPIC_AUTH_TOKEN: 'leftover' },
  });
  ok('the config directory is ours', out.includes(`CFG=${path.join(s.home, '.agentlodge', 'claude')}`), out);
  ok('the base url is ours', out.includes(`BASE=${BASE}`), out);
  ok(
    'an exported key is cleared — it would outrank the credential file and skip the gateway',
    out.includes('KEYVAR=unset/unset'),
    out,
  );
  ok('arguments are passed through', out.includes('ARGS=-p hi'), out);
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== PATH: one line, added once ===');
{
  const s = sandbox('export EDITOR=vim\n');
  s.run(script());
  s.run(script());
  const rc = fs.readFileSync(s.rc, 'utf8');
  ok('the existing rc survives', rc.includes('export EDITOR=vim'));
  ok('added exactly once', rc.split('\n').filter((l) => l.includes('# agentlodge')).length === 1, rc);
  ok('$PATH stays a variable, not the value at install time', rc.includes('$PATH"'), rc);
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== Uninstall puts it back ===');
{
  const s = sandbox('export EDITOR=vim\n');
  s.run(script());
  execFileSync('sh', [path.join(s.home, '.agentlodge', 'uninstall.sh')], { encoding: 'utf8', env: { ...process.env, HOME: s.home } });
  ok('the directory is gone', !fs.existsSync(path.join(s.home, '.agentlodge')));
  ok('the rc line is gone', !fs.readFileSync(s.rc, 'utf8').includes('# agentlodge'));
  ok('the rest of the rc is intact', fs.readFileSync(s.rc, 'utf8').trim() === 'export EDITOR=vim');
  ok('no temporary file left behind', fs.readdirSync(s.home).every((f) => !f.includes('.agentlodge')), fs.readdirSync(s.home).join(','));
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== Uninstall when our line is the only line ===');
{
  const s = sandbox('');
  s.run(script());
  execFileSync('sh', [path.join(s.home, '.agentlodge', 'uninstall.sh')], { encoding: 'utf8', env: { ...process.env, HOME: s.home } });
  // grep -v selects nothing here and exits 1; without the fallback the line survives
  ok('the line is gone rather than surviving on a non-zero grep', !fs.readFileSync(s.rc, 'utf8').includes('# agentlodge'), fs.readFileSync(s.rc, 'utf8'));
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== Without a key it refuses ===');
{
  const s = sandbox('');
  let refused = false;
  let err = '';
  try {
    const file = path.join(s.home, 'run.sh');
    fs.writeFileSync(file, script());
    execFileSync('sh', [file], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: s.home, SHELL: '/bin/bash', PATH: `${s.bin}:${process.env.PATH ?? ''}` },
    });
  } catch (e) {
    refused = true;
    err = String((e as { stderr?: string }).stderr ?? '');
  }
  ok('it exits non-zero', refused);
  ok('and shows how to pass one', err.includes('takes your key as an argument'), err);
  ok('nothing was written', !fs.existsSync(path.join(s.home, '.agentlodge')));
  fs.rmSync(s.home, { recursive: true, force: true });
}

console.log('\n=== Without claude installed it refuses rather than half-installing ===');
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlodge-cli-'));
  fs.writeFileSync(path.join(home, '.bashrc'), '');
  const file = path.join(home, 'run.sh');
  fs.writeFileSync(file, script());
  let failed = false;
  let out = '';
  try {
    execFileSync('sh', [file, KEY], {
      encoding: 'utf8',
      // stderr is inherited by default, and this case is about what lands on it
      stdio: ['ignore', 'pipe', 'pipe'],
      // A real PATH, minus claude — sh itself still has to be found on it
      env: { HOME: home, SHELL: '/bin/bash', PATH: '/usr/bin:/bin' },
    });
  } catch (e) {
    failed = true;
    out = String((e as { stderr?: string }).stderr ?? '');
  }
  ok('it exits non-zero', failed);
  ok('and says why', out.includes('claude was not found'), out);
  ok('nothing was written', !fs.existsSync(path.join(home, '.agentlodge', 'claude', '.credentials.json')));
  fs.rmSync(home, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * "Which agents does this deployment offer" — the resolution and its guards.
 *
 * Worth its own test because every failure here is silent. An empty value
 * leaves a user interface with no agent at all and no error anywhere; an
 * unknown id would do the same for whatever was misspelled; and a default agent
 * that ignores the setting opens every new conversation on something switched
 * off, which reads as "new chat is broken".
 *
 * Run: npm -w @agentlodge/server run test:registry
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-registry-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret-value';
// The env fallback must not leak in from the developer's own shell
delete process.env.ENABLED_AGENTS;

const { initDb } = await import('../../core/db/index.js');
initDb();
const { setSetting, invalidate } = await import('../../core/db/settings.js');
const { enabledAgentIds, isEnabledAgent, defaultAgent } = await import('./registry.js');
const { turnArgs } = await import('./claude.js');

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

/** setSetting invalidates its own cache; this keeps the read side honest anyway */
function put(value: string): void {
  setSetting('agents.enabled', value);
  invalidate();
}

console.log('\n=== Default: everything is offered ===');
ok('nothing configured means all three', enabledAgentIds().join(',') === 'chat,claude,codex', enabledAgentIds().join(','));
ok('native chat is the default', defaultAgent() === 'chat');

console.log('\n=== A single agent ===');
put('codex');
ok('only codex is offered', enabledAgentIds().join(',') === 'codex', enabledAgentIds().join(','));
ok('claude is not', !isEnabledAgent('claude'));
ok('codex is', isEnabledAgent('codex'));
ok(
  'the default follows the setting rather than staying claude',
  defaultAgent() === 'codex',
  defaultAgent(),
);

console.log('\n=== Order is respected ===');
put('codex,claude');
ok('the list keeps its order', enabledAgentIds().join(',') === 'codex,claude');
ok('so the default is the first one listed', defaultAgent() === 'codex');

console.log('\n=== Junk is survivable ===');
put('claude, codex');
ok('spaces are trimmed', enabledAgentIds().join(',') === 'claude,codex');

console.log('\n=== The write side refuses what would break the UI ===');
for (const [label, value] of [
  ['empty', ''],
  ['only separators', ',,'],
  ['whitespace', '   '],
  ['an unknown id', 'claude,gemini'],
] as const) {
  let threw = false;
  try {
    setSetting('agents.enabled', value);
  } catch {
    threw = true;
  }
  ok(`rejects ${label}`, threw);
}

console.log('\n=== The read side is defensive anyway ===');
{
  // Reach around the validator the way a hand-edited database would
  const { run } = await import('../../core/db/index.js');
  run(
    `insert into settings (key, value, updated_at) values (?, ?, ?)
     on conflict(key) do update set value = excluded.value`,
    'agents.enabled',
    '',
    '2026-01-01',
  );
  invalidate();
  ok(
    'an empty stored value falls back to all, not to none',
    enabledAgentIds().join(',') === 'chat,claude,codex',
    enabledAgentIds().join(','),
  );
  ok('so there is still a default', defaultAgent() === 'chat');
}

console.log('\n=== The command line a turn runs on ===');
{
  const args = turnArgs({ prompt: 'hello', cwd: '/workspace', model: 'claude-opus-5' } as Parameters<typeof turnArgs>[0]);
  const at = args.indexOf('--disallowedTools');
  ok('the Skill tool is disallowed', at >= 0 && args[at + 1] === 'Skill', args.join(' '));
  ok('the prompt is still there', args.includes('hello'));
  ok('and the model it was asked for', args[args.indexOf('--model') + 1] === 'claude-opus-5');

  const windowed = turnArgs({ prompt: 'hello', cwd: '/workspace', model: 'claude-opus-5[1m]' } as Parameters<typeof turnArgs>[0]);
  ok('a 1M window is still a Claude Code model id', windowed[windowed.indexOf('--model') + 1] === 'claude-opus-5[1m]');

  const cursor = turnArgs({ prompt: 'hello', cwd: '/workspace', model: 'composer-2.5[fast=false]' } as Parameters<typeof turnArgs>[0]);
  ok(
    'a Cursor slug is sent as sonnet, which Claude Code will actually start',
    cursor[cursor.indexOf('--model') + 1] === 'sonnet',
    cursor.join(' '),
  );
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

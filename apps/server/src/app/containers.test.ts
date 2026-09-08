/**
 * The container lifecycle's decisions, without a container engine.
 *
 * `ensure()` is three branches of shelling out, and the two that matter are the ones that
 * *destroy* something: rebuilding a container, and naming a network. Both shipped once
 * with the wrong condition —
 *
 *   a blanket `catch` around `start`, so a busy daemon or a 60s timeout dropped the
 *     container and everything the agent had installed outside HOME with it
 *   a `network create` on a miss, which satisfies `--network` with a network the gateway
 *     is not attached to: the container starts, reports healthy, and cannot resolve
 *     `gateway` (GATEWAY_URL is http://gateway:8788), so every request from inside fails
 *
 * Neither is visible in a type check, and neither needs podman to test: PODMAN_BIN points
 * at a script that records its argv and fails on demand, and the argv is what gets checked.
 *
 * Run: npm -w @agentlodge/server run test:containers
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-containers-')));
const log = path.join(box, 'argv.log');
const fake = path.join(box, 'podman');
fs.writeFileSync(
  fake,
  [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$PODMAN_LOG"',
    'case "$1" in',
    // exists(): no status configured means "absent", which is a non-zero inspect
    // An engine error is any other failure; a missing container is the message the real
    // engines print for one
    '  inspect) [ -z "$FAKE_ENGINE_ERR" ] || { echo "$FAKE_ENGINE_ERR" >&2; exit 125; }; [ -n "$FAKE_STATUS" ] || { echo "Error: no container with name or ID found: no such container" >&2; exit 125; }; echo "$FAKE_STATUS"; exit 0 ;;',
    '  ps) printf "%s\\n" "$FAKE_PS"; exit 0 ;;',
    '  start) [ -z "$FAKE_START_ERR" ] || { echo "$FAKE_START_ERR" >&2; exit 125; }; exit 0 ;;',
    '  *) exit 0 ;;',
    'esac',
  ].join('\n'),
  { mode: 0o755 },
);

process.env.PODMAN_LOG = log;
process.env.PODMAN_BIN = fake;
process.env.AGENT_NETWORK = 'agentlodge-agent-net';
// reconcile() is a no-op with isolation off, which is the default
process.env.USE_CONTAINERS = 'true';
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const containers = await import('./containers.js');

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

/** Every podman invocation since the last call, one per line */
function argv(): string[] {
  const out = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  fs.writeFileSync(log, '');
  return out;
}

console.log('\n=== A missing network is not ours to create ===');
{
  process.env.FAKE_STATUS = '';     // no such container yet
  process.env.FAKE_START_ERR = '';
  await containers.ensure('user-create');
  const calls = argv();

  ok(
    'the container is created on the named network',
    calls.some((c) => c.startsWith('run ') && c.includes('--network agentlodge-agent-net')),
    JSON.stringify(calls),
  );
  // The gateway is attached to *that network object*, not to the name. Conjuring one on a
  // miss produces an agent that starts and cannot reach its upstream — a loud
  // "network ... not found" from `run` is the answer instead.
  ok(
    'and nothing tries to create or probe the network itself',
    !calls.some((c) => c.startsWith('network ')),
    JSON.stringify(calls),
  );
}

console.log('\n=== A container pinned to a dead network is rebuilt ===');
{
  process.env.FAKE_STATUS = 'exited';
  process.env.FAKE_START_ERR = 'Error: network agentlodge-agent-net not found';
  await containers.ensure('user-deadnet');
  const calls = argv();

  ok('start is tried first', calls.some((c) => c.startsWith('start ')), JSON.stringify(calls));
  ok('the container is dropped', calls.some((c) => c.startsWith('rm -f ')), JSON.stringify(calls));
  ok('and rebuilt', calls.some((c) => c.startsWith('run ')), JSON.stringify(calls));
}

console.log('\n=== Any other start failure is reported, not papered over ===');
{
  process.env.FAKE_STATUS = 'exited';
  // A busy daemon, a full disk, a 60s timeout: transient or an operator's problem. The
  // container holds whatever the agent installed outside HOME, and rebuilding it here
  // throws that away to fix nothing.
  process.env.FAKE_START_ERR = 'Error: container state improper: layer is busy';
  let threw = false;
  try {
    await containers.ensure('user-busy');
  } catch {
    threw = true;
  }
  const calls = argv();

  ok('ensure fails', threw);
  ok('the container is kept', !calls.some((c) => c.startsWith('rm ')), JSON.stringify(calls));
  ok('and nothing is rebuilt', !calls.some((c) => c.startsWith('run ')), JSON.stringify(calls));
}

console.log('\n=== An engine that cannot be reached is not "no such container" ===');
{
  process.env.FAKE_STATUS = '';
  process.env.FAKE_ENGINE_ERR = 'Cannot connect to Podman. Please verify your connection to the Linux system';
  let threw = false;
  try {
    await containers.ensure('user-noengine');
  } catch {
    threw = true;
  }
  const calls = argv();
  ok('ensure fails', threw);
  ok(
    'and nothing is created over a container that may well exist',
    !calls.some((c) => c.startsWith('run ')),
    JSON.stringify(calls),
  );
  process.env.FAKE_ENGINE_ERR = '';
}

console.log('\n=== Ending a turn reaches inside the container ===');
{
  const script = containers.signalScript('abc-123', 'INT');
  ok('the marker is matched whole', script.includes("'AGENTLODGE_TURN=abc-123'"), script);
  ok('with the signal asked for', script.includes('kill -INT'), script);
  const all = containers.signalScript(null, 'KILL');
  ok('a prefix ends every turn there is', all.includes("'^AGENTLODGE_TURN='") && all.includes('kill -KILL'), all);

  await containers.signalTurn('agentlodge-agent-x', 'abc-123', 'SIGKILL');
  const calls = argv();
  ok(
    'delivered with exec, as a shell script',
    calls.some((c) => c.startsWith('exec agentlodge-agent-x sh -c ')),
    JSON.stringify(calls),
  );
}

console.log('\n=== After a restart, what the engine still has is picked up ===');
{
  const { initDb } = await import('../core/db/index.js');
  const users = await import('../core/db/users.js');
  initDb();
  const u = users.create({ email: 'restart@example.com', username: 'restart', passwordHash: 'x', role: 'user' });
  const mine = `agentlodge-agent-${u.id.slice(0, 12)}`;
  process.env.FAKE_PS = `${mine} running\nagentlodge-agent-000000000000 running\n`;
  const found = await containers.reconcile();
  const calls = argv();
  ok('a running container of a known user is tracked again', containers.list().some((c) => c.name === mine), JSON.stringify(containers.list()));
  ok('and counted', found.running === 1, JSON.stringify(found));
  ok('any turn still running in it is ended', calls.some((c) => c.startsWith(`exec ${mine} sh -c `)), JSON.stringify(calls));
  ok('a container nobody owns is left alone', !calls.some((c) => c.includes('agentlodge-agent-000000000000')), JSON.stringify(calls));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

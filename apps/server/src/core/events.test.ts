/**
 * The event bus's memory, and what a reconnect is given.
 *
 * Run: npm -w @agentlodge/server run test:events
 */
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
const ev = await import('./events.js');

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

const heartbeat = { type: 'heartbeat' as const, ts: 0 };
const started = { type: 'turn.started' as const, turnId: 't1' };
const completed = { type: 'turn.completed' as const, turnId: 't1', usage: {
  inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 0, numTurns: 0,
} };

console.log('\n=== Idle channels are let go of; busy and watched ones are not ===');
{
  ev.publish('idle', heartbeat);
  ev.publish('running', started);
  ev.publish('watched', heartbeat);
  const off = ev.subscribe('watched', 0, () => {});
  const before = ev.channelCount();

  const dropped = ev.sweep(Date.now() + 11 * 60_000);
  ok('the idle one goes', dropped === 1 && ev.currentSeq('idle') === 0, String(dropped));
  ok('a turn in progress stays, however old', ev.currentSeq('running') === 1);
  ok('and so does one somebody is listening to', ev.currentSeq('watched') === 1);
  ok('count moved by exactly one', ev.channelCount() === before - 1);

  off();
  ev.publish('running', completed);
  ok('nothing goes before its time', ev.sweep(Date.now()) === 0);
  ok('and both go once idle', ev.sweep(Date.now() + 11 * 60_000) === 2, String(ev.channelCount()));
}

console.log('\n=== hasListeners says whether publishing would reach anybody ===');
{
  ok('nobody yet', !ev.hasListeners('c'));
  const off = ev.subscribe('c', 0, () => {});
  ok('somebody now', ev.hasListeners('c'));
  off();
  ok('nobody again', !ev.hasListeners('c'));
}

console.log('\n=== Replay after a reconnect ===');
{
  const got: number[] = [];
  ev.publish('r', heartbeat);
  ev.publish('r', heartbeat);
  ev.publish('r', heartbeat);
  ev.subscribe('r', 1, (e) => got.push(e.seq))();
  ok('everything after the id the client last saw', got.join(',') === '2,3', got.join(','));
  ok('and the current sequence is what the route compares against', ev.currentSeq('r') === 3);
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

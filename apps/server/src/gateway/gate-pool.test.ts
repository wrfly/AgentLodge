/**
 * One pool per upstream.
 *
 * The point of the split is isolation: an upstream that is full, or that has narrowed
 * itself after a 429, must not make requests to a different upstream wait. That is what
 * this checks — the counters are separate, the AIMD state is separate, and the configured
 * ceiling still applies to every pool including ones that do not exist yet.
 *
 * Run: npm -w @agentlodge/server run test:gate-pool
 */
import { GatePool } from './gate.js';

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

const cfg = {
  maxConcurrency: 2,
  maxQueueDepth: 10,
  queueTimeoutMs: 200,
  leaseMaxMs: 5_000,
  perUserInflightMax: 10,
};

console.log('\n=== The pools are separate ===');
{
  const pool = new GatePool({ ...cfg });
  const a = pool.for('provider-a');
  const b = pool.for('provider-b');

  ok('asking twice gives the same pool', pool.for('provider-a') === a);
  ok('and a different upstream a different one', a !== b);

  const first = await a.acquire({ userId: 'u1', turnId: 't-u1', priority: 0 });
  const second = await a.acquire({ userId: 'u2', turnId: 't-u2', priority: 0 });
  ok('one upstream fills up', a.stats().active === 2, String(a.stats().active));

  // The third would queue on A. B has to be free regardless.
  const other = await b.acquire({ userId: 'u3', turnId: 't-u3', priority: 0 });
  ok('the other is untouched', b.stats().active === 1 && b.stats().queued === 0, JSON.stringify(b.stats()));

  first.release();
  second.release();
  other.release();
  ok('released slots come back', a.stats().active === 0 && b.stats().active === 0);
}

console.log('\n=== Throttling narrows one upstream only ===');
{
  const pool = new GatePool({ ...cfg });
  const a = pool.for('provider-a');
  const b = pool.for('provider-b');

  a.reportUpstream(429);
  ok('the one that was throttled narrows', a.stats().effectiveMax < a.stats().max, JSON.stringify(a.stats()));
  ok('the other keeps its ceiling', b.stats().effectiveMax === b.stats().max, JSON.stringify(b.stats()));
}

console.log('\n=== The ceiling is deployment-wide ===');
{
  const pool = new GatePool({ ...cfg });
  const existing = pool.for('provider-a');
  pool.setMaxConcurrency(5);
  ok('an existing pool is raised', existing.stats().max === 5, String(existing.stats().max));
  ok('and one created later starts there', pool.for('provider-new').stats().max === 5);
  ok('the pool reports it', pool.max() === 5, String(pool.max()));
  ok('stats carry the upstream each row belongs to', pool.stats().some((s) => s.providerId === 'provider-a'));
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

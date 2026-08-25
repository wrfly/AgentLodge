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
  // Nothing has throttled this pool, so the raise is just a raise. Deferring it
  // to the AIMD climb would report the new ceiling while the gate still ran at
  // the old one for the next few hundred requests.
  ok(
    'and the effective limit follows it immediately',
    existing.stats().effectiveMax === 5,
    JSON.stringify(existing.stats()),
  );
  ok('and one created later starts there', pool.for('provider-new').stats().max === 5);
  ok('the pool reports it', pool.max() === 5, String(pool.max()));
  ok('stats carry the upstream each row belongs to', pool.stats().some((s) => s.providerId === 'provider-a'));
}

console.log('\n=== Ceiling changes must not defeat AIMD backoff ===');
{
  // A ceiling of 4 halves to 2 on the first 429. The gap matters: with the
  // ceiling at 2 the backoff floors at 1 straight away, and then "clamp to 1"
  // below would hold whether or not the clamp exists.
  const pool = new GatePool({ ...cfg, maxConcurrency: 4 });
  const a = pool.for('provider-a');

  // The upstream throttles us and the gate backs off.
  a.reportUpstream(429);
  const narrowed = a.stats().effectiveMax;
  ok('a 429 narrows the gate', narrowed === 2, JSON.stringify(a.stats()));

  // Raising the ceiling during the incident must leave the backoff alone: the
  // effective limit has to climb back on its own after a run of clean responses,
  // not jump to full the moment an admin opens the settings page.
  pool.setMaxConcurrency(7);
  ok('the new ceiling takes', a.stats().max === 7, String(a.stats().max));
  ok('the backoff survives a ceiling raise', a.stats().effectiveMax === narrowed, JSON.stringify(a.stats()));

  // But a ceiling *below* the effective limit does clamp it, backoff or not.
  pool.setMaxConcurrency(1);
  ok('a lower ceiling clamps the effective limit', a.stats().effectiveMax === 1, String(a.stats().effectiveMax));
}

console.log('\n=== Lower-then-raise must not punch through a backoff ===');
{
  // The trap an "effectiveMax vs ceiling" inference falls into: dip the ceiling
  // to exactly where the backoff sits, so effectiveMax === ceiling, then raise
  // it back. If the code keys on "equal to the old ceiling = not backing off",
  // the raise resets the throttle. The flag must survive the round trip.
  const pool = new GatePool({ ...cfg, maxConcurrency: 8 });
  const a = pool.for('provider-a');

  a.reportUpstream(429);
  const narrowed = a.stats().effectiveMax; // 8 → 4
  ok('a 429 narrows the gate', narrowed === 4, JSON.stringify(a.stats()));

  // Dip to exactly the backed-off value.
  pool.setMaxConcurrency(narrowed);
  ok('lowering to the backoff value clamps', a.stats().effectiveMax === narrowed, JSON.stringify(a.stats()));

  // Raise again. The backoff is still real — nothing has recovered — so the
  // effective limit must stay put rather than jump to the raised ceiling.
  pool.setMaxConcurrency(8);
  ok('the ceiling is back up', a.stats().max === 8, String(a.stats().max));
  ok('the backoff survives a lower-then-raise round trip', a.stats().effectiveMax === narrowed, JSON.stringify(a.stats()));
}

console.log('\n=== A ceiling change cannot destroy the backoff ===');
{
  // The round trip above dips the ceiling to exactly the backed-off value.
  // Dipping it *below* has to survive too: clearing the throttle there means
  // raising the ceiling back punches straight through into a live 429 storm,
  // which is the same failure one step removed.
  const pool = new GatePool({ ...cfg, maxConcurrency: 8 });
  const a = pool.for('provider-a');

  a.reportUpstream(429); // 8 -> 4
  ok('a 429 narrows the gate', a.stats().effectiveMax === 4, JSON.stringify(a.stats()));

  pool.setMaxConcurrency(2);
  ok('a ceiling below the backoff clamps', a.stats().effectiveMax === 2, JSON.stringify(a.stats()));

  // Nothing has recovered — no clean responses at all — so the upstream's
  // limit is still 4 and that is what the gate must come back to.
  pool.setMaxConcurrency(8);
  ok(
    'raising it back restores the backoff, not the ceiling',
    a.stats().effectiveMax === 4,
    JSON.stringify(a.stats()),
  );
}

console.log('\n=== A backoff still lifts when the ceiling came down to meet it ===');
{
  // With the ceiling lowered onto the backed-off value there is no gap left for
  // an "effectiveMax < ceiling" climb to run in, so a gate that keyed recovery
  // on that guard stayed marked as throttled forever — and a raise made much
  // later, on an upstream that had been healthy the whole time, was deferred to
  // a climb that could never start.
  const pool = new GatePool({ ...cfg, maxConcurrency: 8 });
  const a = pool.for('provider-a');

  a.reportUpstream(429); // 8 -> 4
  pool.setMaxConcurrency(4); // the ceiling meets the backoff exactly
  ok('the gate runs at the shared value', a.stats().effectiveMax === 4, JSON.stringify(a.stats()));

  // The upstream is healthy again.
  for (let i = 0; i < 20; i += 1) a.reportUpstream(200);
  ok('a clean run leaves the gate at its ceiling', a.stats().effectiveMax === 4, JSON.stringify(a.stats()));

  // With the backoff lifted, a raise is just a raise.
  pool.setMaxConcurrency(16);
  ok(
    'and a later raise applies immediately',
    a.stats().effectiveMax === 16,
    JSON.stringify(a.stats()),
  );
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

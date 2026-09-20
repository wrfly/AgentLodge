/**
 * The concurrency limit, from the console to the gate and back across a restart.
 *
 * `gate-pool.test.ts` covers what the gate does with the two numbers. This covers the thing
 * that made them not stick: the console used to do nothing but forward `maxConcurrency` to
 * the gateway process, which held it in a field. That made the limit a property of that
 * container's uptime rather than a setting — every restart put it back to
 * `MAX_UPSTREAM_CONCURRENCY`, and because the console reads the same process, nothing said
 * so until somebody counted requests.
 *
 * So the case that matters here is the last one: a pool built the way a freshly started
 * gateway builds it, with the environment's fallback and nothing else, has to come up on
 * what the console wrote.
 *
 * The gateway itself is not running, so `callGateway` fails and comes back `unreachable`.
 * That is the shape this route has always answered with when the container is down, and it
 * is deliberately not fatal here: the row is written before the forward, which is the whole
 * point — the setting is what survives, the forward only reaches the requests already queued.
 *
 * Run: npm -w @agentlodge/server run test:admin-gate
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-admin-gate-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
// The fallback a restarted container would come up on, and deliberately not the number the
// console writes below — otherwise "it was stored" and "it was never changed" look the same
process.env.MAX_UPSTREAM_CONCURRENCY = '3';
// The same for the gate's other limit, which arrives on this route now rather than through
// the generic settings page. Owned here: a machine set up to run this deployment is exactly
// the machine that exports it.
process.env.PER_USER_INFLIGHT_MAX = '2';
// Nothing listens there. `callGateway` answers `unreachable` rather than throwing.
process.env.GATEWAY_INTERNAL_URL = 'http://127.0.0.1:1';

const db = await import('../../../core/db/index.js');
db.initDb();
const users = await import('../../../core/db/users.js');
const sessions = await import('../../../core/db/sessions.js');
const settings = await import('../../../core/db/settings.js');
const { signAccessToken } = await import('../../../core/auth/tokens.js');
const { installLocale } = await import('../../../core/i18n/locale.js');
const { attachUser } = await import('../../../core/auth/guard.js');
const { GatePool } = await import('../../../gateway/gate.js');
const { register: registerGate } = await import('./gate.js');
const { default: Fastify } = await import('fastify');
const { default: cookie } = await import('@fastify/cookie');

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

async function signedIn(email: string, username: string, role: 'admin' | 'user') {
  const user = users.create({ email, username, passwordHash: 'x', role });
  const session = sessions.create({ userId: user.id, refreshToken: `r-${username}`, ttlMs: 3600_000 });
  const token = await signAccessToken({ sub: user.id, role, sid: session.id });
  return { user, bearer: { authorization: `Bearer ${token}` } };
}

const root = await signedIn('root@example.com', 'root', 'admin');
const alice = await signedIn('a@example.com', 'alice', 'user');

const app = Fastify();
await app.register(cookie);
app.addHook('onRequest', async (req) => installLocale(req));
app.addHook('preHandler', attachUser);
registerGate(app);
await app.ready();

const patch = (payload: unknown, who = root) =>
  app.inject({ method: 'PATCH', url: '/api/admin/gate', headers: who.bearer, payload: payload as object });

/**
 * A gateway process as it comes up: the environment's fallback in the constructor, the
 * stored settings read fresh. Wired exactly as `gateway/index.ts` wires it, because a test
 * that reads a different key from the one production reads would pass while the deployment
 * stayed broken.
 */
const restartedGateway = () =>
  new GatePool({
    maxConcurrency: Number(process.env['MAX_UPSTREAM_CONCURRENCY']),
    maxQueueDepth: 200,
    queueTimeoutMs: 120_000,
    leaseMaxMs: 600_000,
    // The other fallback a restarted container comes up on, and again deliberately not the
    // number the console writes below
    perUserInflightMax: Number(process.env['PER_USER_INFLIGHT_MAX']),
    readMaxConcurrency: () => settings.getNumberFresh('gateway.maxUpstreamConcurrency'),
    readPerUserInflightMax: () => settings.getNumberFresh('gateway.perUserInflightMax'),
    readAdaptiveConcurrency: () => settings.getBoolFresh('gateway.adaptiveConcurrency'),
  });

console.log('\n=== What the console writes ===');
{
  const res = await patch({ maxConcurrency: 9 });
  ok('a limit in range is accepted', res.statusCode === 200, String(res.statusCode));
  ok('and stored, not only forwarded', settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 9,
    String(settings.getNumberFresh('gateway.maxUpstreamConcurrency')));

  // Stored as the switch it is named after, so the row reads the same way round as the
  // behaviour: pinned means adaptive is off
  const pinned = await patch({ pinned: true });
  ok('the pin is accepted on its own', pinned.statusCode === 200, String(pinned.statusCode));
  ok('and stored inverted', settings.getBoolFresh('gateway.adaptiveConcurrency') === false);
  ok('the limit is untouched by it', settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 9);

  /*
   * The gate's other limit arrives on this route now rather than through the generic
   * settings page. Same row — `gateway.perUserInflightMax` — but written here it also
   * reaches the gateway's reschedule, which is what lets a raise admit the people already
   * queued instead of leaving them for a release that may be minutes away.
   */
  const perUser = await patch({ perUserInflightMax: 5 });
  ok('the per-user cap is accepted', perUser.statusCode === 200, String(perUser.statusCode));
  ok('and stored', settings.getNumberFresh('gateway.perUserInflightMax') === 5,
    String(settings.getNumberFresh('gateway.perUserInflightMax')));
  ok('without disturbing the ceiling', settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 9);

  // Both at once, because that is how a pair whose difficulty is their relationship gets
  // adjusted: one round trip, one audit entry
  const both = await patch({ maxConcurrency: 12, perUserInflightMax: 3 });
  ok('both together are accepted', both.statusCode === 200, String(both.statusCode));
  ok('and both are stored',
    settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 12
      && settings.getNumberFresh('gateway.perUserInflightMax') === 3);
}

console.log('\n=== What it refuses ===');
{
  const tooBig = await patch({ maxConcurrency: 999 });
  ok('an out-of-range limit is refused', tooBig.statusCode === 400, String(tooBig.statusCode));
  ok('and nothing is written', settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 12,
    String(settings.getNumberFresh('gateway.maxUpstreamConcurrency')));

  ok('zero is refused', (await patch({ maxConcurrency: 0 })).statusCode === 400);
  ok('so is a body with nothing in it', (await patch({})).statusCode === 400);
  // A pin change is a write; a body that only fails to parse as one must not read as
  // "pin it to false"
  ok('and a pin that is not a boolean', (await patch({ pinned: 'yes' })).statusCode === 400);
  ok('the pin survived all of that', settings.getBoolFresh('gateway.adaptiveConcurrency') === false);

  // The per-user cap takes the same range, and refusing it has to be the same answer: it is
  // written with the same setSetting, whose own validate would otherwise throw
  ok('an out-of-range per-user cap is refused', (await patch({ perUserInflightMax: 0 })).statusCode === 400);
  ok('and too large a one', (await patch({ perUserInflightMax: 65 })).statusCode === 400);
  /*
   * A fraction, which used to reach setSetting and come back a 500 with a stack trace.
   * `Number.isFinite(2.5)` is true, so the route's own check passed it on to the spec's
   * validate — which wants a whole number and refuses by throwing. The same value typed into
   * the settings page has always been a plain 400.
   */
  ok('and a fraction, as a 400 rather than a 500', (await patch({ maxConcurrency: 2.5 })).statusCode === 400);
  ok('on either limit', (await patch({ perUserInflightMax: 1.5 })).statusCode === 400);
  ok('neither limit moved', settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 12
    && settings.getNumberFresh('gateway.perUserInflightMax') === 3);
}

console.log('\n=== An ordinary user cannot move it ===');
{
  const res = await patch({ maxConcurrency: 64 }, alice);
  ok('the route refuses', res.statusCode === 403, String(res.statusCode));
  ok('and the limit stands', settings.getNumberFresh('gateway.maxUpstreamConcurrency') === 12);
  // The per-user cap left the settings page for this route, so its guard is this route's
  ok('the per-user cap is guarded the same way',
    (await patch({ perUserInflightMax: 1 }, alice)).statusCode === 403);
  ok('and it stands too', settings.getNumberFresh('gateway.perUserInflightMax') === 3);
}

console.log('\n=== And a gateway that has just restarted ===');
{
  // The regression itself. This pool has never been told anything: it is what the container
  // comes up with after a deploy, and on the old code it would report 3.
  const pool = restartedGateway();
  ok('it comes up on the stored limit, not the environment variable', pool.max() === 12, String(pool.max()));
  ok('and on the stored per-user cap, not PER_USER_INFLIGHT_MAX', pool.perUser() === 3, String(pool.perUser()));
  ok('and on the stored pin', pool.pinned());
  ok('so a pool created later starts there too', pool.for('provider-a').stats().max === 12);
  ok('and does not narrow itself', (() => {
    const g = pool.for('provider-b');
    g.reportUpstream(429, 10);
    return g.stats().effectiveMax === 12;
  })());

  await patch({ pinned: false });
  // 6 rather than 2, so "it read the row" and "it fell back to PER_USER_INFLIGHT_MAX" cannot
  // both produce a pass
  await patch({ maxConcurrency: 4, perUserInflightMax: 6 });
  const later = restartedGateway();
  ok('a later change is the one it comes up on',
    later.max() === 4 && later.perUser() === 6 && !later.pinned(),
    `${later.max()} / ${later.perUser()}`);
}

await app.close();
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

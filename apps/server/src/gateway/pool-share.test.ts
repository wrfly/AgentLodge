/**
 * The share a user with no ceiling of their own is told about.
 *
 * Every mistake here is a number that looks plausible. The ones worth catching:
 *   the denominator counting a second upstream  → everybody's share reads about half
 *   the numerator and denominator in different units → a ratio of tokens to money
 *   a share above 1                             → a user shown more than the pool has spent
 *   the pool's utilisation relayed as-is        → one tenant reading the whole platform
 *
 * Run: npm -w @agentlodge/server run test:pool-share
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { QuotaScope, QuotaStatus, QuotaWindow } from '../core/protocol.js';

process.env.TZ = 'UTC';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-pool-share-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
// The test inserts rows and expects the next share to see them
process.env.POOL_SHARE_CACHE_MS = '0';

const { initDb, run } = await import('../core/db/index.js');
initDb();
const allowance = await import('./upstream-allowance.js');
const { poolShare } = await import('./pool-share.js');

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

/* ---------------- Fixtures ---------------- */

const ANTHROPIC = { id: 'prov-a', name: 'anthropic-official' };
const DEEPSEEK = { id: 'prov-b', name: 'DeepSeek' };

const STARTS: Record<QuotaScope, string> = {
  window: '2026-08-23T14:00:00.000Z',
  week: '2026-08-20T05:00:00.000Z',
  month: '2026-08-01T00:00:00.000Z',
};
const ENDS: Record<QuotaScope, string> = {
  window: '2026-08-23T19:00:00.000Z',
  week: '2026-08-27T05:00:00.000Z',
  month: '2026-09-01T00:00:00.000Z',
};

/** By default no ceiling: this file is about the users who have none */
function win(scope: QuotaScope, over: Partial<QuotaWindow> = {}): QuotaWindow {
  const limit = over.limit === undefined ? null : over.limit;
  const used = over.used ?? 0;
  return {
    scope,
    limit,
    boost: 0,
    used,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    ratio: limit === null || limit <= 0 ? 0 : Math.min(used / limit, 1),
    startsAt: STARTS[scope],
    endsAt: ENDS[scope],
    exceeded: limit !== null && used >= limit,
    ...over,
  };
}

function q(
  over: Partial<Record<QuotaScope, Partial<QuotaWindow>>> = {},
  top: Partial<QuotaStatus> = {},
): QuotaStatus {
  return {
    limitKind: 'tokens',
    currency: 'CNY',
    hardStop: true,
    windows: {
      window: win('window', over.window),
      week: win('week', over.week),
      month: win('month', over.month),
    },
    exceeded: false,
    warning: false,
    tightest: null,
    ...top,
  };
}

/** A real capture's shape: the pool at 60% of its 5 hours and 80% of its week */
function pool(over: Record<string, string> = {}): void {
  allowance.reset();
  allowance.record(
    ANTHROPIC.name,
    'anthropic',
    new Headers({
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-utilization': '0.6',
      'anthropic-ratelimit-unified-5h-reset': String(Date.parse(ENDS.window) / 1000),
      'anthropic-ratelimit-unified-7d-status': 'allowed_warning',
      'anthropic-ratelimit-unified-7d-utilization': '0.8',
      'anthropic-ratelimit-unified-7d-reset': String(Date.parse(ENDS.week) / 1000),
      ...over,
    }),
  );
}

/** One turn, at an instant, through one upstream. Tokens and money differ on purpose. */
function spend(userId: string, providerId: string, at: string, tokens: number, micro: number): void {
  run(
    `insert into usage_records
       (user_id, agent, model, provider_id, billable_tokens, cost_micro, status, created_at, day, source)
     values (?, 'claude', 'm', ?, ?, ?, 'completed', ?, ?, 'gateway')`,
    userId,
    providerId,
    tokens,
    micro,
    at,
    at.slice(0, 10),
  );
}

/** Floating point: 0.4 × 0.6 is not 0.24 */
const near = (a: number | undefined, b: number): boolean => a !== undefined && Math.abs(a - b) < 1e-9;

console.log('\n=== Nothing to say ===');
{
  allowance.reset();
  ok('no reading from any upstream yet → no share', Object.keys(poolShare(q(), ANTHROPIC)).length === 0);
}
{
  pool();
  const s = poolShare(q(), DEEPSEEK);
  ok(
    'the reading belongs to another upstream → no share',
    Object.keys(s).length === 0,
    JSON.stringify(s),
  );
}
{
  pool();
  const s = poolShare(q({ window: { limit: 1000, used: 250 } }), ANTHROPIC);
  ok('a window with a ceiling of its own is left alone', s.window === undefined, JSON.stringify(s));
  ok('while the one without still gets a share', s.week !== undefined);
}
{
  pool();
  ok('the month is never derived — the pool has no month', poolShare(q(), ANTHROPIC).month === undefined);
}
{
  // A response that mentions 5h and not 7d: the second window has no figure to scale
  allowance.reset();
  allowance.record(ANTHROPIC.name, 'anthropic', new Headers({
    'anthropic-ratelimit-unified-5h-utilization': '0.6',
  }));
  const s = poolShare(q(), ANTHROPIC);
  ok('a window the upstream has not mentioned is skipped', s.week === undefined, JSON.stringify(s));
  ok('the one it did mention is not', s.window !== undefined);
  ok('and an absent status reads as allowed rather than dropping the number', s.window?.status === 'allowed');
}

console.log('\n=== The arithmetic ===');
{
  pool();
  const s = poolShare(q(), ANTHROPIC);
  ok('nobody has spent anything, so neither has this user', s.window?.utilization === 0, JSON.stringify(s.window));
  ok('but the window is still reported, so the client has a reset', s.window !== undefined);
}
{
  // Alone on the platform: 400 of the 400 tokens spent in this window are theirs
  spend('alice', ANTHROPIC.id, '2026-08-23T15:00:00.000Z', 400, 200);
  pool();
  const s = poolShare(q({ window: { used: 400 } }), ANTHROPIC);
  ok(
    'the only user on the platform is shown exactly the pool’s utilisation',
    s.window?.utilization === 0.6,
    String(s.window?.utilization),
  );
}
{
  spend('bob', ANTHROPIC.id, '2026-08-23T16:00:00.000Z', 600, 1800);
  pool();
  const s = poolShare(q({ window: { used: 400 } }), ANTHROPIC);
  ok(
    'two users split it by what each of them spent',
    near(s.window?.utilization, 0.4 * 0.6),
    String(s.window?.utilization),
  );
  const b = poolShare(q({ window: { used: 600 } }), ANTHROPIC);
  ok('the other one gets the rest', near(b.window?.utilization, 0.6 * 0.6), String(b.window?.utilization));
  ok(
    'and the two shares add up to the pool’s own figure',
    near((s.window?.utilization ?? 0) + (b.window?.utilization ?? 0), 0.6),
  );
}
{
  // A turn through a second upstream is not part of this subscription's consumption
  spend('carol', DEEPSEEK.id, '2026-08-23T16:30:00.000Z', 9000, 9000);
  pool();
  const s = poolShare(q({ window: { used: 400 } }), ANTHROPIC);
  ok(
    'another upstream’s traffic stays out of the denominator',
    near(s.window?.utilization, 0.4 * 0.6),
    String(s.window?.utilization),
  );
}
{
  // 13:00 is before the window opened, 20:00 after it closed
  spend('dave', ANTHROPIC.id, '2026-08-23T13:00:00.000Z', 5000, 5000);
  spend('dave', ANTHROPIC.id, '2026-08-23T20:00:00.000Z', 5000, 5000);
  pool();
  const s = poolShare(q({ window: { used: 400 }, week: { used: 400 } }), ANTHROPIC);
  ok(
    'only what was spent inside the window counts',
    near(s.window?.utilization, 0.4 * 0.6),
    String(s.window?.utilization),
  );
  ok(
    'though the week, which contains them, counts them',
    near(s.week?.utilization, (400 / 11_000) * 0.8),
    String(s.week?.utilization),
  );
}
{
  /*
   * A numerator larger than the denominator is reachable: an administrator's reset_at moves
   * a user's counting forward, and quota's own figures can be recomputed against a window
   * the totals query does not cut the same way. Whatever the cause, a user must never be
   * shown more than the pool has spent.
   */
  pool();
  const s = poolShare(q({ window: { used: 999_999 } }), ANTHROPIC);
  ok('a share cannot exceed the pool’s utilisation', s.window?.utilization === 0.6, String(s.window?.utilization));
}

console.log('\n=== Money, when that is what is being counted ===');
{
  // In this window: alice 400 tokens / 200 micro, bob 600 / 1800. The two ratios differ.
  pool();
  const s = poolShare(q({ window: { used: 200 } }, { limitKind: 'cost' }), ANTHROPIC);
  ok(
    'a cost-billed user is divided by everybody’s cost, not everybody’s tokens',
    near(s.window?.utilization, (200 / 2000) * 0.6),
    String(s.window?.utilization),
  );
}

console.log('\n=== The status is the pool’s, unchanged ===');
{
  pool();
  const s = poolShare(q({ window: { used: 400 } }), ANTHROPIC);
  ok('what the upstream said about its 5 hours', s.window?.status === 'allowed');
  ok('and about its week, which is warning', s.week?.status === 'allowed_warning', String(s.week?.status));
}
{
  pool({ 'anthropic-ratelimit-unified-5h-status': 'rejected' });
  ok('a refusal is passed through', poolShare(q(), ANTHROPIC).window?.status === 'rejected');
}
{
  pool({ 'anthropic-ratelimit-unified-5h-status': 'allowed_but_new' });
  const s = poolShare(q({ window: { used: 400 } }), ANTHROPIC);
  ok('a status we do not know reads as allowed', s.window?.status === 'allowed');
  ok('and the number survives it', near(s.window?.utilization, 0.4 * 0.6), String(s.window?.utilization));
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

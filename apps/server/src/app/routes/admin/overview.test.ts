/**
 * The console's period control, and the one period it could not offer.
 *
 * The card had the five-hour window — the one that refuses first — and then jumped to
 * calendar spans. The other window the gate enforces is seven days, and once an upstream
 * states its own weekly cadence it phase-locks to that instant rather than to anybody's
 * calendar, so "Last 7 days" beside it is a different stretch of time.
 *
 * Run: npm -w @agentlodge/server run test:admin-overview
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-admin-overview-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const db = await import('../../../core/db/index.js');
db.initDb();
const users = await import('../../../core/db/users.js');
const sessions = await import('../../../core/db/sessions.js');
const settings = await import('../../../core/db/settings.js');
const { signAccessToken } = await import('../../../core/auth/tokens.js');
const { installLocale } = await import('../../../core/i18n/locale.js');
const { attachUser } = await import('../../../core/auth/guard.js');
const { register: registerOverview } = await import('./overview.js');
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
registerOverview(app);
await app.ready();

const ask = async (preset: string, who = root.bearer) =>
  (await app.inject({ method: 'GET', url: `/api/admin/usage?preset=${preset}`, headers: who }))
    .json() as { range: { from: string; to: string; label: string } };

console.log('\n=== The console can ask about the seven days the quota is counting ===');
{
  /*
   * The most recent Monday at 20:00, whichever hour of the week this runs in: always past,
   * always under seven days back, and always twenty hours off a calendar week that starts at
   * midnight.
   */
  const monday8pm = new Date();
  monday8pm.setHours(20, 0, 0, 0);
  monday8pm.setDate(monday8pm.getDate() - ((monday8pm.getDay() + 6) % 7));
  if (monday8pm.getTime() > Date.now()) monday8pm.setDate(monday8pm.getDate() - 7);

  // What the gateway stores from an upstream reporting when its 7d window resets
  settings.setSetting('quota.weekResetAt', new Date(monday8pm.getTime() + 7 * 86400_000).toISOString());

  const rolling = await ask('weekWindow');
  ok('it starts where the window opened, not at midnight',
    rolling.range.from === monday8pm.toISOString(), `${rolling.range.from} vs ${monday8pm.toISOString()}`);
  ok('and runs a week from there',
    new Date(rolling.range.to).getTime() - monday8pm.getTime() === 7 * 86400_000,
    `${rolling.range.from} -> ${rolling.range.to}`);
  ok('it says which window it is', rolling.range.label === 'This 7-day window', rolling.range.label);

  const seven = await ask('last7');
  ok('the last seven days are a different stretch', seven.range.from !== rolling.range.from,
    `${seven.range.from} vs ${rolling.range.from}`);

  /*
   * This card is everybody's, so the boundary is the window's own — never a `countsFrom`,
   * which is one user's and moves when an administrator resets them. Resetting one user must
   * not move what the console reports for the platform.
   */
  users.resetUsage(alice.user.id, new Date(monday8pm.getTime() + 2 * 3600_000).toISOString());
  const afterReset = await ask('weekWindow');
  ok('one user\'s reset does not move the platform window',
    afterReset.range.from === rolling.range.from, `${afterReset.range.from} vs ${rolling.range.from}`);
}

console.log('\n=== It is the console, so it is for administrators ===');
{
  const res = await app.inject({
    method: 'GET', url: '/api/admin/usage?preset=weekWindow', headers: alice.bearer,
  });
  ok('a user is refused', res.statusCode === 403, String(res.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

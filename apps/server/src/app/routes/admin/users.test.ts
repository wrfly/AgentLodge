/**
 * Who is an administrator: the first account, and whoever the user list promotes.
 *
 * Sign-up and the role change both go through their routes, the way the console reaches
 * them, because that is where the rules live: an invite does not say what the account
 * becomes, and the first account cannot be demoted or disabled.
 *
 * Run: npm -w @agentlodge/server run test:admin-roles
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-admin-roles-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const db = await import('../../../core/db/index.js');
db.initDb();
const usersRepo = await import('../../../core/db/users.js');
const invitesRepo = await import('../../../core/db/invites.js');
const { installLocale } = await import('../../../core/i18n/locale.js');
const { attachUser } = await import('../../../core/auth/guard.js');
const { registerAuthRoutes } = await import('../auth.js');
const { register: registerUserRoutes } = await import('./users.js');
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

const app = Fastify();
await app.register(cookie);
app.addHook('onRequest', async (req) => installLocale(req));
app.addHook('preHandler', attachUser);
registerAuthRoutes(app);
registerUserRoutes(app);
await app.ready();

/** Sign up through the route with a fresh invite, as anyone after the first would */
async function signUp(username: string) {
  const invite = invitesRepo.create({ maxUses: 1 });
  const res = await app.inject({
    method: 'POST',
    url: '/api/auth/register',
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      email: `${username}@example.com`,
      username,
      password: 'correct-horse-9',
      inviteCode: invite.code,
    }),
  });
  const body = res.json() as { user?: { id: string; role: string }; accessToken?: string };
  if (res.statusCode !== 201 || !body.user || !body.accessToken) {
    throw new Error(`signing up ${username}: ${res.statusCode} ${res.body}`);
  }
  return {
    id: body.user.id,
    role: body.user.role,
    headers: { authorization: `Bearer ${body.accessToken}`, 'content-type': 'application/json' },
  };
}

const roleOf = (id: string) => String(usersRepo.findById(id)?.role);
const statusOf = (id: string) => String(usersRepo.findById(id)?.status);
const patch = (id: string, body: unknown, headers: Record<string, string>) =>
  app.inject({ method: 'PATCH', url: `/api/admin/users/${id}`, payload: JSON.stringify(body), headers });

console.log('\n=== The first account is the administrator, everyone after is a user ===');
const alice = await signUp('alice');
const bob = await signUp('bob');
const carol = await signUp('carol');
ok('the first sign-up is an administrator', alice.role === 'admin', alice.role);
ok('the second is a user', bob.role === 'user', bob.role);
ok('so is the third', carol.role === 'user', carol.role);

console.log('\n=== The list marks the first account ===');
{
  const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: alice.headers });
  const rows = res.json() as Array<{ id: string; first: boolean }>;
  ok('200', res.statusCode === 200, String(res.statusCode));
  ok('alice is first', rows.find((r) => r.id === alice.id)?.first === true);
  ok('bob is not', rows.find((r) => r.id === bob.id)?.first === false);
}

console.log('\n=== An administrator promotes and demotes from the list ===');
{
  const up = await patch(bob.id, { role: 'admin' }, alice.headers);
  ok('promoting: 200', up.statusCode === 200, String(up.statusCode));
  ok('bob is an administrator', roleOf(bob.id) === 'admin', roleOf(bob.id));

  const byBob = await patch(carol.id, { role: 'admin' }, bob.headers);
  ok('the promoted account administers at once', byBob.statusCode === 200, String(byBob.statusCode));

  const down = await patch(carol.id, { role: 'user' }, alice.headers);
  ok('demoting: 200', down.statusCode === 200, String(down.statusCode));
  ok('carol is a user again', roleOf(carol.id) === 'user', roleOf(carol.id));

  const byCarol = await patch(bob.id, { role: 'user' }, carol.headers);
  ok('a user cannot change roles: 403', byCarol.statusCode === 403, String(byCarol.statusCode));
  ok('bob is still an administrator', roleOf(bob.id) === 'admin', roleOf(bob.id));

  const unknown = await patch(carol.id, { role: 'owner' }, alice.headers);
  ok('an unknown role: 400', unknown.statusCode === 400, String(unknown.statusCode));
  ok('and nothing is written', roleOf(carol.id) === 'user', roleOf(carol.id));
}

console.log('\n=== The first account cannot be demoted or disabled ===');
{
  const demotedByOther = await patch(alice.id, { role: 'user' }, bob.headers);
  ok('demoted by another administrator: 400', demotedByOther.statusCode === 400, String(demotedByOther.statusCode));
  const demotedBySelf = await patch(alice.id, { role: 'user' }, alice.headers);
  ok('demoted by itself: 400', demotedBySelf.statusCode === 400, String(demotedBySelf.statusCode));
  const disabledByOther = await patch(alice.id, { status: 'suspended' }, bob.headers);
  ok('disabled by another administrator: 400', disabledByOther.statusCode === 400, String(disabledByOther.statusCode));
  const disabledBySelf = await patch(alice.id, { status: 'suspended' }, alice.headers);
  ok('disabled by itself: 400', disabledBySelf.statusCode === 400, String(disabledBySelf.statusCode));
  const otherStatus = await patch(alice.id, { status: 'banned' }, bob.headers);
  ok('any other status: 400', otherStatus.statusCode === 400, String(otherStatus.statusCode));
  ok(
    'alice is still an active administrator',
    roleOf(alice.id) === 'admin' && statusOf(alice.id) === 'active',
    `${roleOf(alice.id)} ${statusOf(alice.id)}`,
  );
}

console.log('\n=== Everyone else can still be disabled and enabled ===');
{
  const off = await patch(carol.id, { status: 'suspended' }, alice.headers);
  ok('disabling: 200', off.statusCode === 200, String(off.statusCode));
  ok('carol is disabled', statusOf(carol.id) === 'suspended', statusOf(carol.id));
  const on = await patch(carol.id, { status: 'active' }, alice.headers);
  ok('enabling: 200', on.statusCode === 200, String(on.statusCode));
  const unknown = await patch(carol.id, { status: 'gone' }, alice.headers);
  ok('an unknown status: 400', unknown.statusCode === 400, String(unknown.statusCode));
  ok('carol is active', statusOf(carol.id) === 'active', statusOf(carol.id));
}

console.log('\n=== A first account disabled in the database can be enabled again ===');
{
  // The console cannot do this, but the database can be edited by hand
  usersRepo.setStatus(alice.id, 'suspended');
  const lastAdmin = await patch(bob.id, { status: 'suspended' }, bob.headers);
  ok('the last active administrator still cannot be disabled: 400', lastAdmin.statusCode === 400, String(lastAdmin.statusCode));
  const enable = await patch(alice.id, { status: 'active' }, bob.headers);
  ok('enabling the first account: 200', enable.statusCode === 200, String(enable.statusCode));
  ok('alice is active again', statusOf(alice.id) === 'active', statusOf(alice.id));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

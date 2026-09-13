/**
 * Renaming, revoking and deleting an API key, through the routes the page calls.
 *
 * Run: npm -w @agentlodge/server run test:me-routes
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-me-routes-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const db = await import('../../core/db/index.js');
db.initDb();
const apiKeys = await import('../../core/db/api-keys.js');
const users = await import('../../core/db/users.js');
const sessions = await import('../../core/db/sessions.js');
const { signAccessToken } = await import('../../core/auth/tokens.js');
const { installLocale } = await import('../../core/i18n/locale.js');
const { attachUser } = await import('../../core/auth/guard.js');
const { registerMeRoutes } = await import('./me.js');
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

/**
 * A signed-in user. A request without a body carries no content-type, as the browser's
 * do: Fastify refuses an empty body sent as application/json.
 */
async function signedIn(email: string, username: string) {
  const user = users.create({ email, username, passwordHash: 'x', role: 'user' });
  const session = sessions.create({ userId: user.id, refreshToken: `refresh-${username}`, ttlMs: 3600_000 });
  const token = await signAccessToken({ sub: user.id, role: 'user', sid: session.id });
  const bearer = { authorization: `Bearer ${token}` };
  return { user, bearer, json: { ...bearer, 'content-type': 'application/json' } };
}

const alice = await signedIn('a@example.com', 'alice');
const bob = await signedIn('b@example.com', 'bob');

const app = Fastify();
await app.register(cookie);
app.addHook('onRequest', async (req) => installLocale(req));
app.addHook('preHandler', attachUser);
registerMeRoutes(app);
await app.ready();

const rename = (id: string, body: unknown, headers = alice.json) =>
  app.inject({ method: 'PATCH', url: `/api/me/api-keys/${id}`, payload: JSON.stringify(body), headers });
const nameOf = (id: string) => apiKeys.list(alice.user.id).find((k) => k.id === id)?.name;
const auditDetail = (action: string, id: string) =>
  db.get<{ detail: string | null }>(
    `select detail from audit_logs where action = ? and target_id = ?`,
    action,
    id,
  )?.detail ?? '';

console.log('\n=== A key in use takes a new name ===');
{
  const { key, plaintext } = apiKeys.create(alice.user.id, 'work MacBook');
  const res = await rename(key.id, { name: '  home desktop  ' });
  ok('200', res.statusCode === 200, String(res.statusCode));
  ok('the response carries the new name', (res.json() as { key?: { name: string } }).key?.name === 'home desktop');
  ok('stored trimmed', nameOf(key.id) === 'home desktop', String(nameOf(key.id)));
  ok('the key itself still works', apiKeys.verify(plaintext)?.id === key.id);
  const detail = auditDetail('apikey.rename', key.id);
  ok('the rename is audited with the new name', detail.includes('home desktop'), detail);
}

console.log('\n=== A name that cannot be one is refused ===');
{
  const { key } = apiKeys.create(alice.user.id, 'laptop');
  const cases: Array<[string, unknown]> = [
    ['blank', { name: '   ' }],
    ['longer than 64', { name: 'x'.repeat(65) }],
    ['not a string', { name: 42 }],
    ['missing', {}],
  ];
  for (const [label, body] of cases) {
    const res = await rename(key.id, body);
    ok(`${label}: 400`, res.statusCode === 400, String(res.statusCode));
  }
  ok('the name is unchanged', nameOf(key.id) === 'laptop', String(nameOf(key.id)));
}

console.log('\n=== Renaming: only your own key, and only while it is in use ===');
{
  const { key } = apiKeys.create(alice.user.id, 'old phone');
  const theirs = await rename(key.id, { name: 'mine now' }, bob.json);
  ok("someone else's key: 404", theirs.statusCode === 404, String(theirs.statusCode));

  apiKeys.revoke(key.id, alice.user.id);
  const revoked = await rename(key.id, { name: 'renamed after revoking' });
  ok('a revoked key: 404', revoked.statusCode === 404, String(revoked.statusCode));
  ok('the name is unchanged', nameOf(key.id) === 'old phone', String(nameOf(key.id)));

  const unknown = await rename('no-such-key', { name: 'anything' });
  ok('an unknown id: 404', unknown.statusCode === 404, String(unknown.statusCode));
}

console.log('\n=== Revoking stops the key at once ===');
{
  const { key, plaintext } = apiKeys.create(alice.user.id, 'build box');
  const revoke = (headers = alice.bearer) =>
    app.inject({ method: 'POST', url: `/api/me/api-keys/${key.id}/revoke`, headers });

  const theirs = await revoke(bob.bearer);
  ok("someone else's key: 404", theirs.statusCode === 404, String(theirs.statusCode));
  const res = await revoke();
  ok('200', res.statusCode === 200, String(res.statusCode));
  ok('the key no longer works', apiKeys.verify(plaintext) === undefined);
  ok('it stays in the list', nameOf(key.id) === 'build box', String(nameOf(key.id)));
  const again = await revoke();
  ok('revoking twice: 404', again.statusCode === 404, String(again.statusCode));
}

console.log('\n=== Only a revoked key can be deleted, and its usage stays ===');
{
  const { key, plaintext } = apiKeys.create(alice.user.id, 'spare');
  const del = (headers = alice.bearer) =>
    app.inject({ method: 'DELETE', url: `/api/me/api-keys/${key.id}`, headers });

  const live = await del();
  ok('a key in use: 409', live.statusCode === 409, String(live.statusCode));
  ok('and it still works', apiKeys.verify(plaintext)?.id === key.id);

  apiKeys.revoke(key.id, alice.user.id);
  const now = new Date().toISOString();
  db.run(
    `insert into usage_records (user_id, agent, status, created_at, day, billable_tokens, api_key_id)
     values (?, 'claude', 'completed', ?, ?, 1234, ?)`,
    alice.user.id,
    now,
    now.slice(0, 10),
    key.id,
  );

  const theirs = await del(bob.bearer);
  ok("someone else's key: 404", theirs.statusCode === 404, String(theirs.statusCode));
  ok('and it is still there', nameOf(key.id) === 'spare', String(nameOf(key.id)));

  const res = await del();
  ok('a revoked key: 200', res.statusCode === 200, String(res.statusCode));
  ok('gone from the list', nameOf(key.id) === undefined, String(nameOf(key.id)));
  const kept = db.get<{ n: number }>(`select count(*) as n from usage_records where api_key_id = ?`, key.id);
  ok('its usage records stay', kept?.n === 1, String(kept?.n));
  const detail = auditDetail('apikey.delete', key.id);
  ok('the deletion is audited with the name', detail.includes('spare'), detail);

  const again = await del();
  ok('deleting twice: 404', again.statusCode === 404, String(again.statusCode));
}

console.log('\n=== Creating checks the name the same way ===');
{
  const post = (body: unknown) =>
    app.inject({ method: 'POST', url: '/api/me/api-keys', payload: JSON.stringify(body), headers: alice.json });
  const notString = await post({ name: 42 });
  ok('a name that is not a string: 400', notString.statusCode === 400, String(notString.statusCode));
  const good = await post({ name: 'ci runner' });
  ok('a good name: 201', good.statusCode === 201, String(good.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

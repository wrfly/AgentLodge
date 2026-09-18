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
    `insert into usage_records (user_id, agent, status, created_at, day, cost_micro, api_key_id)
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

console.log('\n=== The window opens on nobody\'s calendar ===');
{
  /*
   * Three different sevens, and the page offers all three because they answer different
   * questions:
   *
   *   last7       the last seven calendar days, counted back from midnight
   *   week        the administrator's week, cut at the configured day and hour
   *   weekWindow  the window the quota is actually counting
   *
   * Once an upstream states its own weekly cadence, `weekBoundsAt` phase-locks to it — a
   * window that opened at 20:00 on a Monday reopens at 20:00 on a Monday. That is the one
   * the quota card at the top of the page has always shown, and the one the breakdown below
   * it could not be asked for, so the two numbers under the word "week" disagreed with no
   * way to reconcile them.
   *
   * The Monday 20:00 of the request, which holds whichever hour of the week this runs in:
   * the most recent one is always in the past, always less than seven days back, and always
   * twenty hours off the calendar week that starts at midnight.
   */
  const settings = await import('../../core/db/settings.js');

  const monday8pm = new Date();
  monday8pm.setHours(20, 0, 0, 0);
  monday8pm.setDate(monday8pm.getDate() - ((monday8pm.getDay() + 6) % 7));
  if (monday8pm.getTime() > Date.now()) monday8pm.setDate(monday8pm.getDate() - 7);

  // What the gateway stores from the upstream: when the current window *ends*
  settings.setSetting('quota.weekResetAt', new Date(monday8pm.getTime() + 7 * 86400_000).toISOString());

  const ask = async (preset: string) =>
    (await app.inject({ method: 'GET', url: `/api/me/usage?preset=${preset}`, headers: alice.bearer }))
      .json() as { range: { from: string; to: string; label: string }; totals: { inputTokens: number } };

  const rolling = await ask('weekWindow');
  ok('it starts where the window opened, not at midnight',
    rolling.range.from === monday8pm.toISOString(), `${rolling.range.from} vs ${monday8pm.toISOString()}`);
  ok('and runs a week from there', new Date(rolling.range.to).getTime() - monday8pm.getTime() === 7 * 86400_000,
    `${rolling.range.from} -> ${rolling.range.to}`);
  ok('it says which window it is', rolling.range.label === 'This 7-day window', rolling.range.label);

  const calendar = await ask('week');
  ok('the calendar week starts somewhere else', calendar.range.from !== rolling.range.from,
    `${calendar.range.from} vs ${rolling.range.from}`);
}

console.log('\n=== What falls either side of the boundary ===');
{
  /*
   * A second fixture, because the first one's instant moves with the day of the week and
   * this part must not. The phase is placed relative to now — three days and thirty-seven
   * minutes back — so the boundary is always in the past, always inside the last seven
   * calendar days, and cannot land on a calendar edge: those are all on the hour.
   *
   * `weekBoundsAt` walks whole weeks from whatever instant it was given, so a phase three
   * days old *is* the current window's start.
   */
  const settings = await import('../../core/db/settings.js');
  const usage = await import('../../core/db/usage.js');
  const carol = await signedIn('c@example.com', 'carol');

  const boundary = new Date(Date.now() - 3 * 86400_000 - 37 * 60_000);
  settings.setSetting('quota.weekResetAt', boundary.toISOString());

  const spendAt = (at: Date, tokens: number) => {
    const before = new Date().toISOString();
    usage.record({
      userId: carol.user.id, agent: 'claude', status: 'completed',
      usage: { inputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0,
               outputTokens: 0, costUsd: 0, durationMs: 1, numTurns: 1 },
    });
    const two = (n: number) => String(n).padStart(2, '0');
    const day = `${at.getFullYear()}-${two(at.getMonth() + 1)}-${two(at.getDate())}`;
    db.run('update usage_records set created_at = ?, day = ? where user_id = ? and created_at >= ?',
      at.toISOString(), day, carol.user.id, before);
  };
  spendAt(new Date(boundary.getTime() - 60_000), 1_000);
  spendAt(new Date(boundary.getTime() + 60_000), 500);

  const ask = async (preset: string) =>
    (await app.inject({ method: 'GET', url: `/api/me/usage?preset=${preset}`, headers: carol.bearer }))
      .json() as { range: { from: string }; totals: { inputTokens: number } };

  const rolling = await ask('weekWindow');
  ok('the window starts at the boundary', rolling.range.from === boundary.toISOString(),
    `${rolling.range.from} vs ${boundary.toISOString()}`);
  ok('what fell a minute before it is not counted', rolling.totals.inputTokens === 500,
    String(rolling.totals.inputTokens));
  const seven = await ask('last7');
  ok('and the last seven days catch both', seven.totals.inputTokens === 1_500,
    String(seven.totals.inputTokens));

  /*
   * The range is the gate's own window, and two people asking on the same afternoon are
   * asking about the same stretch of time.
   *
   * It used to follow `countsFrom`, which a manual reset pushed forward for one account, so
   * they were not. Zeroing is retired and the coupling to the quota stays — for the other
   * reason, which is the one that was always load-bearing: the boundary comes from what the
   * upstream reported, and a report recomputing it would disagree with what is enforced.
   */
  const asCarol = await ask('weekWindow');
  // bob has spent nothing in it; the window he is told about is still carol's window
  const asBob = (await app.inject({
    method: 'GET', url: '/api/me/usage?preset=weekWindow', headers: bob.bearer,
  })).json() as { range: { from: string } };
  ok('two accounts get the same window', asBob.range.from === asCarol.range.from,
    `${asBob.range.from} vs ${asCarol.range.from}`);
  ok('and it is the one the gate is enforcing',
    asCarol.range.from === boundary.toISOString(),
    `${asCarol.range.from} vs ${boundary.toISOString()}`);
}

console.log('\n=== Which upstream it went out through, and on whose credential ===');
{
  /*
   * `provider_id` is written by the gateway, which knows which upstream it chose. The CLI
   * books its own total only when the gateway was *not* in the path (`turns.ts`), and those
   * rows have no upstream at all — as do any written before the column existed. That is real
   * spend, so it is a row in the breakdown rather than a gap: a table whose rows do not add
   * up to the figure beside it is the thing this page keeps being reported for.
   */
  const usage = await import('../../core/db/usage.js');
  const providers = await import('../../core/db/providers.js');
  const dave = await signedIn('d@example.com', 'dave');

  const ark = providers.create({ name: 'Ark', kind: 'openai-chat', baseUrl: 'https://ark.example.com/api/v3', credentialId: 'ark-key' });
  const deep = providers.create({ name: 'DeepSeek', kind: 'anthropic-native', baseUrl: 'https://api.deepseek.com/anthropic', credentialId: 'ds-key' });

  const spend = (providerId: string | undefined, tokens: number, turnId: string) =>
    usage.record({
      userId: dave.user.id, agent: 'claude', model: 'sonnet', turnId, providerId,
      conversationId: undefined, status: 'completed',
      usage: { inputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0,
               outputTokens: 0, costUsd: 0, durationMs: 1, numTurns: 1 },
    });
  spend(ark.id, 1_000, 't1');
  spend(ark.id, 500, 't2');
  spend(deep.id, 300, 't3');
  spend(undefined, 200, 't4');   // the gateway was not in the path

  const ask = async (upstream?: string) =>
    (await app.inject({
      method: 'GET',
      url: `/api/me/usage?preset=all${upstream ? `&upstream=${upstream}` : ''}`,
      headers: dave.bearer,
    })).json() as {
      upstream: string | null;
      totals: { inputTokens: number };
      series: Array<{ inputTokens: number }>;
      byAgent: Array<{ inputTokens: number }>;
      byUpstream: Array<{ providerId: string; name: string; kind: string; credentialId: string; inputTokens: number }>;
    };
  const sum = (rows: Array<{ inputTokens: number }>) => rows.reduce((n, r) => n + r.inputTokens, 0);

  const all = await ask();
  ok('one row per upstream, plus the one with none', all.byUpstream.length === 3,
    JSON.stringify(all.byUpstream.map((r) => r.name)));
  ok('and they add up to the total beside them', sum(all.byUpstream) === all.totals.inputTokens,
    `${sum(all.byUpstream)} vs ${all.totals.inputTokens}`);

  const arkRow = all.byUpstream.find((r) => r.providerId === ark.id);
  ok('each row names its kind', arkRow?.kind === 'openai-chat', String(arkRow?.kind));
  ok('and the credential it authenticated on', arkRow?.credentialId === 'ark-key', String(arkRow?.credentialId));
  const orphan = all.byUpstream.find((r) => r.providerId === '');
  ok('what never went through the gateway is a row of its own',
    orphan?.inputTokens === 200, JSON.stringify(orphan));

  /*
   * Narrowing has to reach every query the report makes, or the chart disagrees with the
   * figure printed above it — which is the same defect in a different place.
   */
  const only = await ask(ark.id);
  ok('the report says which upstream it is narrowed to', only.upstream === ark.id, String(only.upstream));
  ok('the total counts that upstream alone', only.totals.inputTokens === 1_500, String(only.totals.inputTokens));
  ok('and so does the chart', sum(only.series) === 1_500, String(sum(only.series)));
  ok('and the model breakdown', sum(only.byAgent) === 1_500, String(sum(only.byAgent)));
  /*
   * Except the upstream breakdown itself, which is the list being chosen from: narrowing it
   * to the chosen row would leave nothing to click to get back.
   */
  ok('the list to choose from is not narrowed', only.byUpstream.length === 3,
    JSON.stringify(only.byUpstream.map((r) => r.name)));

  const none = await ask('none');
  ok('and the rows with no upstream can be asked for', none.totals.inputTokens === 200,
    String(none.totals.inputTokens));
  ok('with the chart agreeing there too', sum(none.series) === 200, String(sum(none.series)));

  // An upstream this user never used is empty rather than everything
  const empty = await ask('no-such-provider');
  ok('an upstream with nothing on it is empty, not unfiltered', empty.totals.inputTokens === 0,
    String(empty.totals.inputTokens));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

/**
 * The console's platform usage, broken down by the upstream that carried it.
 *
 * The operator's question is not the user's: "what is this credential costing us, and who is
 * spending it there". So the same breakdown the usage page grew is here over everybody, and
 * choosing a row narrows the figures, the chart and the leaderboard beneath it.
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
const usage = await import('../../../core/db/usage.js');
const providers = await import('../../../core/db/providers.js');
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
const bob = await signedIn('b@example.com', 'bob', 'user');

const app = Fastify();
await app.register(cookie);
app.addHook('onRequest', async (req) => installLocale(req));
app.addHook('preHandler', attachUser);
registerOverview(app);
await app.ready();

const ark = providers.create({ name: 'Ark', kind: 'openai-chat', baseUrl: 'https://ark.example.com/api/v3', credentialId: 'ark-key' });
const deep = providers.create({ name: 'DeepSeek', kind: 'anthropic-native', baseUrl: 'https://api.deepseek.com/anthropic', credentialId: 'ds-key' });

const spend = (userId: string, providerId: string | undefined, tokens: number, turnId: string) =>
  usage.record({
    userId, agent: 'claude', model: 'sonnet', turnId, providerId, status: 'completed',
    usage: { inputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0,
             outputTokens: 0, costUsd: 0, durationMs: 1, numTurns: 1 },
  });
spend(alice.user.id, ark.id, 1_000, 'a1');
spend(bob.user.id, ark.id, 400, 'b1');
spend(bob.user.id, deep.id, 300, 'b2');
spend(alice.user.id, undefined, 200, 'a2');   // the gateway was not in the path

const ask = async (upstream?: string, who = root.bearer) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/usage?preset=all${upstream ? `&upstream=${upstream}` : ''}`,
    headers: who,
  });
interface Report {
  upstream: string | null;
  totals: { inputTokens: number };
  series: Array<{ inputTokens: number }>;
  topUsers: Array<{ username: string; inputTokens: number }>;
  byUpstream: Array<{ providerId: string; name: string; kind: string; credentialId: string; inputTokens: number }>;
}
const sum = (rows: Array<{ inputTokens: number }>) => rows.reduce((n, r) => n + r.inputTokens, 0);

console.log('\n=== Everyone\'s spend, by the upstream that carried it ===');
{
  const all = (await ask()).json() as Report;
  ok('one row per upstream, plus the one with none', all.byUpstream.length === 3,
    JSON.stringify(all.byUpstream.map((r) => r.name)));
  ok('and they add up to the platform total', sum(all.byUpstream) === all.totals.inputTokens,
    `${sum(all.byUpstream)} vs ${all.totals.inputTokens}`);
  const arkRow = all.byUpstream.find((r) => r.providerId === ark.id);
  ok('a row spans every user of that upstream', arkRow?.inputTokens === 1_400, String(arkRow?.inputTokens));
  ok('and names the credential it went out on', arkRow?.credentialId === 'ark-key', String(arkRow?.credentialId));
  ok('what never went through the gateway is a row of its own',
    all.byUpstream.find((r) => r.providerId === '')?.inputTokens === 200,
    JSON.stringify(all.byUpstream.find((r) => r.providerId === '')));
}

console.log('\n=== Choosing one narrows the card, but not the list to choose from ===');
{
  const only = (await ask(ark.id)).json() as Report;
  ok('the report says which upstream it is narrowed to', only.upstream === ark.id, String(only.upstream));
  ok('the total counts that upstream alone', only.totals.inputTokens === 1_400, String(only.totals.inputTokens));
  ok('and so does the chart', sum(only.series) === 1_400, String(sum(only.series)));
  /*
   * The leaderboard is the operator's real question — "who is spending it *there*" — and it
   * is the one that would be most misleading unfiltered: Bob outspends Alice overall on this
   * upstream only if you count what he spent on the other one.
   */
  ok('the leaderboard is about that upstream', sum(only.topUsers) === 1_400, JSON.stringify(only.topUsers));
  ok('and ranks by what went through it', only.topUsers[0]?.username === 'alice',
    JSON.stringify(only.topUsers.map((u) => u.username)));
  ok('the list to choose from is not narrowed', only.byUpstream.length === 3,
    JSON.stringify(only.byUpstream.map((r) => r.name)));

  const none = (await ask('none')).json() as Report;
  ok('the rows with no upstream can be asked for', none.totals.inputTokens === 200,
    String(none.totals.inputTokens));
  ok('with the leaderboard agreeing', sum(none.topUsers) === 200, JSON.stringify(none.topUsers));

  const empty = (await ask('no-such-provider')).json() as Report;
  ok('an upstream with nothing on it is empty, not unfiltered', empty.totals.inputTokens === 0,
    String(empty.totals.inputTokens));
}

console.log('\n=== It is the console, so it is for administrators ===');
{
  const res = await ask(undefined, alice.bearer);
  ok('a user is refused', res.statusCode === 403, String(res.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

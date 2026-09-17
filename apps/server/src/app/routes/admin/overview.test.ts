/**
 * The console's usage cards: what they can be asked for, how they break down, and who may ask.
 *
 * Three questions across two endpoints, so they share a harness.
 *
 * **Upstream, then model.** The question this card answers is where a credential's money went,
 * and money goes to models: two of them differ by a factor of ten per token, so an upstream's
 * total says very little on its own. Opening a row used to narrow the whole card to that
 * upstream instead, which answered "who used this credential" — a question about people, and
 * people are the users tab's subject now. What has to hold is that both breakdowns come from
 * one scan of one period, so an upstream's models add up to its row and the rows add up to the
 * total above them.
 *
 * **By user.** The same period asked about people, on its own route. Deliberately not a top N:
 * the rows have to account for the period, which a truncated list cannot do — and an operator
 * looking for one person's spend should not have to hope they made the top ten.
 *
 * **The period control, and the one period it could not offer.** The card had the five-hour
 * window — the one that refuses first — and then jumped to calendar spans. The other window
 * the gate enforces is seven days, and once an upstream states its own weekly cadence it
 * phase-locks to that instant rather than to anybody's calendar, so "Last 7 days" beside it is
 * a different stretch of time.
 *
 * The period cases run last on purpose: they finish by moving a user's counting start, and
 * whatever mutates shared state should come after everything that reads it.
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

// root is the administrator asking, and spends nothing — which is its own case below
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

/**
 * One turn's spend, on a named upstream and model.
 *
 * Two models per upstream and one model on two upstreams: the cross is the whole point, and a
 * fixture where every row is the same model would pass a breakdown that ignored the column.
 */
const spend = (
  userId: string,
  providerId: string | undefined,
  model: string,
  tokens: number,
  turnId: string,
) =>
  usage.record({
    userId, agent: 'claude', model, turnId, providerId, status: 'completed',
    usage: { inputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0,
             outputTokens: 0, costUsd: 0, durationMs: 1, numTurns: 1 },
  });

spend(alice.user.id, ark.id, 'opus', 1_000, 'a1');
spend(bob.user.id, ark.id, 'sonnet', 400, 'b1');
spend(bob.user.id, deep.id, 'sonnet', 300, 'b2');
spend(alice.user.id, undefined, 'sonnet', 200, 'a2');   // the gateway was not in the path

const ask = (preset = 'all', who = root.bearer) =>
  app.inject({ method: 'GET', url: `/api/admin/usage?preset=${preset}`, headers: who });

const askUsers = (preset = 'all', who = root.bearer) =>
  app.inject({ method: 'GET', url: `/api/admin/usage-by-user?preset=${preset}`, headers: who });

const askPreset = async (preset: string, who = root.bearer) =>
  (await ask(preset, who)).json() as { range: { from: string; to: string; label: string } };

interface Report {
  totals: { inputTokens: number };
  series: Array<{ inputTokens: number }>;
  byUpstream: Array<{ providerId: string; name: string; kind: string; credentialId: string; inputTokens: number }>;
  byUpstreamModel: Array<{ providerId: string; model: string; inputTokens: number }>;
}
interface UserReport {
  totals: { inputTokens: number; turns: number };
  rows: Array<{ userId: string; username: string; inputTokens: number; turns: number }>;
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

console.log('\n=== Opening one shows the models under it, and they add up to it ===');
{
  const all = (await ask()).json() as Report;
  const under = (id: string) => all.byUpstreamModel.filter((m) => m.providerId === id);

  ok('an upstream with two models has two rows', under(ark.id).length === 2,
    JSON.stringify(under(ark.id).map((m) => m.model)));
  ok('and they add up to the row they open from', sum(under(ark.id)) === 1_400,
    `${sum(under(ark.id))} vs 1400`);
  ok('one model does not carry another\'s spend',
    under(ark.id).find((m) => m.model === 'opus')?.inputTokens === 1_000,
    JSON.stringify(under(ark.id)));
  // The cross is the point: the same model on two upstreams is a row under each, not one row
  ok('a model used on two upstreams is a row under each',
    all.byUpstreamModel.filter((m) => m.model === 'sonnet').length === 3,
    JSON.stringify(all.byUpstreamModel.filter((m) => m.model === 'sonnet')));
  ok('what never went through the gateway keeps its models too', sum(under('')) === 200,
    JSON.stringify(under('')));
  ok('and the whole breakdown adds up to the total',
    sum(all.byUpstreamModel) === all.totals.inputTokens,
    `${sum(all.byUpstreamModel)} vs ${all.totals.inputTokens}`);
}

console.log('\n=== The same period, asked about people ===');
{
  const res = await askUsers();
  ok('the users tab has its own route: 200', res.statusCode === 200, String(res.statusCode));
  const byUser = res.json() as UserReport;

  ok('one row per account that spent anything', byUser.rows.length === 2,
    JSON.stringify(byUser.rows.map((r) => r.username)));
  ok('and the rows account for the period rather than topping it',
    sum(byUser.rows) === byUser.totals.inputTokens,
    `${sum(byUser.rows)} vs ${byUser.totals.inputTokens}`);
  ok('heaviest first', byUser.rows[0]?.username === 'alice',
    JSON.stringify(byUser.rows.map((r) => r.username)));
  ok('a row spans every upstream that account used',
    byUser.rows.find((r) => r.username === 'alice')?.inputTokens === 1_200,
    JSON.stringify(byUser.rows.find((r) => r.username === 'alice')));
  // root is signed in and has no rows in the table at all, so there is nothing to account for
  ok('an account with no activity is not a row',
    !byUser.rows.some((r) => r.username === 'root'),
    JSON.stringify(byUser.rows.map((r) => r.username)));
  ok('the two cards agree about the period they share',
    byUser.totals.inputTokens === ((await ask()).json() as Report).totals.inputTokens,
    String(byUser.totals.inputTokens));
}

/*
 * The two ways this list could fail to account for its own total, both of which a leaderboard
 * is allowed to and this is not.
 */
console.log('\n=== Everything the total counts has a row to put it in ===');
{
  // A turn that was refused spends nothing. Filtered out as noise, its turns would still be in
  // the total above, leaving a figure with no row to attribute the difference to.
  usage.record({ userId: root.user.id, agent: 'claude', status: 'error' });

  // Spend whose account has been deleted. Nothing cascades from `users` to `usage_records`, so
  // an inner join would drop it from the rows while the total still counted it.
  const ghost = users.create({ email: 'g@example.com', username: 'ghost', passwordHash: 'x', role: 'user' });
  spend(ghost.id, ark.id, 'opus', 7_777, 'g1');
  users.remove(ghost.id);

  const byUser = (await askUsers()).json() as UserReport;
  const rootRow = byUser.rows.find((r) => r.username === 'root');
  ok('an account whose turns all failed is a row of zeroes',
    rootRow !== undefined && rootRow.inputTokens === 0, JSON.stringify(rootRow));
  ok('a deleted account keeps its spend as a row', byUser.rows.some((r) => r.inputTokens === 7_777),
    JSON.stringify(byUser.rows.map((r) => [r.username, r.inputTokens])));
  ok('with no name, which the console fills in', byUser.rows.find((r) => r.inputTokens === 7_777)?.username === '',
    JSON.stringify(byUser.rows.find((r) => r.inputTokens === 7_777)));
  ok('and the rows still add up to the total', sum(byUser.rows) === byUser.totals.inputTokens,
    `${sum(byUser.rows)} vs ${byUser.totals.inputTokens}`);
  // Turns belong to exactly one account, so unlike the upstream table this column adds up too
  ok('turns included',
    byUser.rows.reduce((n, r) => n + r.turns, 0) === byUser.totals.turns,
    `${byUser.rows.reduce((n, r) => n + r.turns, 0)} vs ${byUser.totals.turns}`);
}

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

  const rolling = await askPreset('weekWindow');
  ok('it starts where the window opened, not at midnight',
    rolling.range.from === monday8pm.toISOString(), `${rolling.range.from} vs ${monday8pm.toISOString()}`);
  ok('and runs a week from there',
    new Date(rolling.range.to).getTime() - monday8pm.getTime() === 7 * 86400_000,
    `${rolling.range.from} -> ${rolling.range.to}`);
  ok('it says which window it is', rolling.range.label === 'This 7-day window', rolling.range.label);

  const seven = await askPreset('last7');
  ok('the last seven days are a different stretch', seven.range.from !== rolling.range.from,
    `${seven.range.from} vs ${rolling.range.from}`);

  /*
   * The user card reports over this same window. Zeroing an account was the only thing that
   * could ever have made the two disagree, and it is retired — so what is worth pinning is
   * that the figures line up, not that a removed feature no longer fires.
   */
  const inWindow = (await askUsers('weekWindow')).json() as UserReport;
  ok('the user card accounts for the same window',
    sum(inWindow.rows) === inWindow.totals.inputTokens,
    `${sum(inWindow.rows)} vs ${inWindow.totals.inputTokens}`);
  const everything = (await askUsers()).json() as UserReport;
  ok('and over all time it has each account\'s whole spend',
    everything.rows.find((r) => r.username === 'alice')?.inputTokens === 1_200,
    JSON.stringify(everything.rows.map((r) => [r.username, r.inputTokens])));
}

console.log('\n=== It is the console, so it is for administrators ===');
{
  ok('a user is refused the upstream card', (await ask('all', alice.bearer)).statusCode === 403,
    String((await ask('all', alice.bearer)).statusCode));
  ok('and the user card too', (await askUsers('all', alice.bearer)).statusCode === 403,
    String((await askUsers('all', alice.bearer)).statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * One account's spend, per agent and per model, as the console asks for it.
 *
 * The breakdown was always in the response — `byAgentForUser` groups by agent *and* model,
 * and this route has returned it all along — but nothing rendered it, so nothing checked it
 * either. What the console now draws is a table with a footer, and the two failures worth
 * pinning are both about the footer disagreeing with its rows:
 *
 * - the total has to count the same range the rows do, or the table puts one month's rows
 *   under another month's total;
 * - and it must not be their sum, because a turn that called two models is one turn and
 *   belongs to both rows. The console says that out loud when the two differ, which it can
 *   only do if the server sends the real total rather than an addition anyone could redo.
 *
 * Run: npm -w @agentlodge/server run test:admin-user-detail
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-admin-user-detail-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const db = await import('../../../core/db/index.js');
db.initDb();
const users = await import('../../../core/db/users.js');
const sessions = await import('../../../core/db/sessions.js');
const usage = await import('../../../core/db/usage.js');
const quota = await import('../../../core/quota.js');
const { signAccessToken } = await import('../../../core/auth/tokens.js');
const { installLocale } = await import('../../../core/i18n/locale.js');
const { attachUser } = await import('../../../core/auth/guard.js');
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

async function signedIn(email: string, username: string, role: 'admin' | 'user') {
  const user = users.create({ email, username, passwordHash: 'x', role });
  const session = sessions.create({ userId: user.id, refreshToken: `r-${username}`, ttlMs: 3600_000 });
  const token = await signAccessToken({ sub: user.id, role, sid: session.id });
  return { user, bearer: { authorization: `Bearer ${token}` } };
}

const root = await signedIn('root@example.com', 'root', 'admin');
// The account being looked at, and the one doing the looking when it should be refused
const bob = await signedIn('b@example.com', 'bob', 'user');
const alice = await signedIn('a@example.com', 'alice', 'user');

const app = Fastify();
await app.register(cookie);
app.addHook('onRequest', async (req) => installLocale(req));
app.addHook('preHandler', attachUser);
registerUserRoutes(app);
await app.ready();

/**
 * One turn's spend, on a named agent and model.
 *
 * `turnId` is what makes a turn one turn: two records sharing it are one turn that called
 * two models, which is the case the footer is about.
 */
const spend = (
  userId: string,
  agent: 'claude' | 'codex',
  model: string,
  tokens: number,
  turnId: string,
) =>
  usage.record({
    userId, agent, model, turnId, status: 'completed',
    usage: { inputTokens: tokens, cacheReadTokens: 0, cacheCreationTokens: 0,
             outputTokens: 0, costUsd: 0, durationMs: 1, numTurns: 1 },
  });

interface Row {
  agent: string;
  model: string | null;
  turns: number;
  inputTokens: number;
}
interface Detail {
  usage: {
    byAgent: Row[];
    month: { turns: number; inputTokens: number };
    allTime: { inputTokens: number };
  };
  quota: { currency: string };
}

const detail = (id: string, who = root.bearer) =>
  app.inject({ method: 'GET', url: `/api/admin/users/${id}`, headers: who });

const ask = async (id: string) => (await detail(id)).json() as Detail;
const rowSum = (rows: Row[]) => rows.reduce((n, r) => n + r.inputTokens, 0);

console.log('\n=== What one account spent, per agent and per model ===');
{
  spend(bob.user.id, 'claude', 'claude-opus-5', 1_000, 't1');
  spend(bob.user.id, 'claude', 'claude-sonnet-5', 400, 't2');
  spend(bob.user.id, 'codex', 'gpt-5', 200, 't3');
  // Somebody else's spend, which must not show up under bob
  spend(alice.user.id, 'claude', 'claude-opus-5', 9_999, 'a1');

  const res = await detail(bob.user.id);
  ok('the console can ask for one account: 200', res.statusCode === 200, String(res.statusCode));
  const d = res.json() as Detail;

  ok('one row per agent and model, not per agent', d.usage.byAgent.length === 3,
    JSON.stringify(d.usage.byAgent.map((r) => `${r.agent}/${r.model}`)));
  const opus = d.usage.byAgent.find((r) => r.model === 'claude-opus-5');
  ok('a row names both the agent and the model', opus?.agent === 'claude', JSON.stringify(opus));
  ok("and carries that model's spend alone", opus?.inputTokens === 1_000, String(opus?.inputTokens));
  ok('two models on one agent are two rows',
    d.usage.byAgent.filter((r) => r.agent === 'claude').length === 2,
    JSON.stringify(d.usage.byAgent.filter((r) => r.agent === 'claude')));
  ok("nobody else's spend is in it", rowSum(d.usage.byAgent) === 1_600, String(rowSum(d.usage.byAgent)));
  ok('the currency the figures are counted in comes with them',
    typeof d.quota.currency === 'string' && d.quota.currency.length > 0, String(d.quota.currency));
}

console.log('\n=== The breakdown comes with its own total, over its own range ===');
{
  const d = await ask(bob.user.id);
  ok('the total counts what the rows count', d.usage.month.inputTokens === rowSum(d.usage.byAgent),
    `${d.usage.month.inputTokens} vs ${rowSum(d.usage.byAgent)}`);
  ok('and so far that is everything there is', d.usage.month.inputTokens === d.usage.allTime.inputTokens,
    `${d.usage.month.inputTokens} vs ${d.usage.allTime.inputTokens}`);

  /*
   * Spend from before the month the rows cover. It has to leave both the rows and the month
   * total and stay in all-time — the first two moving together is what reading them from one
   * instant buys.
   */
  const before = new Date(quota.boundsOf('month').start.getTime() - 86_400_000).toISOString();
  db.run('update usage_records set created_at = ? where user_id = ? and turn_id = ?',
    before, bob.user.id, 't3');

  const after = await ask(bob.user.id);
  ok('a row from before the month is gone from the breakdown',
    after.usage.byAgent.every((r) => r.agent !== 'codex'),
    JSON.stringify(after.usage.byAgent.map((r) => r.agent)));
  ok('and gone from its total too', after.usage.month.inputTokens === rowSum(after.usage.byAgent),
    `${after.usage.month.inputTokens} vs ${rowSum(after.usage.byAgent)}`);
  ok('leaving the two agreeing at 1,400', after.usage.month.inputTokens === 1_400,
    String(after.usage.month.inputTokens));
  ok('but it is still counted in all time', after.usage.allTime.inputTokens === 1_600,
    String(after.usage.allTime.inputTokens));
}

console.log('\n=== A turn that called two models is one turn, and the total says so ===');
{
  // Two records, one turn id: the turn switched model part way through
  spend(bob.user.id, 'claude', 'claude-opus-5', 50, 'shared');
  spend(bob.user.id, 'claude', 'claude-haiku-4-5', 50, 'shared');

  const d = await ask(bob.user.id);
  const columnSum = d.usage.byAgent.reduce((n, r) => n + r.turns, 0);
  ok('the turns column adds up to more than the total', columnSum > d.usage.month.turns,
    `${columnSum} vs ${d.usage.month.turns}`);
  ok('the total counts the shared turn once', d.usage.month.turns === 3, String(d.usage.month.turns));
  ok('the column counts it under each model it touched', columnSum === 4, String(columnSum));
  ok('while the tokens still agree', d.usage.month.inputTokens === rowSum(d.usage.byAgent),
    `${d.usage.month.inputTokens} vs ${rowSum(d.usage.byAgent)}`);
}

console.log('\n=== It is the console, so it is for administrators ===');
{
  const refused = await detail(bob.user.id, alice.bearer);
  ok('a standard user is refused: 403', refused.statusCode === 403, String(refused.statusCode));
  const missing = await detail('no-such-user');
  ok('an account that does not exist: 404', missing.statusCode === 404, String(missing.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

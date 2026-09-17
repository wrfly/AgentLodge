/**
 * One account's spend, per agent and per model, as the console asks for it.
 *
 * The grouping was never the missing piece — `byAgentForUser` has grouped by agent *and*
 * model all along, and the user detail route returned it — but nothing rendered it, so
 * nothing checked it either. What the console now draws is a table with a footer and a period
 * in its title, and every failure worth pinning is one of those three disagreeing:
 *
 * - the total has to count the range the rows count, or the table puts one month's rows under
 *   another month's total;
 * - it must not be their sum, because a turn that called two models is one turn and belongs
 *   to both rows. The console says so out loud when the two differ, which it can only do if
 *   the server counts the total rather than adding up what it already sent;
 * - and the range has to be the one the title claims. "This quota month" is what the user's
 *   own usage page calls the range *the gate* counts over, which a manual reset moves. Read
 *   from the month boundary instead, the console would show a just-zeroed account its whole
 *   forgiven month under the words the other page uses for nothing.
 *
 * Run: npm -w @agentlodge/server run test:admin-usage-by-agent
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
interface Report {
  currency: string;
  range: { from: string; label: string };
  rows: Row[];
  total: { turns: number; inputTokens: number };
}

const fetchIt = (id: string, preset = 'month', who = root.bearer) =>
  app.inject({
    method: 'GET',
    url: `/api/admin/users/${id}/usage-by-agent?preset=${preset}`,
    headers: who,
  });

const ask = async (id: string, preset = 'month') => (await fetchIt(id, preset)).json() as Report;
const rowSum = (rows: Row[]) => rows.reduce((n, r) => n + r.inputTokens, 0);

console.log('\n=== What one account spent, per agent and per model ===');
{
  spend(bob.user.id, 'claude', 'claude-opus-5', 1_000, 't1');
  spend(bob.user.id, 'claude', 'claude-sonnet-5', 400, 't2');
  spend(bob.user.id, 'codex', 'gpt-5', 200, 't3');
  // Somebody else's spend, which must not show up under bob
  spend(alice.user.id, 'claude', 'claude-opus-5', 9_999, 'a1');

  const res = await fetchIt(bob.user.id);
  ok('the console can ask for one account: 200', res.statusCode === 200, String(res.statusCode));
  const d = res.json() as Report;

  ok('one row per agent and model, not per agent', d.rows.length === 3,
    JSON.stringify(d.rows.map((r) => `${r.agent}/${r.model}`)));
  const opus = d.rows.find((r) => r.model === 'claude-opus-5');
  ok('a row names both the agent and the model', opus?.agent === 'claude', JSON.stringify(opus));
  ok("and carries that model's spend alone", opus?.inputTokens === 1_000, String(opus?.inputTokens));
  ok('two models on one agent are two rows',
    d.rows.filter((r) => r.agent === 'claude').length === 2,
    JSON.stringify(d.rows.filter((r) => r.agent === 'claude')));
  ok("nobody else's spend is in it", rowSum(d.rows) === 1_600, String(rowSum(d.rows)));
  ok('the currency the figures are counted in comes with them',
    typeof d.currency === 'string' && d.currency.length > 0, String(d.currency));
  // The console prints this beside the figures; picking it there would be a second opinion
  // about what the range is
  ok('and the range says what it is', d.range.label === 'This month', d.range.label);
}

console.log('\n=== The breakdown comes with its own total, over its own range ===');
{
  const d = await ask(bob.user.id);
  ok('the total counts what the rows count', d.total.inputTokens === rowSum(d.rows),
    `${d.total.inputTokens} vs ${rowSum(d.rows)}`);

  /*
   * Spend from before the month the rows cover. It has to leave the rows and the total
   * together — them moving as one is what reading them from a single instant buys.
   */
  const before = new Date(quota.boundsOf('month').start.getTime() - 86_400_000).toISOString();
  db.run('update usage_records set created_at = ? where user_id = ? and turn_id = ?',
    before, bob.user.id, 't3');

  const after = await ask(bob.user.id);
  ok('a row from before the month is gone from the breakdown',
    after.rows.every((r) => r.agent !== 'codex'),
    JSON.stringify(after.rows.map((r) => r.agent)));
  ok('and gone from its total too', after.total.inputTokens === rowSum(after.rows),
    `${after.total.inputTokens} vs ${rowSum(after.rows)}`);
  ok('leaving the two agreeing at 1,400', after.total.inputTokens === 1_400,
    String(after.total.inputTokens));
}

/*
 * The periods are the console's own — one list, cut on the server — so the panel and the
 * all-users card can be read against each other. Two lists would drift, and a comparison
 * between two differently-cut "7-day windows" is worse than no comparison.
 */
console.log('\n=== The period is chosen, and it is the same list the platform card offers ===');
{
  const month = await ask(bob.user.id, 'month');
  const window = await ask(bob.user.id, 'window');
  const all = await ask(bob.user.id, 'all');

  ok('each preset says which period it is', window.range.label === 'This window', window.range.label);
  /*
   * Labels, not instants. With no observed window reset the 5-hour grid is phased on the
   * quota anchor, so it realigns with the month boundary every five days — comparing the two
   * `from` values fails on a correct implementation for the first five hours of roughly one
   * month in five.
   */
  ok('and they are different periods', window.range.label !== month.range.label,
    `${window.range.label} vs ${month.range.label}`);
  ok('the rows follow the period they were asked for',
    all.total.inputTokens === 1_600 && month.total.inputTokens === 1_400,
    `all ${all.total.inputTokens}, month ${month.total.inputTokens}`);
  ok('and the total follows with them', rowSum(all.rows) === all.total.inputTokens,
    `${rowSum(all.rows)} vs ${all.total.inputTokens}`);
  // The row moved out of the month earlier in this file; all-time is where it still is
  ok('the row from before the month is back under all time',
    all.rows.some((r) => r.agent === 'codex'), JSON.stringify(all.rows.map((r) => r.agent)));

  /*
   * A typo must not be a different period. The query string is not typed, and the switch in
   * `platformRange` has a `default:` — so an unvalidated preset used to answer 'Today' while
   * omitting the parameter answered the route's own default, which made `?preset=moth` return
   * something plausible-looking and wrong.
   */
  const unknown = await ask(bob.user.id, 'not-a-preset');
  const omitted = (await (await app.inject({
    method: 'GET', url: `/api/admin/users/${bob.user.id}/usage-by-agent`, headers: root.bearer,
  })).json()) as Report;
  ok('an unknown preset falls back to what omitting it would give',
    unknown.range.label === omitted.range.label, `${unknown.range.label} vs ${omitted.range.label}`);
  ok('which is this route\'s own default', omitted.range.label === 'Today', omitted.range.label);
}

console.log('\n=== An account that has never spent anything ===');
{
  // What the console draws its `Empty` for: a range with nothing in it, not an error
  const quiet = await signedIn('q@example.com', 'quiet', 'user');
  const d = await ask(quiet.user.id);
  ok('no rows', d.rows.length === 0, JSON.stringify(d.rows));
  ok('a zeroed total rather than a missing one', d.total.inputTokens === 0 && d.total.turns === 0,
    JSON.stringify(d.total));
  ok('and still a range and a currency to label it with',
    d.range.label === 'This month' && typeof d.currency === 'string' && d.currency.length > 0,
    `${d.range.label} / ${d.currency}`);
}

console.log('\n=== A turn that called two models is one turn, and the total says so ===');
{
  // Two records, one turn id: the turn switched model part way through
  spend(bob.user.id, 'claude', 'claude-opus-5', 50, 'shared');
  spend(bob.user.id, 'claude', 'claude-haiku-4-5', 50, 'shared');

  const d = await ask(bob.user.id);
  const columnSum = d.rows.reduce((n, r) => n + r.turns, 0);
  ok('the turns column adds up to more than the total', columnSum > d.total.turns,
    `${columnSum} vs ${d.total.turns}`);
  ok('the total counts the shared turn once', d.total.turns === 3, String(d.total.turns));
  ok('the column counts it under each model it touched', columnSum === 4, String(columnSum));
  ok('while the tokens still agree', d.total.inputTokens === rowSum(d.rows),
    `${d.total.inputTokens} vs ${rowSum(d.rows)}`);
}

console.log('\n=== It is the console, so it is for administrators ===');
{
  const refused = await fetchIt(bob.user.id, 'month', alice.bearer);
  ok('a standard user is refused: 403', refused.statusCode === 403, String(refused.statusCode));
  const missing = await fetchIt('no-such-user');
  ok('an account that does not exist: 404', missing.statusCode === 404, String(missing.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

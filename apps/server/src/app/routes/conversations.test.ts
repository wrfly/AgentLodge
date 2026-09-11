/**
 * The conversation routes: the edit/retry decision, end to end.
 *
 * The decision — correcting the newest question re-answers it in place, editing an older
 * one branches — lives in the route, not in the repository, and the repository tests below
 * it deliberately never call it. So this suite builds a real Fastify instance around the
 * route and asks it the way the browser would, with the one moving part outside the
 * decision — the agent CLI — stubbed to a script that exits cleanly.
 *
 * Run: npm -w @agentlodge/server run test:conversation-routes
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-conv-routes-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

// The route starts a turn, which would spawn a real CLI. A stub that exits cleanly keeps
// the test on the decision: the response is written before the turn finishes either way.
const stubBin = path.join(box, 'fake-claude');
fs.writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
process.env.CLAUDE_BIN = stubBin;

const { initDb } = await import('../../core/db/index.js');
initDb();
const convRepo = await import('../../core/db/conversations.js');
const db = await import('../../core/db/index.js');
const trims = await import('../../core/db/trims.js');
const usage = await import('../../core/db/usage.js');
const turns = await import('../turns.js');
const users = await import('../../core/db/users.js');
const sessions = await import('../../core/db/sessions.js');
const { signAccessToken } = await import('../../core/auth/tokens.js');
const { installLocale } = await import('../../core/i18n/locale.js');
const { attachUser } = await import('../../core/auth/guard.js');
const { registerConversationRoutes } = await import('./conversations.js');
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

const alice = users.create({
  email: 'a@example.com', username: 'alice', passwordHash: 'x', role: 'user',
});
const session = sessions.create({
  userId: alice.id, refreshToken: 'test-refresh', ttlMs: 3600_000,
});
const token = await signAccessToken({ sub: alice.id, role: 'user', sid: session.id });

const app = Fastify();
await app.register(cookie);
app.addHook('onRequest', async (req) => installLocale(req));
app.addHook('preHandler', attachUser);
registerConversationRoutes(app);
await app.ready();

const auth = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const post = (url: string, body: unknown) =>
  app.inject({ method: 'POST', url, payload: JSON.stringify(body), headers: auth });

/** Let the stubbed turn's asynchronous tail (an empty assistant row) settle */
const settle = () => new Promise((r) => setTimeout(r, 30));

/*
 * What survived a cut, counted in questions rather than rows.
 *
 * A stubbed turn writes an empty assistant row when the process exits, and whether that has
 * landed 30ms later depends on how loaded the machine is — the row count was one locally and
 * two on CI, for the same passing code. Questions are what the cut is about and the tail is
 * never one, so this asks the question the test means to ask.
 */
const questionsIn = (id: string) =>
  convRepo.full(id, alice.id)!.messages.filter((m) => m.role === 'user').length;
const stillSays = (id: string, text: string) =>
  JSON.stringify(convRepo.full(id, alice.id)!.messages).includes(text);

/** A conversation of alternating turns, oldest first */
function conversationOf(texts: string[]): { id: string; ids: string[] } {
  const c = convRepo.create({ userId: alice.id, agent: 'claude' });
  const ids: string[] = [];
  texts.forEach((text, i) => {
    const m = convRepo.appendMessage(c.id, alice.id, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      blocks: [{ kind: 'text', blockId: 0, text }],
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    })!;
    ids.push(m.id);
  });
  return { id: c.id, ids };
}

console.log('\n=== Correcting the newest question answers it in place ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py']);
  const res = await post(`/api/conversations/${id}/messages/${ids[0]}/edit`, { text: 'sort it by size' });
  const body = res.json() as { userMessage?: { id: string; blocks: Array<{ text?: string }> } };
  ok('202', res.statusCode === 202, String(res.statusCode));
  ok('the corrected question is stored', body.userMessage?.blocks[0]?.text === 'sort it by size');
  await settle();
  ok('the old answer is gone from the record',
    !stillSays(id, 'wrote sort.py') && questionsIn(id) === 1, String(questionsIn(id)));
  ok('the discarded answer was captured for the gateway',
    trims.forConversation(id).includes('wrote sort.py'));
}

console.log('\n=== An older question cannot be edited ===');
{
  /*
   * It used to branch the conversation, and the semantics did not survive having a
   * workspace: the agent spent those turns writing files, none of it can be rewound, and a
   * branch at turn three carrying turn ten's directory is a conversation whose agent is
   * looking at code it never wrote. Asking about an older passage is what a thread does, and
   * a thread asks from here about back there — which is what actually happened.
   */
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const res = await post(`/api/conversations/${id}/messages/${ids[0]}/edit`, { text: 'sort it by hand' });
  ok('400', res.statusCode === 400, String(res.statusCode));
  ok('and it says where to go instead',
    /thread/i.test((res.json() as { error?: string }).error ?? ''), (res.json() as { error?: string }).error);
  ok('the conversation is left alone', convRepo.full(id, alice.id)!.messages.length === 4);
}

console.log('\n=== Retrying re-asks the newest question ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py']);
  const res = await post(`/api/conversations/${id}/retry`, { model: 'opus' });
  const body = res.json() as { turnId?: string; userMessage?: { blocks: Array<{ text?: string }> } };
  ok('202', res.statusCode === 202, String(res.statusCode));
  ok('the question is asked again', body.userMessage?.blocks[0]?.text === 'sort it');
  await settle();
  ok('the old answer is gone', !stillSays(id, 'wrote sort.py') && questionsIn(id) === 1,
    String(questionsIn(id)));
  ok('the model choice went through', convRepo.meta(id, alice.id)?.model === 'opus');
  ok('the discarded answer was captured for the gateway',
    trims.forConversation(id).includes('wrote sort.py'));
}

console.log('\n=== A sub-conversation shares the parent\'s session and workspace ===');
{
  const { id } = conversationOf(['sort it', 'wrote sort.py']);
  const res = await post(`/api/conversations/${id}/sub`, { text: 'what about sort.py?' });
  const body = res.json() as {
    conversationId?: string;
    conversation?: { parentId?: string; agent?: string; model?: string };
    userMessage?: { blocks: Array<{ text?: string }> };
  };
  ok('202', res.statusCode === 202, String(res.statusCode));
  ok('the child names its parent', body.conversation?.parentId === id);
  ok('the selection is its first question', body.userMessage?.blocks[0]?.text === 'what about sort.py?');
  ok('the child inherits the parent\'s agent', body.conversation?.agent === 'claude');
  await settle();
  ok('the child row exists with a title', convRepo.meta(body.conversationId!, alice.id)?.title === 'what about sort.py?');
  ok('the child works in the parent\'s directory',
    turns.workspaceDir(alice.id, body.conversationId!) === turns.workspaceDir(alice.id, id));
  ok('and the parent conversation is untouched', convRepo.full(id, alice.id)!.messages.length === 2);
}

console.log('\n=== Deleting a sub-conversation leaves the parent\'s workspace alone ===');
{
  const { id } = conversationOf(['sort it', 'wrote sort.py']);
  const dir = path.join(box, 'workspaces', alice.id, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'sort.py'), 'def sort(): pass\n');
  const sub = await post(`/api/conversations/${id}/sub`, { text: 'what about it?' });
  const childId = (sub.json() as { conversationId: string }).conversationId;
  await settle();
  const del = await app.inject({
    method: 'DELETE',
    url: `/api/conversations/${childId}`,
    // No content-type here: a DELETE carries no body, and the JSON parser refuses one
    headers: { authorization: `Bearer ${token}` },
  });
  ok('the child is deleted', del.statusCode === 204, String(del.statusCode));
  ok('the shared workspace survives', fs.existsSync(path.join(dir, 'sort.py')));
}

console.log('\n=== Deleting a conversation stops the threads inside it ===');
{
  /*
   * `abortConversation` stops one conversation, now that a thread runs beside its parent
   * rather than instead of it. Deleting the parent used to leave the thread's CLI running:
   * the cascade took its rows, `fs.rm` took the working directory out from under a process
   * still executing in it, and when the process finished `appendMessage` found no
   * conversation and dropped the answer with no error anywhere. A process burning the user's
   * quota for nobody.
   *
   * The stub is rewritten to hang so there is a running turn to observe. Same path, so
   * `config.claudeBin` — read once at module load — still points at it.
   */
  fs.writeFileSync(stubBin, '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
  const { id } = conversationOf(['sort it', 'wrote sort.py']);
  const sub = await post(`/api/conversations/${id}/sub`, { text: 'what about it?' });
  const childId = (sub.json() as { conversationId: string }).conversationId;
  await new Promise((r) => setTimeout(r, 150));
  ok('the thread is generating', turns.isBusy(childId), String(turns.isBusy(childId)));

  await app.inject({
    method: 'DELETE', url: `/api/conversations/${id}`,
    headers: { authorization: `Bearer ${token}` },
  });
  // `abort()` signals the process; the turn leaves the active map when it actually ends
  for (let i = 0; i < 40 && turns.isBusy(childId); i++) await new Promise((r) => setTimeout(r, 50));
  ok('deleting the parent stops it', !turns.isBusy(childId), String(turns.isBusy(childId)));
  ok('and the thread is gone with it', !convRepo.meta(childId, alice.id));
  fs.writeFileSync(stubBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
}

console.log('\n=== A retry that never starts leaves nothing behind ===');
{
  /*
   * The model and effort used to be written before the turn, outside the try. A retry refused
   * for quota then left the conversation on the bigger model somebody picked to retry *with*,
   * while the interface — which updates on success — still showed the old one. Two answers to
   * "which model is this on", and the hidden one is the one the next question goes to.
   *
   * An unknown agent is the cheapest way to make `startTurn` throw after the truncation: it
   * fails looking for an adapter, past every check the route makes for itself.
   */
  const broken = (model?: string) => {
    const c = convRepo.create({ userId: alice.id, agent: 'claude', ...(model ? { model } : {}) });
    db.run("update conversations set agent = 'no-such-agent' where id = ?", c.id);
    convRepo.appendMessage(c.id, alice.id, {
      role: 'user', blocks: [{ kind: 'text', blockId: 0, text: 'sort it' }],
      createdAt: new Date().toISOString(),
    });
    convRepo.appendMessage(c.id, alice.id, {
      role: 'assistant', blocks: [{ kind: 'text', blockId: 0, text: 'wrote sort.py' }],
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    return c.id;
  };

  const had = broken('sonnet');
  const res = await post(`/api/conversations/${had}/retry`, { model: 'opus' });
  ok('the failure is reported', res.statusCode >= 400, String(res.statusCode));
  ok('the model it was on is the model it is still on',
    convRepo.meta(had, alice.id)?.model === 'sonnet', String(convRepo.meta(had, alice.id)?.model));
  ok('and the question and answer came back',
    convRepo.full(had, alice.id)!.messages.length === 2,
    String(convRepo.full(had, alice.id)!.messages.length));

  // The case a naive rollback gets wrong: `update` ignores an undefined field, so restoring
  // "what it was" from a conversation that had no model at all would leave the new one standing
  const hadNone = broken();
  await post(`/api/conversations/${hadNone}/retry`, { model: 'opus' });
  ok('a conversation with no model of its own still has none',
    !convRepo.meta(hadNone, alice.id)?.model, String(convRepo.meta(hadNone, alice.id)?.model));
}

console.log('\n=== A turn that never starts leaves no trim rules behind ===');
{
  /*
   * The rules go in before the turn, and they have to: `startTurn` spawns the CLI, whose
   * first request can reach the gateway before the call returns. So a turn that never starts
   * has already written them, and putting the messages back is only half the undo — the
   * answer would be on screen and in the database while every later request had it cut out
   * of the body. A conversation the model cannot see, with nothing to undo it.
   */
  const c = convRepo.create({ userId: alice.id, agent: 'claude' });
  db.run("update conversations set agent = 'no-such-agent' where id = ?", c.id);
  const q = convRepo.appendMessage(c.id, alice.id, {
    role: 'user', blocks: [{ kind: 'text', blockId: 0, text: 'sort it' }],
    createdAt: new Date().toISOString(),
  })!;
  convRepo.appendMessage(c.id, alice.id, {
    role: 'assistant', blocks: [{ kind: 'text', blockId: 0, text: 'wrote sort.py' }],
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });

  const retried = await post(`/api/conversations/${c.id}/retry`, {});
  ok('the retry failed', retried.statusCode >= 400, String(retried.statusCode));
  ok('and took its rule back with it', !trims.forConversation(c.id).includes('wrote sort.py'),
    JSON.stringify(trims.forConversation(c.id)));

  const edited = await post(`/api/conversations/${c.id}/messages/${q.id}/edit`, { text: 'sort it by size' });
  ok('the edit failed too', edited.statusCode >= 400, String(edited.statusCode));
  ok('and left no rule either', trims.forConversation(c.id).length === 0,
    JSON.stringify(trims.forConversation(c.id)));
}

console.log('\n=== A thread can be opened while the conversation is answering ===');
{
  /*
   * `/sub` used to refuse when the parent was busy, which is the one case the feature exists
   * for — you select a passage from an earlier answer precisely because the current one is
   * still coming. It was true when a thread resumed the parent's session; it stopped being
   * true when a thread got its own.
   */
  const { id } = conversationOf(['sort it', 'wrote sort.py']);
  const busy = await post(`/api/conversations/${id}/messages`, { text: 'and now?' });
  ok('the conversation has a turn running', busy.statusCode === 202, String(busy.statusCode));
  const sub = await post(`/api/conversations/${id}/sub`, { text: '> sort.py\n\nwhat is in it?' });
  ok('a thread opens anyway', sub.statusCode === 202, String(sub.statusCode));
  await settle();
}

console.log('\n=== A thread that never starts is not left in the list ===');
{
  /*
   * The child row is created before the turn, because the turn needs somewhere to put its
   * messages. A turn refused for quota used to leave it: no question, no answer, and the
   * panel has no way to delete one. Three refused clicks, three of them in the list for good.
   */
  const { id } = conversationOf(['sort it', 'wrote sort.py']);
  db.run("update conversations set agent = 'no-such-agent' where id = ?", id);
  const sub = await post(`/api/conversations/${id}/sub`, { text: 'what about it?' });
  ok('the thread failed to open', sub.statusCode >= 400, String(sub.statusCode));
  ok('and is not in the list', convRepo.listThreads(id, alice.id).length === 0,
    JSON.stringify(convRepo.listThreads(id, alice.id)));
}

console.log('\n=== What a conversation cost counts its threads too ===');
{
  /*
   * A thread is its own conversation row, so counting by `conversation_id` alone left its
   * spend out of the one place a conversation's cost is shown. Threads are kept out of the
   * sidebar on purpose, so that money appeared nowhere but the global usage page — while
   * coming off the same quota, for questions asked from this conversation.
   */
  const { id } = conversationOf(['sort it', 'wrote sort.py']);
  const sub = await post(`/api/conversations/${id}/sub`, { text: 'what about it?' });
  const childId = (sub.json() as { conversationId: string }).conversationId;
  await settle();

  const spend = (conversationId: string, inputTokens: number) =>
    usage.record({
      userId: alice.id, conversationId, agent: 'claude', model: 'sonnet',
      usage: { inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
      status: 'ok',
    } as never);
  spend(id, 1000);
  spend(childId, 250);

  const res = await app.inject({
    method: 'GET', url: `/api/conversations/${id}/usage`,
    headers: { authorization: `Bearer ${token}` },
  });
  const rows = (res.json() as { byModel: Array<{ model: string; inputTokens: number }> }).byModel;
  const total = rows.reduce((n, r) => n + r.inputTokens, 0);
  ok('the thread\'s tokens are in the conversation\'s total', total === 1250, String(total));

  // And a thread asked about on its own still answers for itself alone
  const own = await app.inject({
    method: 'GET', url: `/api/conversations/${childId}/usage`,
    headers: { authorization: `Bearer ${token}` },
  });
  const mine = (own.json() as { byModel: Array<{ inputTokens: number }> }).byModel
    .reduce((n, r) => n + r.inputTokens, 0);
  ok('and the thread alone is still the thread alone', mine === 250, String(mine));
}

console.log('\n=== The guards around editing ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py']);
  const onAnswer = await post(`/api/conversations/${id}/messages/${ids[1]}/edit`, { text: 'nope' });
  ok('an assistant message cannot be edited', onAnswer.statusCode === 400, String(onAnswer.statusCode));
  const missing = await post(`/api/conversations/${id}/messages/no-such/edit`, { text: 'nope' });
  ok('a message nobody knows is 404', missing.statusCode === 404, String(missing.statusCode));
  const empty = await post(`/api/conversations/${convRepo.create({ userId: alice.id, agent: 'claude' }).id}/retry`, {});
  ok('a conversation with no question cannot be retried', empty.statusCode === 400, String(empty.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

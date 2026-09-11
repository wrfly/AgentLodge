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
const trims = await import('../../core/db/trims.js');
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
  const body = res.json() as { forked?: boolean; userMessage?: { id: string; blocks: Array<{ text?: string }> } };
  ok('202', res.statusCode === 202, String(res.statusCode));
  ok('the answer is replaced in place', body.forked === false);
  ok('the corrected question is stored', body.userMessage?.blocks[0]?.text === 'sort it by size');
  await settle();
  const conv = convRepo.full(id, alice.id)!;
  ok('the old answer is gone from the record', conv.messages.length === 1, String(conv.messages.length));
  ok('the discarded answer was captured for the gateway',
    trims.forConversation(id).includes('wrote sort.py'));
}

console.log('\n=== Editing an older question branches ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const res = await post(`/api/conversations/${id}/messages/${ids[0]}/edit`, { text: 'sort it by hand' });
  const body = res.json() as { forked?: boolean; conversationId?: string; filesCopied?: boolean; userMessage?: { blocks: Array<{ text?: string }> } };
  ok('202', res.statusCode === 202, String(res.statusCode));
  ok('it says it branched', body.forked === true);
  ok('with the corrected question as its first message', body.userMessage?.blocks[0]?.text === 'sort it by hand');
  await settle();
  const fork = convRepo.full(body.conversationId!, alice.id)!;
  ok('the branch keeps what came before', fork.messages.length === 1, String(fork.messages.length));
  ok('and the source is untouched', convRepo.full(id, alice.id)!.messages.length === 4);
  ok('an empty source directory means no files came over', body.filesCopied === false);
}

console.log('\n=== A branch with a real workspace copies it ===');
{
  // Two questions, so editing the first one branches rather than re-answers in place
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const dir = path.join(box, 'workspaces', alice.id, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'sort.py'), 'def sort(): pass\n');
  const res = await post(`/api/conversations/${id}/messages/${ids[0]}/edit`, { text: 'sort it by hand' });
  const body = res.json() as { filesCopied?: boolean; conversationId?: string };
  ok('the workspace came over', body.filesCopied === true, JSON.stringify(body));
  const forkDir = path.join(box, 'workspaces', alice.id, body.conversationId!);
  ok('and the file is in the branch', fs.existsSync(path.join(forkDir, 'sort.py')));
}

console.log('\n=== Retrying re-asks the newest question ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py']);
  const res = await post(`/api/conversations/${id}/retry`, { model: 'opus' });
  const body = res.json() as { turnId?: string; userMessage?: { blocks: Array<{ text?: string }> } };
  ok('202', res.statusCode === 202, String(res.statusCode));
  ok('the question is asked again', body.userMessage?.blocks[0]?.text === 'sort it');
  await settle();
  const conv = convRepo.full(id, alice.id)!;
  ok('the old answer is gone', conv.messages.length === 1, String(conv.messages.length));
  ok('the model choice went through', conv.model === 'opus');
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

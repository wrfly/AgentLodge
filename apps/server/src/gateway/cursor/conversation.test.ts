/**
 * How a Cursor conversation is recognised from one request to the next.
 *
 * The failure this file exists for is silent and expensive: an API-key session has no
 * gateway conversation id, so the lane used to be keyed by the first two messages. The
 * second turn of a thread is `[user, assistant, user]`, that hash changed, the checkpoint
 * was never found, and Cursor billed the whole transcript as fresh input.
 *
 * Run: npm -w @agentlodge/server run test:cursor-conversation
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-cursor-conv-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('../../core/db/index.js');
initDb();
const { canonical, clear, identify, keep, planFor, recall, threadOf, unload, asideOf } = await import('./conversation.js');

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

const model = { id: 'claude-sonnet-5', parameters: [] as { [k: string]: unknown }[], max: false };
const user = (text: string) => ({ role: 'user', text });
const assistant = (text: string) => ({ role: 'assistant', text });

clear();

console.log('\n=== An API-key thread is the same conversation on the second turn ===');
{
  const first = identify({ userId: 'u1', model, messages: [user('fix the tests')] });
  const second = identify({
    userId: 'u1',
    model,
    messages: [user('fix the tests'), assistant('done'), user('and the types')],
  });
  ok('the lane does not change after the first reply', first.lane === second.lane, `${first.lane} vs ${second.lane}`);
  ok(
    'and it is not the first-two-messages hash, which would have moved',
    first.lane.includes('open:'),
    first.lane,
  );
}

console.log('\n=== Claude Code\'s session id is the thread, when it sent one ===');
{
  const fromHeader = threadOf({ 'x-claude-code-session-id': 'sess-abc' }, {});
  ok('the header is enough', fromHeader === 'sess-abc');

  const fromMeta = threadOf(
    {},
    { metadata: { user_id: JSON.stringify({ device_id: 'x', session_id: 'sess-from-meta' }) } },
  );
  ok('and so is the blob inside metadata.user_id', fromMeta === 'sess-from-meta');

  const a = identify({ conversationId: 'sess-abc', userId: 'u1', model, messages: [user('hi')] });
  const b = identify({
    conversationId: 'sess-abc',
    userId: 'u1',
    model,
    messages: [user('hi'), assistant('hello'), user('go on')],
  });
  ok('two turns of the same session share a lane', a.lane === b.lane);
  ok(
    'two users with the same session id do not',
    identify({ conversationId: 'sess-abc', userId: 'u2', model, messages: [user('hi')] }).lane !== a.lane,
  );
}

console.log('\n=== A system prompt that drifted is still a continuation ===');
{
  const held = {
    state: new Uint8Array([1]),
    blobs: new Map<string, Uint8Array>(),
    messages: [user('fix it'), assistant('done')],
    system: 'today is Thursday. git: clean',
  };
  const now = [user('fix it'), assistant('done'), user('ship it')];
  const plan = planFor(held, now, 'today is Friday. git: 1 dirty');
  ok('it continues rather than starting again', plan.kind === 'continue', plan.kind);
  if (plan.kind === 'continue') ok('from the new message', plan.from === 2, String(plan.from));
}

console.log('\n=== A classifier beside the thread is still an aside ===');
{
  const held = {
    state: new Uint8Array([1]),
    blobs: new Map<string, Uint8Array>(),
    messages: Array.from({ length: 10 }, (_, i) => (i % 2 === 0 ? user(`q${i}`) : assistant(`a${i}`))),
    system: 'be a coding agent',
  };
  const plan = planFor(held, [user('name this')], 'name this conversation in four words');
  ok('a short exchange under other instructions does not take the lane', plan.kind === 'aside', plan.kind);

  const thread = identify({ conversationId: 'sess-1', userId: 'u1', model, messages: held.messages });
  const side = asideOf(thread, [user('name this')], 'name this conversation in four words');
  ok('the aside is a different conversation', side.id !== thread.id);
  ok('under the same group', side.groupId === thread.groupId);
  ok('and a different lane, so it cannot overwrite the thread', side.lane !== thread.lane && side.lane.startsWith(thread.lane));
  const again = asideOf(thread, [user('name this'), assistant('short title'), user('shorter')], 'name this conversation in four words');
  ok('a second turn of the same aside is the same conversation', again.lane === side.lane && again.id === side.id);
}

console.log('\n=== A checkpoint survives the process forgetting it ===');
{
  const messages = canonical([{ role: 'user', content: 'remember seven' }]);
  const id = identify({ conversationId: 'sess-1', userId: 'u1', model, messages });
  keep(
    { lane: id.lane, messages, system: 'be brief' },
    { state: new TextEncoder().encode('checkpoint-bytes'), blobs: new Map([['b1', new Uint8Array([9])]]) },
  );
  ok('it is held', Boolean(recall(id.lane)?.state.length), JSON.stringify(recall(id.lane)?.state));
  unload();
  const again = recall(id.lane);
  ok('and after a restart it is still there', Buffer.from(again?.state ?? []).toString() === 'checkpoint-bytes');
  ok('with the blob it was asked to keep', Buffer.from(again?.blobs.get('b1') ?? []).equals(new Uint8Array([9])));
  clear();
  ok('clearing drops the store too', recall(id.lane) === undefined);
}

clear();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

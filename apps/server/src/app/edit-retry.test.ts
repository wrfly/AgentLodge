/**
 * Editing a question, and asking one again.
 *
 * Which of two things an edit means is decided by where the message sits: correcting the
 * newest question means the answer was to the wrong question, so it goes; editing something
 * from several turns back is a branch, because the exchanges after it happened and somebody
 * may still want them.
 *
 * What is checked here is everything that decision rests on — the record either being cut at
 * the right place or copied to a new one, and the branch arriving with the files its
 * transcript talks about. The agent's own memory cannot be branched: the CLI's session is an
 * opaque handle with no rewind, which is why the fork starts a new one and is handed the kept
 * messages as text, and why the directory is copied rather than described.
 *
 * Run: npm -w @agentlodge/server run test:edit-retry
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-edit-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('../core/db/index.js');
initDb();
const convRepo = await import('../core/db/conversations.js');
const trims = await import('../core/db/trims.js');
const users = await import('../core/db/users.js');
const turns = await import('./turns.js');

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
}).id;

/** A conversation of alternating turns, oldest first */
function conversationOf(texts: string[]): { id: string; ids: string[] } {
  const c = convRepo.create({ userId: alice, agent: 'claude' });
  const ids: string[] = [];
  texts.forEach((text, i) => {
    const m = convRepo.appendMessage(c.id, alice, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      blocks: [{ kind: 'text', blockId: 0, text }],
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    })!;
    ids.push(m.id);
  });
  return { id: c.id, ids };
}

console.log('\n=== Which message an edit lands on ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const last = convRepo.lastUserMessage(id, alice);
  ok('the newest question is the third message', last?.id === ids[2], String(last?.seq));
  ok('and an older one is not it', last?.id !== ids[0]);
  const at = convRepo.messageAt(id, alice, ids[2]!);
  ok('a message knows its own position', at?.seq === 2, String(at?.seq));
  ok('an id from another conversation finds nothing',
    convRepo.messageAt(convRepo.create({ userId: alice, agent: 'claude' }).id, alice, ids[0]!) === undefined);
}

console.log('\n=== Correcting the newest question cuts the answer to it ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const at = convRepo.messageAt(id, alice, ids[2]!)!;
  const gone = convRepo.truncateFrom(id, alice, at.seq);
  ok('the question and its answer both go', gone === 2, String(gone));
  const left = convRepo.full(id, alice)!.messages;
  ok('what came before is untouched', left.length === 2, String(left.length));
  ok('and is still in order', left[0]!.blocks[0]!.kind === 'text' && left[1]!.role === 'assistant');
  const next = convRepo.appendMessage(id, alice, {
    role: 'user', blocks: [{ kind: 'text', blockId: 0, text: 'make it merge sort' }],
    createdAt: new Date().toISOString(),
  })!;
  ok('the replacement takes the vacated position',
    convRepo.messageAt(id, alice, next.id)?.seq === 2,
    String(convRepo.messageAt(id, alice, next.id)?.seq));
}

console.log('\n=== What a branch is handed ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const at = convRepo.messageAt(id, alice, ids[0]!)!;
  const kept = convRepo.messagesBefore(id, alice, at.seq);
  ok('branching at the first message keeps nothing', kept.length === 0);

  const at2 = convRepo.messageAt(id, alice, ids[2]!)!;
  const kept2 = convRepo.messagesBefore(id, alice, at2.seq);
  ok('branching at the third keeps the first two', kept2.length === 2, String(kept2.length));
  const text = turns.transcript(kept2);
  ok('rendered as who said what', text === 'User: sort it\n\nYou: wrote sort.py', JSON.stringify(text));
  ok('and the source is left whole', convRepo.full(id, alice)!.messages.length === 4);
}

console.log('\n=== A stored question is what was asked, not the replay around it ===');
{
  const { id, ids } = conversationOf(['sort it']);
  convRepo.rewriteMessage(id, alice, ids[0]!, 'make it merge sort');
  const m = convRepo.messageAt(id, alice, ids[0]!)!;
  const shown = m.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
  ok('the record shows the question', shown === 'make it merge sort', shown);
  ok('at its original position', m.seq === 0);
}

console.log('\n=== The discarded answer is captured for the gateway to drop ===');
{
  const { id, ids } = conversationOf(['sort it', 'wrote sort.py', 'make it quicksort', 'now quicksort']);
  const answer = convRepo.lastAssistantMessage(id, alice);
  ok('the newest assistant message is the answer to the last question', answer?.id === ids[3], String(answer?.seq));
  ok('an empty conversation has no answer to capture',
    convRepo.lastAssistantMessage(convRepo.create({ userId: alice, agent: 'claude' }).id, alice) === undefined);

  const text = answer!.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
  ok('a rule is stored for it', trims.add(id, text) === true);
  ok('and read back for the gateway', trims.forConversation(id).includes('now quicksort'));
  ok('an empty text stores nothing', trims.add(id, '   ') === false);
  ok('and a rule for another conversation stays out of this one',
    !trims.forConversation(convRepo.create({ userId: alice, agent: 'claude' }).id).length);
}

console.log('\n=== A sub-conversation resolves to its parent for workspace and session ===');
{
  const parent = convRepo.create({ userId: alice, agent: 'claude' });
  const child = convRepo.create({ userId: alice, agent: 'claude', parentId: parent.id });
  const grandchild = convRepo.create({ userId: alice, agent: 'claude', parentId: child.id });

  ok('a child names its parent', convRepo.full(child.id, alice)!.parentId === parent.id);
  ok('a plain conversation has no parent', convRepo.full(parent.id, alice)!.parentId === undefined);
  ok('the family root is the topmost conversation',
    convRepo.rootOf(grandchild.id, alice) === parent.id,
    convRepo.rootOf(grandchild.id, alice));
  ok('and a plain conversation is its own root', convRepo.rootOf(parent.id, alice) === parent.id);

  ok('the family is the root plus every descendant',
    JSON.stringify(convRepo.familyIds(grandchild.id, alice).sort()) ===
      JSON.stringify([parent.id, child.id, grandchild.id].sort()),
    JSON.stringify(convRepo.familyIds(grandchild.id, alice)));
  ok('and from the root it is the whole family',
    JSON.stringify(convRepo.familyIds(parent.id, alice).sort()) ===
      JSON.stringify([parent.id, child.id, grandchild.id].sort()));

  /*
   * Sessions are not shared, and that is the point of a thread: a shared one made the two a
   * single transcript in the model's eyes, so everything asked off to one side came back in
   * the parent's context on the next turn.
   */
  convRepo.update(parent.id, alice, { agentSessionId: 'sess-1' });
  ok('a thread does not inherit its parent\'s session',
    convRepo.meta(child.id, alice)?.agentSessionId === undefined,
    String(convRepo.meta(child.id, alice)?.agentSessionId));
  ok('and keeps its own once it has one',
    (convRepo.update(child.id, alice, { agentSessionId: 'sess-2' }),
      convRepo.meta(parent.id, alice)?.agentSessionId === 'sess-1'));

  ok('the directory, though, is shared — a file is a fact about the work',
    turns.workspaceDir(alice, child.id) === turns.workspaceDir(alice, parent.id));
  ok('and the grandchild\'s too',
    turns.workspaceDir(alice, grandchild.id) === turns.workspaceDir(alice, parent.id));
}

console.log('\n=== The branch gets the files its transcript talks about ===');
{
  const from = path.join(box, 'src-ws');
  const to = path.join(box, 'fork-ws');
  await fsp.mkdir(path.join(from, 'node_modules', 'left-pad'), { recursive: true });
  await fsp.writeFile(path.join(from, 'sort.py'), 'def sort(): pass\n');
  await fsp.writeFile(path.join(from, 'node_modules', 'left-pad', 'index.js'), 'x'.repeat(1000));

  ok('the copy reports it happened', (await turns.copyWorkspace(from, to)) === true);
  ok('the work came across', fs.existsSync(path.join(to, 'sort.py')));
  ok('what can be regenerated did not', !fs.existsSync(path.join(to, 'node_modules')));

  const missing = path.join(box, 'never-written');
  ok('a directory that was never written is not an error',
    (await turns.copyWorkspace(missing, path.join(box, 'fork-2'))) === false);
  ok('and leaves no half-made copy behind', !fs.existsSync(path.join(box, 'fork-2')));
}

console.log('\n=== What a thread is handed, and how much of it ===');
{
  /*
   * A thread does not resume the conversation's session, so the conversation goes as text.
   * "The conversation" can be a thousand turns, and a passage is almost always about the
   * recent end of it, so the budget is spent from the end backwards.
   */
  const long = convRepo.create({ userId: alice, agent: 'claude' });
  for (let i = 0; i < 60; i++) {
    convRepo.appendMessage(long.id, alice, {
      role: i % 2 === 0 ? 'user' : 'assistant',
      blocks: [{ kind: 'text', blockId: 0, text: `turn ${i} ` + 'x'.repeat(400) }],
      createdAt: new Date(Date.now() + i * 1000).toISOString(),
    });
  }
  const all = convRepo.full(long.id, alice)!.messages;
  const full = turns.transcript(all);
  const capped = turns.recentTranscript(all, 4_000);
  ok('the whole thing is longer than the budget', full.length > 4_000, String(full.length));
  ok('what is sent fits in it', capped.length <= 4_000, String(capped.length));
  ok('and it is the recent end, not the old one', capped.includes('turn 59') && !capped.includes('turn 0 '),
    capped.slice(0, 40));
  ok('a conversation with nothing in it sends nothing',
    turns.recentTranscript([]) === '');
  /* One message over budget is still one message: sending nothing would be worse */
  ok('and a single oversized message does not blank it out',
    turns.recentTranscript(all, 10).length === 0 || turns.recentTranscript(all, 10).length <= 10);
}

console.log('\n=== A thread is labelled by the passage, not by the prompt ===');
{
  /*
   * The opening prompt is a quotation followed by a question, and the question is the same
   * boilerplate on every thread nobody retyped. A label taken from the prompt whole reads
   * "> directories Tell me more about this." — quote markers, and the one part of the text
   * that tells you nothing about which thread it is.
   */
  const parent = convRepo.create({ userId: alice, agent: 'claude' });
  const child = convRepo.create({ userId: alice, agent: 'claude', parentId: parent.id });
  convRepo.appendMessage(child.id, alice, {
    role: 'user',
    blocks: [{ kind: 'text', blockId: 0, text: '> the sort is stable\n> and runs in place\n\nTell me more about this.' }],
    createdAt: new Date().toISOString(),
  });
  const [listed] = convRepo.listThreads(parent.id, alice);
  ok('the label is the quoted passage', listed?.about === 'the sort is stable and runs in place', listed?.about);
  ok('with no quote markers', !(listed?.about ?? '').includes('>'));
  ok('and not the boilerplate question', !(listed?.about ?? '').includes('Tell me more'));

  const plain = convRepo.create({ userId: alice, agent: 'claude', parentId: parent.id });
  convRepo.appendMessage(plain.id, alice, {
    role: 'user',
    blocks: [{ kind: 'text', blockId: 0, text: 'just a question, no quotation' }],
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  ok('a thread opened without a quotation keeps its whole first message',
    convRepo.listThreads(parent.id, alice).find((x) => x.id === plain.id)?.about === 'just a question, no quotation');
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

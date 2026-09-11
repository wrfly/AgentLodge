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
const claude = await import('./agents/claude.js');

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
  ok('the question and its answer both go', gone.length === 2, String(gone.length));
  /*
   * Handed back, not just counted. The rows are the only copy of what somebody typed, and the
   * turn meant to replace them can still fail — a quota that ran out, an engine that is down.
   * Without this the route answers 402 over the space where the question used to be.
   */
  ok('and come back with what they said', gone[0]!.blocks[0]!.kind === 'text'
    && (gone[0]!.blocks[0] as { text: string }).text === 'make it quicksort',
    JSON.stringify(gone[0]!.blocks[0]));
  convRepo.restoreMessages(id, alice, gone);
  ok('putting them back restores the conversation', convRepo.full(id, alice)!.messages.length === 4);
  ok('at the positions they held',
    convRepo.messageAt(id, alice, ids[2]!)?.seq === 2 && convRepo.messageAt(id, alice, ids[3]!)?.seq === 3);
  ok('and doing it twice changes nothing',
    (convRepo.restoreMessages(id, alice, gone), convRepo.full(id, alice)!.messages.length === 4));
  convRepo.truncateFrom(id, alice, at.seq);
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
  /*
   * Rules come from the rows that were actually cut, not from "the newest answer in the
   * conversation". After a turn that died without storing an answer — a restart mid-stream,
   * an error path — the newest answer is an *earlier* one, still on screen and legitimately
   * in the CLI's transcript, and a rule for it would remove it from every later request.
   */
  const cut = convRepo.truncateFrom(id, alice, convRepo.messageAt(id, alice, ids[2]!)!.seq);
  const answers = cut.filter((m) => m.role === 'assistant');
  ok('only the answer inside the cut is captured', answers.length === 1 && answers[0]!.id === ids[3],
    JSON.stringify(answers.map((a) => a.id)));
  convRepo.restoreMessages(id, alice, cut);

  const text = answers[0]!.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('');
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
  /*
   * One message over budget on its own, which is routine — an answer that dumps a file is
   * past 24 000 characters by itself. The loop spends the budget from the end backwards and
   * breaks on the first message that does not fit, so this used to come back empty: a thread
   * whose whole premise is being handed the conversation got none of it, and answered the
   * bare question anyway, plausibly and wrongly.
   *
   * The old assertion here read `length === 0 || length <= 10`, which is true of every
   * number, and its comment said sending nothing would be worse — which is what the code
   * did.
   */
  const huge = convRepo.create({ userId: alice, agent: 'claude' });
  convRepo.appendMessage(huge.id, alice, {
    role: 'assistant',
    blocks: [{ kind: 'text', blockId: 0, text: 'HEAD ' + 'x'.repeat(30_000) + ' TAIL' }],
    createdAt: new Date().toISOString(),
  });
  const oversized = turns.recentTranscript(convRepo.full(huge.id, alice)!.messages, 2_000);
  ok('one message over budget still sends something', oversized.length > 0, String(oversized.length));
  ok('within the budget, plus the mark', oversized.length <= 2_001, String(oversized.length));
  ok('and it is the end of it, where the passage will be', oversized.includes('TAIL'));
  ok('marked as cut, rather than passing for the whole thing', oversized.startsWith('…'));
  ok('a conversation of nothing but empty messages still sends nothing',
    turns.recentTranscript([{ role: 'assistant', blocks: [] }] as never, 2_000) === '');
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

console.log('\n=== A thread runs beside the conversation, not instead of it ===');
{
  /*
   * The lock used to be a family question, because a thread resumed its parent's session and
   * a session has one transcript. They have their own sessions now, and the lock outlived its
   * reason: asking anything in the panel froze the main conversation until it answered, which
   * is the one thing asking off to the side exists to avoid.
   *
   * What the family still shares is the directory. That is handled by the thread reading and
   * not writing, rather than by stopping everything else.
   */
  const parent = convRepo.create({ userId: alice, agent: 'claude' });
  const thread = convRepo.create({ userId: alice, agent: 'claude', parentId: parent.id });
  ok('neither is busy to begin with', !turns.isBusy(parent.id) && !turns.isBusy(thread.id));

  const base = { prompt: 'x', cwd: '/tmp', onEvent: () => {}, onSessionId: () => {} };
  const open = claude.turnArgs({ ...base });
  const shut = claude.turnArgs({ ...base, readOnly: true });
  const toolsOf = (a: string[]) => a[a.indexOf('--disallowedTools') + 1] ?? '';
  ok('a conversation may write', !/Write/.test(toolsOf(open)), toolsOf(open));
  ok('a thread may not', /Write/.test(toolsOf(shut)) && /Edit/.test(toolsOf(shut)), toolsOf(shut));
  ok('and may not shell out either', /Bash/.test(toolsOf(shut)));
  ok('reading is still allowed', !/(^|,)Read(,|$)/.test(toolsOf(shut)), toolsOf(shut));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

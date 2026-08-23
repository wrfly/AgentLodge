/**
 * Summarising conversations, and reading them back.
 *
 * Two things here are easy to get quietly wrong: deciding which conversations still need
 * summarising — get it wrong one way and every conversation is paid for again on every
 * run, the other way and a conversation that has moved on keeps a stale summary — and
 * pulling a portrait out of an answer whose shape the model chooses.
 *
 * Run: npm -w @agentlodge/server run test:recap
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-recap-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, run } = await import('../core/db/index.js');
initDb();
const users = await import('../core/db/users.js');
const convs = await import('../core/db/conversations.js');
const recap = await import('./recap.js');

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

const userId = users.create({ email: 'a@b.c', username: 'a', passwordHash: 'x', role: 'user' }).id;
let seq = 0;

function conversation(title: string, messages: number, opts: { owner?: string; lastAt?: string } = {}): string {
  const c = convs.create({ userId: opts.owner ?? userId, agent: 'claude', title });
  if (opts.lastAt) run('update conversations set last_message_at = ? where id = ?', opts.lastAt, c.id);
  for (let i = 0; i < messages; i++) {
    run(
      `insert into messages (id, conversation_id, seq, role, blocks, aborted, created_at)
       values (?, ?, ?, ?, ?, 0, ?)`,
      `m-${seq++}`,
      c.id,
      i,
      i % 2 === 0 ? 'user' : 'assistant',
      JSON.stringify([{ kind: 'text', blockId: 0, text: `line ${i} of ${title}, long enough to be worth reading` }]),
      new Date(2026, 7, 20, 10, i).toISOString(),
    );
  }
  return c.id;
}

const summarize = (id: string, upto: number) =>
  run(
    'update conversations set summary = ?, summary_at = ?, summary_upto = ? where id = ?',
    'They asked about X and settled on Y.',
    new Date().toISOString(),
    upto,
    id,
  );

console.log('\n=== Which conversations still need reading ===');
{
  const fresh = conversation('fresh', 4);
  const stale = conversation('moved on', 6);
  const done = conversation('already done', 4);
  const oneLine = conversation('one message', 1);

  summarize(stale, 2);
  summarize(done, 4);

  const ids = recap.pending(userId).map((c) => c.id);
  ok('one with no summary at all', ids.includes(fresh));
  ok('one whose conversation moved on', ids.includes(stale));
  ok('not one already covered', !ids.includes(done), JSON.stringify(ids));
  ok('and not a conversation of one message', !ids.includes(oneLine));
  ok('the message count comes with it', recap.pending(userId).find((c) => c.id === stale)?.messages === 6);

  // Summarising it again is what makes it stop coming back
  summarize(stale, 6);
  ok('bringing it up to date takes it off the list', !recap.pending(userId).some((c) => c.id === stale));
}

console.log('\n=== The transcript handed to the model ===');
{
  const id = conversation('who said what', 4);
  const text = recap.transcript(id, userId);
  ok('both sides are labelled', text.includes('Them:') && text.includes('Assistant:'), text.slice(0, 80));
  ok('oldest first', text.indexOf('line 0') < text.indexOf('line 3'));
  ok('another user gets nothing', recap.transcript(id, 'someone-else') === '');
}

console.log('\n=== Pulling a portrait out of the answer ===');
{
  const answer = [
    'You build backend services in Go and TypeScript.',
    'You ask short questions and want short answers.',
    '',
    '---',
    '',
    '- Writes Go and TypeScript',
    '2. Prefers short answers',
    '• Deploys with podman',
  ].join('\n');
  const p = recap.parsePortrait(answer);
  ok('the prose stops at the divider', p.text.endsWith('short answers.'), p.text);
  ok('and keeps its own line breaks', p.text.includes('\n'));
  ok('three candidates', p.candidates.length === 3, JSON.stringify(p.candidates));
  ok('dashes are stripped', p.candidates[0] === 'Writes Go and TypeScript');
  ok('numbering too', p.candidates[1] === 'Prefers short answers');
  ok('and bullet characters', p.candidates[2] === 'Deploys with podman');

  const noDivider = recap.parsePortrait('Just a paragraph about you.');
  ok('an answer with no divider is all prose', noDivider.text === 'Just a paragraph about you.');
  ok('and offers nothing', noDivider.candidates.length === 0);

  const many = recap.parsePortrait(`x\n---\n${Array.from({ length: 20 }, (_, i) => `fact ${i}`).join('\n')}`);
  ok('a long list is capped', many.candidates.length === 8, String(many.candidates.length));

  const heading = recap.parsePortrait('x\n---\nWorth remembering:\n- A real one');
  ok('a heading it adds is dropped', !heading.candidates.includes('Worth remembering:'), JSON.stringify(heading.candidates));
}

console.log('\n=== What the page reads back ===');
{
  const list = recap.recent(userId);
  ok('only summarised conversations', list.every((c) => c.summary.length > 0));
  ok('the two that have one', list.length === 2, String(list.length));
  ok('nothing belonging to anyone else', recap.recent('someone-else').length === 0);
  ok('no portrait until one is written', recap.portrait(userId) === undefined);
}

console.log('\n=== What the sweep picks up ===');
{
  const long_ago = new Date(Date.now() - 60 * 60_000).toISOString();
  const just_now = new Date(Date.now() - 60_000).toISOString();
  const cutoff = new Date(Date.now() - 15 * 60_000).toISOString();

  const quiet = conversation('gone quiet', 4, { lastAt: long_ago });
  const live = conversation('still going', 4, { lastAt: just_now });
  const covered = conversation('covered', 4, { lastAt: long_ago });
  summarize(covered, 4);

  const other = users.create({ email: 'b@b.c', username: 'b', passwordHash: 'x', role: 'user' }).id;
  const theirs = conversation('someone else', 4, { owner: other, lastAt: long_ago });

  const picked = recap.stale(cutoff);
  const ids = picked.map((c) => c.id);
  ok('a conversation that has gone quiet', ids.includes(quiet));
  ok('but not one still being typed into', !ids.includes(live), JSON.stringify(ids));
  ok('nor one already covered', !ids.includes(covered));
  ok('everybody is swept, not one user', ids.includes(theirs));
  ok('and each carries its owner', picked.find((c) => c.id === theirs)?.user_id === other);

  // Nothing has last_message_at unless a turn set it; those cannot be judged idle
  ok('conversations with no last message are left alone', !ids.includes(conversation('never sent', 4)));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

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

console.log('\n=== Naming the conversation after what it was about ===');
{
  const r = recap.parseRecap('用 podman 部署\n\n他们在排查容器起不来的问题，最后发现是挂载路径写错了。');
  ok('the first line becomes the title', r.title === '用 podman 部署', r.title);
  ok('and is not left in the summary', r.summary.startsWith('他们在排查'), r.summary);

  ok('quotes are stripped', recap.parseRecap('"Deploying with podman"\n\nA summary.').title === 'Deploying with podman');
  ok('so is a heading marker', recap.parseRecap('# Deploying\n\nA summary.').title === 'Deploying');
  ok('and a trailing stop', recap.parseRecap('部署问题。\n\n一段总结。').title === '部署问题');

  const long = recap.parseRecap(`${'x'.repeat(40)}\n\nA summary.`);
  ok('a long-ish title is cut, not dropped', long.title?.length === 29, String(long.title?.length));

  // The whole answer as one paragraph is a summary, not a title
  const blob = recap.parseRecap('They were trying to work out why the container would not start, and it turned out to be the mount path.');
  ok('one long line is all summary', blob.title === undefined, blob.title);
  ok('and nothing is lost from it', blob.summary.startsWith('They were trying'));

  const titleOnly = recap.parseRecap('Just a title');
  ok('a title with no summary is not a title', titleOnly.title === undefined);
}

console.log('\n=== A name the user typed is theirs ===');
{
  const mine = conversation('mine', 4);
  ok('an automatic name lands', convs.retitle(mine, 'What it was about'));
  ok('and is what the conversation is called', convs.meta(mine, userId)?.title === 'What it was about');

  const own = conversation('own', 4);
  convs.update(own, userId, { title: 'My own name', titleCustom: true });
  ok('a name typed by hand is not replaced', !convs.retitle(own, 'Something else'));
  ok('and stands', convs.meta(own, userId)?.title === 'My own name');
}

console.log('\n=== Named once, and not again ===');
{
  const once = conversation('once', 4);
  ok('the first name lands', convs.retitle(once, 'What it is about'));
  ok('a second call changes nothing', !convs.retitle(once, 'Something else'));
  ok('and the first name stands', convs.meta(once, userId)?.title === 'What it is about');
}

console.log('\n=== An answer that cannot be used still counts as tried ===');
{
  // The guard has to mean "has this been tried", not "did it work". A model that replies
  // with a whole sentence — the failure cleanTitle exists for — used to leave title_at
  // null, so the next turn read the conversation again, called the model again, and billed
  // the user again, for as long as the conversation lived.
  const tried = conversation('opening line', 4);
  const before = convs.meta(tried, userId)?.title;

  convs.markNamingTried(tried);

  ok('the name it had is untouched', convs.meta(tried, userId)?.title === before);
  ok('but nothing will name it again', !convs.retitle(tried, 'A model got there late'));
  ok('and it still shows the old name', convs.meta(tried, userId)?.title === before);

  // Idempotent, so a second turn racing the first cannot move the stamp.
  convs.markNamingTried(tried);
  ok('marking twice is a no-op', !convs.retitle(tried, 'Later still'));
}

console.log('\n=== The questions a name is made from ===');
{
  // 12 messages alternate user/assistant, so six of them are questions
  const long = conversation('long', 12);
  const body = recap.questions(long, userId);
  const lines = body.split('\n\n');
  ok('the opening questions only', lines.length === 5, String(lines.length));
  ok('oldest first', lines[0]?.includes('line 0') === true && lines[4]?.includes('line 8') === true, body.slice(0, 60));
  ok('nothing the assistant said', !body.includes('line 1'), body.slice(0, 60));
  ok('another user gets nothing', recap.questions(long, 'someone-else') === '');
}

console.log('\n=== A short question is still a question ===');
{
  const short = convs.create({ userId, agent: 'claude', title: '美国总统是谁' });
  run(
    `insert into messages (id, conversation_id, seq, role, blocks, aborted, created_at)
     values (?, ?, 0, 'user', ?, 0, ?)`,
    'm-short',
    short.id,
    JSON.stringify([{ kind: 'text', blockId: 0, text: '美国总统是谁' }]),
    new Date().toISOString(),
  );
  ok('six characters are enough to name it from', recap.questions(short.id, userId) === '美国总统是谁');

  const empty = convs.create({ userId, agent: 'claude', title: 'empty' });
  ok('a conversation with nothing said in it is not', recap.questions(empty.id, userId) === '');
}

console.log('\n=== A title out of what the model answered ===');
{
  ok('a decorated one is cleaned up', recap.cleanTitle('## "Container mount path".') === 'Container mount path');
  ok('a sentence is not a title', recap.cleanTitle('They were trying to work out why the container would not start at all, and it turned out to be the mount path') === undefined);
  ok('an empty answer is nothing', recap.cleanTitle('   ') === undefined);
}

console.log('\n=== Not on the last minute of a subscription window ===');
{
  const { setSetting } = await import('../core/db/settings.js');
  const at = (ms: number) => new Date(Date.now() + ms).toISOString();

  ok('nothing reported means nothing to wait for', !recap.windowAboutToRoll());

  setSetting('quota.windowResetAt', at(4 * 60_000));
  ok('four minutes left is fine', !recap.windowAboutToRoll());

  setSetting('quota.windowResetAt', at(30_000));
  ok('thirty seconds left waits for the next window', recap.windowAboutToRoll());

  setSetting('quota.windowResetAt', at(-60_000));
  ok('a window that already rolled is not the tail of one', !recap.windowAboutToRoll());
  setSetting('quota.windowResetAt', '');
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

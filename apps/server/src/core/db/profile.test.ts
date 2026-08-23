/**
 * The counted profile.
 *
 * The failures worth guarding are the quiet ones: a time-of-day chart that is hours out
 * because the server's clock is not the reader's, and a tool-use count that misses turns
 * because it is matching the wrong shape of stored JSON.
 *
 * Run: npm -w @agentlodge/server run test:profile
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-profile-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, run } = await import('./index.js');
initDb();
const users = await import('./users.js');
const convs = await import('./conversations.js');
const profile = await import('./profile.js');

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

const userId = users.create({
  email: 'a@example.com',
  username: 'a',
  passwordHash: 'x',
  role: 'user',
}).id;

const conv = convs.create({ userId, agent: 'claude', title: 'Test' });
let seq = 0;

function message(role: 'user' | 'assistant', at: string, blocks: unknown[], extra: { aborted?: boolean; error?: string } = {}): void {
  run(
    `insert into messages (id, conversation_id, seq, role, blocks, error, aborted, created_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    `m-${seq}`,
    conv.id,
    seq++,
    role,
    JSON.stringify(blocks),
    extra.error ?? null,
    extra.aborted ? 1 : 0,
    at,
  );
}

const text = (t: string) => [{ kind: 'text', blockId: 0, text: t }];

// Sunday 22:00 UTC, twice; Monday 03:00 UTC, once
message('user', '2026-08-23T22:00:00.000Z', text('第一个问题，写得比较长一点点'));
message('assistant', '2026-08-23T22:00:05.000Z', [{ kind: 'text', blockId: 0, text: 'ok' }]);
message('user', '2026-08-23T22:30:00.000Z', text('short'));
message('assistant', '2026-08-23T22:30:05.000Z', [
  { kind: 'thinking', blockId: 0, text: '…' },
  { kind: 'tool_use', blockId: 1, name: 'Read' },
  { kind: 'text', blockId: 2, text: 'done' },
]);
message('user', '2026-08-24T03:00:00.000Z', text('third'));
message('assistant', '2026-08-24T03:00:05.000Z', [{ kind: 'text', blockId: 0, text: '' }], { aborted: true });
message('assistant', '2026-08-24T03:01:00.000Z', [{ kind: 'text', blockId: 0, text: '' }], { error: 'upstream said no' });

const p = profile.of(userId);

console.log('\n=== Scale ===');
{
  ok('one conversation', p.conversations === 1, String(p.conversations));
  ok('every message counted', p.messages === 7, String(p.messages));
  ok('two calendar days', p.activeDays === 2, String(p.activeDays));
  ok('since the first one', p.since === '2026-08-23T22:00:00.000Z', p.since);
}

console.log('\n=== The clock belongs to whoever is reading ===');
{
  ok('a bucket for every hour of the week', p.hourOfWeek.length === 168);
  // Sunday is weekday 0, so 22:00 Sunday UTC is bucket 22 and 03:00 Monday is 24 + 3
  ok('two questions in Sunday 22:00 UTC', p.hourOfWeek[22] === 2, String(p.hourOfWeek[22]));
  ok('one in Monday 03:00 UTC', p.hourOfWeek[27] === 1, String(p.hourOfWeek[27]));
  ok('and nothing anywhere else', p.hourOfWeek.reduce((a, b) => a + b, 0) === 3);

  // What the browser does with them: at +08:00 those are Monday 06:00 and Monday 11:00,
  // so all three questions fall on a Monday morning rather than being split across two days
  const shifted = rotate(p.hourOfWeek, 8);
  ok('rotated, all three land on one weekday', shifted.byWeekday[1] === 3, JSON.stringify(shifted.byWeekday));
  ok('two of them at 06:00 local', shifted.byHour[6] === 2, String(shifted.byHour[6]));
  ok('one at 11:00 local', shifted.byHour[11] === 1, String(shifted.byHour[11]));

  // And westward, across the other edge of the week
  const west = rotate(p.hourOfWeek, -5);
  ok('a negative offset wraps rather than dropping', west.byHour.reduce((a, b) => a + b, 0) === 3);
  // Monday 03:00 UTC is Sunday 22:00 at -05:00, so the early hours come back a day
  ok('a westward shift pulls Monday back into Sunday', west.byWeekday[0] === 3, JSON.stringify(west.byWeekday));
  ok('at 17:00 and 22:00 local', west.byHour[17] === 2 && west.byHour[22] === 1, JSON.stringify(west.byHour));
}

console.log('\n=== How the turns went ===');
{
  ok('four assistant turns', p.turns === 4, String(p.turns));
  ok('one of them used a tool', p.withTools === 1, String(p.withTools));
  ok('thinking on its own is not tool use', p.withTools === 1);
  ok('one was interrupted', p.aborted === 1, String(p.aborted));
  ok('one failed', p.failed === 1, String(p.failed));
  ok('three questions in the conversation', p.turnsPerConversation === 3, String(p.turnsPerConversation));
}

console.log('\n=== How the questions are written ===');
{
  ok('measured over the questions only', p.sampled === 3, String(p.sampled));
  ok('the median is the middle one', p.askLength === 5, String(p.askLength));
  ok('CJK is detected', p.cjkShare > 0.3 && p.cjkShare < 0.7, String(p.cjkShare));
}

console.log('\n=== What was reached for ===');
{
  ok('the agent is counted', p.agents[0]?.key === 'claude' && p.agents[0].n === 1, JSON.stringify(p.agents));
  ok('nothing is invented when there is no usage row', p.models.length === 0 && p.billedTurns === 0);
}

/** The same rotation the page does, kept here so the two cannot drift apart silently */
function rotate(hourOfWeek: number[], offsetHours: number): { byHour: number[]; byWeekday: number[] } {
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  for (let i = 0; i < 168; i++) {
    const n = hourOfWeek[i] ?? 0;
    if (!n) continue;
    const j = (i + offsetHours + 168) % 168;
    byHour[j % 24]! += n;
    byWeekday[Math.floor(j / 24)]! += n;
  }
  return { byHour, byWeekday };
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

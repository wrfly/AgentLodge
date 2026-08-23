/**
 * What memory has to guarantee.
 *
 * The store is written by two programs — this one and the CLI, which edits the files
 * directly and never calls in here. So the failures that matter are silent: work the agent
 * did that never reaches the history and cannot be undone, an index that still lists a
 * record the user deleted, or a codex rendering that quietly goes stale.
 *
 * Run: npm -w @agentlodge/server run test:memory
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-memory-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const memory = await import('./memory.js');
const workspace = await import('./workspace.js');

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

/** What Claude Code actually writes, copied from a real run */
const AS_CLAUDE_WRITES_IT = `---
name: reply-in-chinese
description: "User wants all replies in Chinese, from 2026-08-23 onward"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 35217db3-c657-4e1b-996c-bf4672f59650
  modified: 2026-08-23T13:58:19.577Z
---

用户要求以后所有回答一律使用中文。

**Why:** 用户在 2026-08-23 明确提出，属于长期偏好而非单次请求。
`;

async function asAgent(userId: string, file: string, text: string): Promise<void> {
  await fsp.mkdir(memory.dir(userId), { recursive: true });
  await fsp.writeFile(path.join(memory.dir(userId), file), text, 'utf8');
}

console.log('\n=== Reading what the CLI wrote ===');
{
  const u = 'user-1';
  await asAgent(u, 'reply-in-chinese.md', AS_CLAUDE_WRITES_IT);
  await asAgent(u, 'MEMORY.md', '# Memory Index\n\n- [一律用中文回答](reply-in-chinese.md) — 所有文字用中文\n');

  const [r] = await memory.list(u);
  ok('the record is found', r !== undefined);
  ok('the title comes from the index', r?.title === '一律用中文回答', r?.title);
  ok('and so does the hook', r?.hook === '所有文字用中文', r?.hook);
  ok('the type comes from the frontmatter', r?.type === 'feedback', r?.type);
  ok('a quoted description is unquoted', Boolean(r?.description.startsWith('User wants all replies')), r?.description);
  ok('the body is everything after it', Boolean(r?.body.startsWith('用户要求')), r?.body.slice(0, 20));
  ok('the index itself is not a record', (await memory.list(u)).length === 1);
}

console.log('\n=== Editing one does not throw away what we do not model ===');
{
  const u = 'user-2';
  await asAgent(u, 'reply-in-chinese.md', AS_CLAUDE_WRITES_IT);
  await memory.save(u, { file: 'reply-in-chinese.md', title: '一律用中文', body: '改过的正文。' });

  const raw = fs.readFileSync(path.join(memory.dir(u), 'reply-in-chinese.md'), 'utf8');
  ok('the session it came from survives', raw.includes('originSessionId: 35217db3'), raw);
  ok('so does its type', raw.includes('type: feedback'));
  ok('the body is the new one', raw.includes('改过的正文。'));
  ok('and the old body is gone', !raw.includes('用户要求以后'));
  ok('modified is stamped forward', !raw.includes('2026-08-23T13:58:19.577Z'));
}

console.log('\n=== The index follows what is actually there ===');
{
  const u = 'user-3';
  await memory.save(u, { title: 'Uses podman', body: 'Deploys with podman.', hook: 'not docker' });
  await memory.save(u, { title: 'Writes Go', body: 'Mostly Go and TypeScript.' });

  let index = fs.readFileSync(path.join(memory.dir(u), 'MEMORY.md'), 'utf8');
  ok('a new record is listed', index.includes('- [Uses podman](uses-podman.md) — not docker'), index);
  ok('both of them are', index.includes('writes-go.md'));

  await memory.remove(u, 'uses-podman.md');
  index = fs.readFileSync(path.join(memory.dir(u), 'MEMORY.md'), 'utf8');
  ok('a deleted one stops being listed', !index.includes('uses-podman'), index);
  ok('and its file is gone', !fs.existsSync(path.join(memory.dir(u), 'uses-podman.md')));

  await memory.save(u, { title: 'Uses podman', body: 'Again.' });
  ok('the name is free to be reused', fs.existsSync(path.join(memory.dir(u), 'uses-podman.md')));
}

console.log('\n=== A title that romanises to nothing still gets a filename ===');
{
  const u = 'user-4';
  const r = await memory.save(u, { title: '作息时间', body: '晚 9 点睡。' });
  ok('it is named, not dropped', r.file.endsWith('.md') && r.file.length > 3, r.file);
  const again = await memory.save(u, { title: '作息时间', body: '另一条。' });
  ok('and a second one does not overwrite the first', again.file !== r.file, `${r.file} / ${again.file}`);
  ok('both are listed', (await memory.list(u)).length === 2);
}

console.log('\n=== The agent writing directly still reaches the history ===');
{
  const u = 'user-5';
  await memory.save(u, { title: 'One', body: 'First.' });

  // A turn happens: the CLI writes a file itself, then the next turn takes a snapshot
  await asAgent(u, 'learned.md', '---\nname: learned\n---\n\nSomething it picked up.\n');
  ok('the change is noticed', await memory.snapshot(u, 'agent'));
  ok('and only once', !(await memory.snapshot(u, 'agent')));
  ok('it shows up as the agent in the history', (await memory.history(u)).some((r) => r.by === 'agent'));

  await memory.undo(u);
  ok('undo takes the file back out', !fs.existsSync(path.join(memory.dir(u), 'learned.md')));
  ok('and leaves what was there before', fs.existsSync(path.join(memory.dir(u), 'one.md')));
}

console.log('\n=== Undo puts back what was deleted ===');
{
  const u = 'user-6';
  await memory.save(u, { title: 'Keep me', body: 'Important.' });
  await memory.remove(u, 'keep-me.md');
  ok('it is gone', (await memory.list(u)).length === 0);

  await memory.undo(u);
  ok('and undo brings it back', (await memory.list(u)).some((r) => r.file === 'keep-me.md'));
}

console.log('\n=== What codex is given ===');
{
  const u = 'user-7';
  await memory.save(u, { title: '作息时间', body: '晚 9 点睡，早 6 点起。' });
  const conv = path.join(box, 'workspaces', u, 'conv-1');
  await memory.linkInto(conv, u);

  ok('the directory is linked in, relative', fs.readlinkSync(path.join(conv, 'memory')) === '../memory');
  ok('and it reaches the records', fs.existsSync(path.join(conv, 'memory', 'MEMORY.md')));

  const rendered = fs.readFileSync(path.join(conv, 'AGENTS.md'), 'utf8');
  ok('AGENTS.md carries the facts, not just a list', rendered.includes('晚 9 点睡，早 6 点起。'), rendered);
  ok('and tells it where to write', rendered.includes('./memory/'));

  // A record added after the link was made must reach codex on the next turn
  await memory.save(u, { title: 'Later', body: 'Added afterwards.' });
  await memory.linkInto(conv, u);
  ok('a later record is rendered too', fs.readFileSync(path.join(conv, 'AGENTS.md'), 'utf8').includes('Added afterwards.'));

  const listed = (await workspace.list(u, 'conv-1')).map((e) => e.name);
  ok('the linked directory stays out of the file browser', !listed.includes('memory'), JSON.stringify(listed));
}

console.log('\n=== A directory the user made is not replaced by the link ===');
{
  const u = 'user-8';
  await memory.save(u, { title: 'X', body: 'Y.' });
  const conv = path.join(box, 'workspaces', u, 'conv-2');
  fs.mkdirSync(path.join(conv, 'memory'), { recursive: true });
  fs.writeFileSync(path.join(conv, 'memory', 'notes.txt'), 'mine\n');
  await memory.linkInto(conv, u);

  ok('theirs is left alone', fs.readFileSync(path.join(conv, 'memory', 'notes.txt'), 'utf8') === 'mine\n');
}

console.log('\n=== Nothing shadows the memory from above ===');
{
  const u = 'user-9';
  const home = path.join(box, 'workspaces', u);
  fs.mkdirSync(home, { recursive: true });
  for (const n of ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md']) fs.writeFileSync(path.join(home, n), 'stale\n');
  await memory.tidy(u);
  ok('all of them are cleared', ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md'].every((n) => !fs.existsSync(path.join(home, n))));
  ok('the memory directory is untouched', memory.dir(u).endsWith(path.join(u, 'memory')));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

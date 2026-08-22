/**
 * Escaping the workspace.
 *
 * The workspace is a bind mount the agent container writes to, and an agent does what its
 * prompt tells it — including `ln -s /data/agentlodge.db notes.txt`. A symlink is a string
 * resolved by whoever follows it, and here that is **app**, in its own filesystem, where
 * that path is the database holding every user's conversations and the encrypted upstream
 * keys. Lexical `..` checking passes such a path without hesitation.
 *
 * These tests run against a real temporary directory with real symlinks, because the whole
 * question is what the filesystem does, and a mock would only tell us what we already think.
 *
 * Run: npm -w @agentlodge/server run test:workspace
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentlodge-ws-'));
process.env.DATA_DIR = dataDir;
process.env.JWT_SECRET = 'test-secret-for-workspace-tests';

const { resolveInside, preview, list, remove, O_WRITE_NOFOLLOW } = await import('./workspace.js');

const USER = 'u1';
const CONV = 'c1';
const ws = path.join(dataDir, 'workspaces', USER, CONV);
const outside = path.join(dataDir, 'not-the-workspace');

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

await fs.mkdir(ws, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.mkdir(path.join(ws, 'sub'), { recursive: true });
await fs.writeFile(path.join(outside, 'secrets.db'), 'EVERY USER\'S DATA');
await fs.writeFile(path.join(ws, 'report.md'), 'a real file in the workspace');
await fs.symlink(path.join(outside, 'secrets.db'), path.join(ws, 'notes.txt'));
await fs.symlink(outside, path.join(ws, 'linkdir'));
await fs.symlink(path.join(ws, 'report.md'), path.join(ws, 'inside-link.md'));
await fs.symlink('/nowhere/at/all', path.join(ws, 'dangling.txt'));

console.log('\n=== Ordinary paths still work ===');
ok('a real file resolves', (await resolveInside(USER, CONV, 'report.md')) !== null);
ok('a file in a subdirectory resolves', (await resolveInside(USER, CONV, 'sub/x.txt')) !== null);
ok(
  'a file that does not exist yet resolves (upload destinations do not)',
  (await resolveInside(USER, CONV, 'brand-new.txt')) !== null,
);
ok(
  'a symlink that stays inside is allowed',
  (await resolveInside(USER, CONV, 'inside-link.md')) !== null,
);
ok('reading a real file works', (await preview(USER, CONV, 'report.md'))?.content?.includes('a real file') === true);

console.log('\n=== Lexical escapes ===');
for (const bad of ['../../../etc/passwd', '..', 'sub/../../..', '/etc/passwd']) {
  ok(`refused: ${bad}`, (await resolveInside(USER, CONV, bad)) === null);
}

console.log('\n=== Symlink escapes ===');
ok(
  'a symlink to a file outside is refused',
  (await resolveInside(USER, CONV, 'notes.txt')) === null,
);
ok(
  'a path through a symlinked directory is refused',
  (await resolveInside(USER, CONV, 'linkdir/secrets.db')) === null,
);
ok(
  'a not-yet-existing file under a symlinked directory is refused',
  (await resolveInside(USER, CONV, 'linkdir/new.txt')) === null,
);
ok('preview cannot read through a symlink', (await preview(USER, CONV, 'notes.txt')) === null);
ok(
  'preview cannot read through a symlinked directory',
  (await preview(USER, CONV, 'linkdir/secrets.db')) === null,
);
ok(
  'the outside file is still there, so the refusal was not a deletion',
  (await fs.readFile(path.join(outside, 'secrets.db'), 'utf8')) === "EVERY USER'S DATA",
);

console.log('\n=== The listing ===');
const names = (await list(USER, CONV)).map((f) => f.path);
ok('a real file is listed', names.includes('report.md'));
ok('a symlink pointing outside is not listed', !names.includes('notes.txt'), names.join(', '));
ok('a symlinked directory pointing outside is not listed', !names.includes('linkdir'));
ok('a dangling symlink is not listed', !names.includes('dangling.txt'));
ok('a symlink that stays inside is listed', names.includes('inside-link.md'), names.join(', '));

console.log('\n=== Writing ===');
// The attack: the agent leaves a symlink where the upload is about to land
const dest = await resolveInside(USER, CONV, 'notes.txt');
ok('an upload cannot resolve onto an escaping symlink', dest === null);
// And even holding the path, the open itself refuses to follow it
let opened = true;
try {
  const h = await fs.open(path.join(ws, 'notes.txt'), O_WRITE_NOFOLLOW);
  await h.close();
} catch {
  opened = false;
}
ok('O_NOFOLLOW refuses the open outright, closing the race', !opened);
ok(
  'the file it pointed at is untouched',
  (await fs.readFile(path.join(outside, 'secrets.db'), 'utf8')) === "EVERY USER'S DATA",
);

console.log('\n=== Deleting ===');
ok('a bad symlink can still be removed from your own workspace', await remove(USER, CONV, 'notes.txt'));
ok(
  'and removing it unlinked the symlink, not the file it pointed at',
  (await fs.readFile(path.join(outside, 'secrets.db'), 'utf8')) === "EVERY USER'S DATA",
);
ok('deleting outside the workspace is still refused', !(await remove(USER, CONV, '../../../etc/hosts')));

await fs.rm(dataDir, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

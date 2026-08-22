/**
 * The edges of reading a key file.
 *
 * The escape cases matter most: the path is admin input, and whatever is read goes out as
 * Authorization to an upstream address that is also admin input. A broken allowlist means
 * any file in the container can be shipped outside.
 *
 * Run: npm -w @agentlodge/server run test:secret-file
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config reads the environment at module load, so set the allowlist before the dynamic import
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-secret-')));
const root = path.join(box, 'secrets');
const outside = path.join(box, 'outside');
fs.mkdirSync(root);
fs.mkdirSync(outside);

process.env.SECRET_FILE_ROOTS = root;
const { readSecretFile, listCandidates } = await import('./secret-file.js');

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? `  —— ${detail}` : ''}`);
  }
}

/** Expect a successful read whose value is exactly `expected` */
function expectValue(label: string, input: string, expected: string): void {
  const r = readSecretFile(input);
  if ('error' in r) return ok(label, false, `it errored: ${r.error}`);
  ok(label, r.value === expected, `read ${JSON.stringify(r.value)}`);
}

/** Expect a failure, with code `path` (refused on save) or `io` (a warning only) */
function expectError(label: string, input: string, code: 'path' | 'io'): void {
  const r = readSecretFile(input);
  if (!('error' in r)) return ok(label, false, 'it read successfully, which it should not have');
  ok(`${label} → ${r.error}`, r.code === code, `code=${r.code}, expected ${code}`);
}

const write = (p: string, body: string): string => {
  fs.writeFileSync(p, body);
  return p;
};

console.log('=== Ordinary reads ===');
expectValue('a plain file', write(path.join(root, 'plain.key'), 'sk-plain-1234'), 'sk-plain-1234');
expectValue(
  'the trailing newline `echo key > f` leaves is removed',
  write(path.join(root, 'echoed.key'), 'sk-echoed-1234\n'),
  'sk-echoed-1234',
);
expectValue(
  'surrounding whitespace and a BOM are removed',
  write(path.join(root, 'bom.key'), '﻿  sk-bom-1234 \n'),
  'sk-bom-1234',
);
expectValue(
  'a subdirectory is readable too — another container lays things out its own way',
  (fs.mkdirSync(path.join(root, 'vault')), write(path.join(root, 'vault/nested.key'), 'sk-nested')),
  'sk-nested',
);
expectValue('`.` and `//` in a path normalise back inside the allowlist', `${root}/./plain.key`, 'sk-plain-1234');

console.log('\n=== Escapes — a failure here is a vulnerability ===');
write(path.join(outside, 'stolen.txt'), 'top-secret');
expectError('an absolute path outside the allowlist', path.join(outside, 'stolen.txt'), 'path');
expectError('climbing out with ..', path.join(root, '..', 'outside', 'stolen.txt'), 'path');
expectError('a relative path', 'secrets/plain.key', 'path');
fs.symlinkSync(path.join(outside, 'stolen.txt'), path.join(root, 'link.key'));
expectError('a symlink inside the allowlist pointing out of it', path.join(root, 'link.key'), 'path');

console.log('\n=== Ways there is no key to read ===');
expectError('missing', path.join(root, 'nope.key'), 'io');
expectError('a directory', path.join(root, 'vault'), 'io');
expectError('an empty file', write(path.join(root, 'empty.key'), '\n  \n'), 'io');
expectError(
  'several lines — most likely a JSON credentials file by mistake',
  write(path.join(root, 'creds.json'), '{\n  "token": "x"\n}\n'),
  'io',
);
expectError('too large, as when it points at the database', write(path.join(root, 'big.bin'), 'x'.repeat(20 * 1024)), 'io');
expectError('an empty path', '', 'path');

console.log('\n=== Listing ===');
write(path.join(root, '.hidden.key'), 'sk-hidden');
const listed = listCandidates();
const paths = listed.files.map((f) => f.path);
ok('the allowlisted root itself is listed', listed.roots.some((r) => r.path === root && r.exists));
ok('a readable file is in the list', paths.includes(path.join(root, 'plain.key')));
ok('so is one in a subdirectory', paths.includes(path.join(root, 'vault/nested.key')));
ok('dotfiles are skipped, .proxy-config.json among them', !paths.includes(path.join(root, '.hidden.key')));
ok(
  'an unreadable one is listed with its reason, or it looks like the file vanished',
  listed.files.some((f) => f.path === path.join(root, 'creds.json') && 'error' in f),
);

console.log('\n=== Rotation: change the contents and the next read has them ===');
const rotating = path.join(root, 'rotating.key');
write(rotating, 'sk-old');
const before = readSecretFile(rotating);
write(rotating, 'sk-new');
const after = readSecretFile(rotating);
ok(
  'the same path read twice gives different values — nothing is cached',
  !('error' in before) && !('error' in after) && before.value === 'sk-old' && after.value === 'sk-new',
);
ok(
  'the fingerprint changes with it, which is how the console confirms the server sees the new one',
  !('error' in before) && !('error' in after) && before.file.fingerprint !== after.file.fingerprint,
);

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

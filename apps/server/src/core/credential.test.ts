/**
 * Parsing a credential that rides in the URL path.
 *
 * Every failure here is hard to trace. Strip too much and a real path is eaten — a 404
 * that reads as an unregistered route. Strip too little and the credential leaks into the
 * routing table and the logs. Restore the prefix wrongly and everything is a 401 while the
 * credential was fine all along.
 *
 * Run: npm -w @agentlodge/server run test:credential
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config reads the environment at module load, so set it before a dynamic import
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-cred-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret-value';

const { splitPathCredential, resolve } = await import('./credential.js');
const { initDb, run } = await import('./db/index.js');
const apiKeys = await import('./db/api-keys.js');
initDb();

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

function eq(label: string, url: string, token: string | undefined, rest: string): void {
  const r = splitPathCredential(url);
  ok(label, r.token === token && r.rest === rest, `got token=${r.token} rest=${r.rest}`);
}

console.log('\n=== Requests without the prefix pass through untouched ===');
eq('the path agent containers already use', '/v1/messages', undefined, '/v1/messages');
eq('the health probe', '/api/hello', undefined, '/api/hello');
eq('the root path', '/', undefined, '/');
eq('looks similar but is not', '/user/profile', undefined, '/user/profile');

console.log('\n=== Strip the prefix, put al_ back ===');
eq('the string with its prefix removed', '/u/AbC-123_xyz/v1/messages', 'al_AbC-123_xyz', '/v1/messages');
eq('the query survives', '/u/AbC/v1/messages?beta=true', 'al_AbC', '/v1/messages?beta=true');
eq('the health probe goes through it too', '/u/AbC/api/hello', 'al_AbC', '/api/hello');
eq('a full key is accepted too, without doubling the prefix', '/u/al_AbC/v1/messages', 'al_AbC', '/v1/messages');
eq('anything JWT-shaped is handed on untouched', '/u/a.b.c/v1/messages', 'a.b.c', '/v1/messages');
eq('percent-encoding is decoded', '/u/A%2DB/v1/messages', 'al_A-B', '/v1/messages');

console.log('\n=== Shapes that are refused ===');
eq('a credential with no path', '/u/AbC', undefined, '/u/AbC');
eq('an empty credential segment', '/u//v1/messages', undefined, '/u//v1/messages');
eq('the prefix alone', '/u/', undefined, '/u/');
eq('broken percent-encoding', '/u/%E0%A4%A/v1/messages', undefined, '/u/%E0%A4%A/v1/messages');

console.log('\n=== The credential never leaks into rest ===');
{
  const r = splitPathCredential('/u/SECRETVALUE/v1/messages?beta=true');
  ok('the stripped URL does not contain the credential', !r.rest.includes('SECRETVALUE'), r.rest);
}

console.log('\n=== End to end: the prefix-less segment verifies back to the real key ===');
{
  const userId = 'u-test';
  run(
    `insert into users (id, email, username, password_hash, role, status, created_at)
     values (?, ?, ?, ?, 'user', 'active', ?)`,
    userId, 'x@example.com', 'x', 'x', '2026-01-01',
  );
  const { plaintext } = apiKeys.create(userId, 'test');

  // The URL a user actually copies: the credential, minus its al_ prefix, in the path
  const url = `/u/${plaintext.replace(/^al_/, '')}/v1/messages?beta=true`;
  const split = splitPathCredential(url);

  ok('what is restored is the original key', split.token === plaintext, String(split.token));
  ok('the remaining path is clean', split.rest === '/v1/messages?beta=true', split.rest);

  const who = await resolve(split.token, 'anthropic');
  ok('it resolves to a Principal', who !== null);
  ok('attributed to the right user', who?.sub === userId, String(who?.sub));
  ok('recognised as an api-key credential', who?.kind === 'api-key', String(who?.kind));

  // Revoking kills that URL immediately
  const listed = apiKeys.list(userId)[0]!;
  apiKeys.revoke(listed.id, userId);
  ok('the same URL stops working once revoked', (await resolve(split.token, 'anthropic')) === null);
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Deciding whether the API Key field holds a key or a path, and what gets stored.
 *
 * Worth testing on its own because both ways of getting it wrong are hard to trace.
 *   A path read as a key   → that path goes out verbatim in the Authorization header and
 *                            comes back a 401, while the console says "key configured"
 *                            and nothing looks wrong.
 *   A key read as a path   → the database holds a path that does not exist. Also a 401.
 * Plus the rule that respecifying the source clears the other column: with both columns
 * populated, what the interface shows and what goes on the wire are two different things.
 *
 * Run: npm -w @agentlodge/server run test:providers
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// config reads the environment at module load, so set these before the dynamic import
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-providers-')));
const secrets = path.join(box, 'secrets');
fs.mkdirSync(secrets);
const keyFile = path.join(secrets, 'upstream.key');
fs.writeFileSync(keyFile, 'sk-from-file\n');

process.env.DATA_DIR = box;
process.env.SECRET_FILE_ROOTS = secrets;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb, get } = await import('./index.js');
initDb();
const { create, update, secretOf, looksLikePath } = await import('./providers.js');

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

/** The two columns as stored — where getting the decision right or wrong finally shows */
function cols(id: string): { key: string | null; file: string | null } {
  const r = get<{ api_key: string | null; api_key_file: string | null }>(
    'select api_key, api_key_file from upstream_providers where id = ?',
    id,
  );
  return { key: r?.api_key ?? null, file: r?.api_key_file ?? null };
}

const mk = (apiKey?: string, apiKeyFile?: string): string =>
  create({ name: 'test', kind: 'openai-chat', baseUrl: 'https://x.example', apiKey, apiKeyFile }).id;

console.log('\n=== The rule ===');
ok('a leading / is a path', looksLikePath('/data/secrets/authkey/auth.key'));
ok('leading whitespace is still recognised', looksLikePath('  /data/secrets/auth.key'));
ok('sk- is a key', !looksLikePath('sk-ant-oat01-abcdef'));
ok('a slash inside a key is not a path — base64 is full of them', !looksLikePath('abc/def+ghi='));
ok('a relative path is not one either — secret-file only ever accepted absolute paths', !looksLikePath('./secrets/auth.key'));
ok('~ is not one: nothing expands it inside a container', !looksLikePath('~/.claude/auth.key'));
ok('the empty string is not one', !looksLikePath(''));

console.log('\n=== Which column it lands in ===');
{
  const id = mk('sk-literal-key');
  const c = cols(id);
  ok('a literal key goes into api_key, encrypted', Boolean(c.key) && c.key !== 'sk-literal-key');
  ok('a literal key does not write api_key_file', c.file === null, String(c.file));
  ok('secretOf returns the original', secretOf(id) === 'sk-literal-key', String(secretOf(id)));
}
{
  const id = mk(keyFile);
  const c = cols(id);
  ok('a path goes into api_key_file', c.file === keyFile, String(c.file));
  ok('a path does not go into api_key, or it would be sent as one', c.key === null, String(c.key));
  ok('secretOf reads the file contents, trimmed', secretOf(id) === 'sk-from-file', String(secretOf(id)));
}
{
  const id = mk(`  ${keyFile}  `);
  ok('whitespace around a path is trimmed', cols(id).file === keyFile, String(cols(id).file));
}
{
  const id = mk(undefined, keyFile);
  const c = cols(id);
  ok('an explicit apiKeyFile still works', c.file === keyFile && c.key === null);
}

console.log('\n=== Respecifying the source clears the other column ===');
{
  const id = mk('sk-literal-key');
  update(id, { apiKey: keyFile });
  const c = cols(id);
  ok('key to path: api_key is cleared', c.key === null, String(c.key));
  ok('key to path: api_key_file holds the new path', c.file === keyFile);

  update(id, { apiKey: 'sk-back-to-literal' });
  const c2 = cols(id);
  ok('path to key: api_key_file is cleared', c2.file === null, String(c2.file));
  ok('path to key: secretOf returns the new key', secretOf(id) === 'sk-back-to-literal');
}

console.log('\n=== Leaving it alone, and clearing it ===');
{
  const id = mk('sk-literal-key');
  update(id, { name: 'renamed' });
  ok('no key in the patch leaves both columns alone', cols(id).key !== null && secretOf(id) === 'sk-literal-key');

  update(id, { apiKey: '' });
  const c = cols(id);
  ok('an empty string clears both columns', c.key === null && c.file === null);
  ok('once cleared, secretOf is undefined', secretOf(id) === undefined);
}
{
  const id = mk('sk-literal-key');
  update(id, { apiKey: '   ' });
  const c = cols(id);
  ok('whitespace clears it too — this used to store a key made of spaces', c.key === null && c.file === null);
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * Where a provider's credential lives, and what happens to the ones stored the old way.
 *
 * Two things are worth testing here. The first is that `credential_id` is a reference and
 * only a reference: what goes upstream is whatever the credential manager answers at that
 * moment, never something cached in this process or written into the row.
 *
 * The second is the migration. A database that predates the credential manager holds keys
 * in `api_key` (encrypted) and `api_key_file` (a path), and a deployment depends on them.
 * Moving those into another service and then dropping the columns is the one operation
 * here that can destroy something, so it is exercised end to end: with the manager
 * reachable, and with it absent.
 *
 * Run: npm -w @agentlodge/server run test:providers
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

// config reads the environment at module load, so set these before the dynamic import
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-providers-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

/**
 * A stand-in for the credential manager, recording what it is asked to keep. Nothing here
 * pretends to be the real store — what matters is what crosses the socket.
 */
const managerSocket = path.join(box, 'credential-manager.sock');
process.env.CREDENTIAL_MANAGER_SOCKET = managerSocket;

const stored = new Map<string, { kind: string; value: string; label?: string }>();
let tokenCalls = 0;
let managerReachable = true;

const manager = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://unix');
  const json = (code: number, body: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (!managerReachable) {
    json(503, { error: 'not today' });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/credentials') {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c: string) => (raw += c));
    req.on('end', () => {
      const b = JSON.parse(raw) as { id: string; kind: string; apiKey?: string; path?: string; label?: string };
      stored.set(b.id, { kind: b.kind, value: b.apiKey ?? b.path ?? '', label: b.label });
      json(200, { credential: { id: b.id, kind: b.kind, ready: true, hint: 'sk-…', source: 'typed' } });
    });
    return;
  }
  if (url.pathname === '/token') {
    tokenCalls++;
    const id = url.searchParams.get('credential') ?? '';
    const held = stored.get(id);
    if (!held) {
      json(404, { error: `no such credential: ${id}` });
      return;
    }
    // A key file answers with the file's contents; that read happens in the manager, and
    // for this test the stored path stands in for it
    json(200, { credential: id, accessToken: held.kind === 'key-file' ? `from:${held.value}` : held.value });
    return;
  }
  json(404, { error: 'nope' });
});
await new Promise<void>((resolve) => manager.listen(managerSocket, resolve));

const { initDb, get, getDb, columns, run } = await import('./index.js');
initDb();
const { create, update, secretOf } = await import('./providers.js');
const { encrypt } = await import('./settings.js');
const { drainLegacyProviderKeys } = await import('../../gateway/legacy-keys.js');

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

const mk = (credentialId?: string): string =>
  create({ name: 'test', kind: 'openai-chat', baseUrl: 'https://x.example', credentialId }).id;

const credentialOf = (id: string): string | null =>
  get<{ credential_id: string | null }>('select credential_id from upstream_providers where id = ?', id)
    ?.credential_id ?? null;

console.log('\n=== A provider names a credential, and holds nothing ===');
{
  stored.set('paid', { kind: 'api-key', value: 'sk-ant-api03-real' });
  const id = mk('paid');
  ok('the id is what is stored', credentialOf(id) === 'paid', String(credentialOf(id)));

  const before = tokenCalls;
  ok('secretOf returns what the manager answers', (await secretOf(id)) === 'sk-ant-api03-real');
  ok('which took a call — nothing is cached here', tokenCalls === before + 1, `calls: ${tokenCalls - before}`);

  // What the manager holds can change under us; the next request must see the new value
  stored.set('paid', { kind: 'api-key', value: 'sk-ant-api03-rotated' });
  ok('a rotated value is picked up on the next call', (await secretOf(id)) === 'sk-ant-api03-rotated');
}
{
  const id = mk('gone');
  ok('an id the manager does not have reads as no key', (await secretOf(id)) === undefined);
}
{
  const id = mk();
  ok('no credential at all reads as no key', (await secretOf(id)) === undefined);

  update(id, { name: 'renamed' });
  ok('a patch without one leaves the column alone', credentialOf(id) === null);

  update(id, { credentialId: 'paid' });
  ok('naming one sets it', credentialOf(id) === 'paid');

  update(id, { credentialId: '' });
  ok('an empty string clears it', credentialOf(id) === null);
}

console.log('\n=== Draining a database from before the credential manager ===');
{
  // The shape an old database has: two columns this build no longer creates
  const db = getDb();
  db.exec('alter table upstream_providers add column api_key text');
  db.exec('alter table upstream_providers add column api_key_file text');
  for (const p of (await import('./providers.js')).list()) {
    run('delete from upstream_providers where id = ?', p.id);
  }

  const inline = mk();
  const file = mk();
  run('update upstream_providers set name = ?, api_key = ? where id = ?', 'DeepSeek prod', encrypt('sk-deepseek-legacy'), inline);
  run('update upstream_providers set name = ?, api_key_file = ?, active = 1 where id = ?', 'Vault fed', '/run/secrets/upstream.key', file);

  const logs: string[] = [];

  // First, with nothing to talk to: the values have to survive
  managerReachable = false;
  await drainLegacyProviderKeys((m) => logs.push(m));
  ok('an unreachable manager destroys nothing', credentialOf(inline) === null && columns(db, 'upstream_providers').has('api_key'));
  ok('and it says which upstream it could not move', logs.some((l) => l.includes('DeepSeek prod')), logs.join(' | '));

  managerReachable = true;
  logs.length = 0;
  await drainLegacyProviderKeys((m) => logs.push(m));

  ok('the encrypted key moved, decrypted', stored.get('deepseek-prod')?.value === 'sk-deepseek-legacy', JSON.stringify(stored.get('deepseek-prod')));
  ok('the path moved as a path, not as a value', stored.get('vault-fed')?.kind === 'key-file' && stored.get('vault-fed')?.value === '/run/secrets/upstream.key');
  ok('each provider now names its credential', credentialOf(inline) === 'deepseek-prod' && credentialOf(file) === 'vault-fed');
  ok('and the columns are gone', !columns(db, 'upstream_providers').has('api_key') && !columns(db, 'upstream_providers').has('api_key_file'));
  ok('the provider that used a file now resolves through the manager', (await secretOf(file)) === 'from:/run/secrets/upstream.key');

  // Running it again on the drained database must be a no-op rather than an error
  logs.length = 0;
  await drainLegacyProviderKeys((m) => logs.push(m));
  ok('a second run does nothing', logs.length === 0, logs.join(' | '));
}

manager.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

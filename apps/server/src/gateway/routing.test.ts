/**
 * Which upstream a request goes to.
 *
 * The model decides. That is the whole change: a name selects a row, the row names a
 * provider, and two upstreams offering the same model are two rows ordered by priority.
 * What has to hold:
 *
 *   - an exact name routes to its own provider, not to whichever was configured first
 *   - the lowest priority among rows sharing a name wins, and a disabled row is not a
 *     candidate at all
 *   - a name nobody configured still goes somewhere, forwarded as the client wrote it —
 *     CLIs send aliases like `sonnet` that no model list contains
 *   - an upstream that calls the model something else gets its own name in the body
 *
 * Run: npm -w @agentlodge/server run test:routing
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-routing-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

// The gateway asks the credential manager for a key before it can answer at all
const managerSocket = path.join(box, 'credential-manager.sock');
process.env.CREDENTIAL_MANAGER_SOCKET = managerSocket;
const manager = http.createServer((req, res) => {
  const id = new URL(req.url ?? '/', 'http://unix').searchParams.get('credential') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ credential: id, accessToken: `sk-${id}` }));
});
await new Promise<void>((resolve) => manager.listen(managerSocket, resolve));

const { initDb } = await import('../core/db/index.js');
initDb();
const providers = await import('../core/db/providers.js');
const models = await import('../core/db/models.js');
const { resolveUpstream } = await import('./upstream.js');

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

for (const p of providers.list()) providers.remove(p.id);

const cheap = providers.create({
  name: 'Reseller A', kind: 'anthropic-native', baseUrl: 'https://a.example/anthropic', credentialId: 'key-a',
});
const dear = providers.create({
  name: 'Reseller B', kind: 'openai-chat', baseUrl: 'https://b.example/v1', credentialId: 'key-b',
});

console.log('\n=== One name, one upstream ===');
{
  models.create({ name: 'claude-opus-5', providerId: cheap.id });
  const target = await resolveUpstream('anthropic', '/v1/messages', 'claude-opus-5');
  ok('goes to the provider its row names', target?.provider.id === cheap.id, target?.provider.name);
  ok('with that provider\'s credential', target?.apiKey === 'sk-key-a', target?.apiKey);
  ok('and no rewrite of the model', target?.upstreamModel === undefined, String(target?.upstreamModel));
}

console.log('\n=== One name, two upstreams ===');
{
  // Both offer it; A was configured first, B is cheaper and says so with a lower priority
  models.create({ name: 'deepseek-v4-pro', providerId: cheap.id, priority: 10 });
  const preferred = models.create({ name: 'deepseek-v4-pro', providerId: dear.id, priority: 1 });

  const target = await resolveUpstream('anthropic', '/v1/messages', 'deepseek-v4-pro');
  ok('the lowest priority wins', target?.provider.id === dear.id, target?.provider.name);
  ok('and its protocol comes with it', target?.wire === 'chat' && target?.translate === true, `${target?.wire}/${target?.translate}`);

  models.update(preferred.id, { enabled: false });
  const next = await resolveUpstream('anthropic', '/v1/messages', 'deepseek-v4-pro');
  ok('turning it off falls to the other row', next?.provider.id === cheap.id, next?.provider.name);
  ok('and not to a disabled one', next?.provider.id !== dear.id);
}

console.log('\n=== A name nobody configured ===');
{
  const target = await resolveUpstream('anthropic', '/v1/messages', 'sonnet');
  ok('still resolves, so an alias does not 503', Boolean(target));
  ok('and is forwarded as written, not renamed', target?.upstreamModel === undefined, String(target?.upstreamModel));

  const none = await resolveUpstream('anthropic', '/v1/messages');
  ok('so does a request with no model at all', Boolean(none));
}

console.log('\n=== An upstream that calls it something else ===');
{
  models.create({ name: 'deepseek-v4-flash', providerId: cheap.id, upstreamName: 'deepseek-chat' });
  const target = await resolveUpstream('anthropic', '/v1/messages', 'deepseek-v4-flash');
  ok('the body gets the upstream\'s own name', target?.upstreamModel === 'deepseek-chat', String(target?.upstreamModel));
}

console.log('\n=== Nothing configured ===');
{
  for (const m of models.list()) models.remove(m.id);
  const target = await resolveUpstream('anthropic', '/v1/messages', 'claude-opus-5');
  ok('is not routed anywhere', target === undefined);
}

manager.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

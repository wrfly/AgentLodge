/**
 * The hourly model refresh.
 *
 * What has to hold: the switch is read every time (flipping it must not need a restart), an
 * upstream that cannot answer leaves the list alone rather than emptying a working picker,
 * and an unchanged list is not rewritten — otherwise every provider's updated_at moves once
 * an hour and the audit log fills with changes that changed nothing.
 *
 * Run: npm -w @agentlodge/server run test:model-refresh
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// Type-only, so it does not execute the module before the environment is set below
import type { Provider } from '../core/db/providers.js';

// config reads the environment at module load, so set these before the dynamic import
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-refresh-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

// A stand-in for the credential manager: the refresher asks it for the key the same way a
// request on its way upstream does
const managerSocket = path.join(box, 'credential-manager.sock');
process.env.CREDENTIAL_MANAGER_SOCKET = managerSocket;
const manager = http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ credential: 'lab-key', accessToken: 'sk-lab-key' }));
});
await new Promise<void>((resolve) => manager.listen(managerSocket, resolve));

const { initDb } = await import('../core/db/index.js');
initDb();
const providers = await import('../core/db/providers.js');
const modelsRepo = await import('../core/db/models.js');
const settings = await import('../core/db/settings.js');
const audit = await import('../core/db/audit.js');
const { refreshOnce } = await import('./model-refresh.js');

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

const logs: string[] = [];
const log = (m: string): void => void logs.push(m);
const direct = () => (url: string) => ({ url, headers: {} });

/** Answers the model list request with whatever the case needs */
function upstream(answer: { status?: number; ids?: string[] }): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ data: (answer.ids ?? []).map((id) => ({ id })) }), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

/** One upstream with the given models configured against it */
function reset(names: string[]): Provider {
  for (const p of providers.list()) providers.remove(p.id);
  const p = providers.create({
    name: 'lab', kind: 'anthropic-native', baseUrl: 'https://api.example.com',
    credentialId: 'lab-key',
  });
  modelsRepo.addMissing(p.id, names);
  logs.length = 0;
  return providers.findById(p.id)!;
}

/** The names configured against a provider, in the order the picker shows them */
const configured = (id: string): string[] =>
  modelsRepo.list().filter((m) => m.providerId === id).map((m) => m.name);

const auditCount = (): number => audit.list(1000).length;

console.log('\n=== The switch ===');
{
  const p = reset(['old-1']);
  settings.setSetting('agents.autoRefreshModels', 'false');
  const restore = upstream({ ids: ['new-2'] });
  await refreshOnce(direct, log);
  restore();
  ok('off means nothing is added', configured(p.id).join(',') === 'old-1', configured(p.id).join(','));
  ok('and nothing is said about it', logs.length === 0, logs.join('|'));
}
{
  const p = reset(['old-1']);
  settings.setSetting('agents.autoRefreshModels', 'true');
  const restore = upstream({ ids: ['claude-opus-5', 'claude-sonnet-5'] });
  await refreshOnce(direct, log);
  restore();
  const have = new Set(configured(p.id));
  ok('what the upstream offers is added', have.has('claude-opus-5') && have.has('claude-sonnet-5'), [...have].join(','));
  ok('and what was configured by hand survives it', have.has('old-1'), [...have].join(','));
  ok('it says how many are new', logs.some((l) => l.includes('2 new model(s)')), logs.join('|'));
}
{
  // Read fresh every pass, so flipping it in the console takes effect without a restart
  const p = reset(['old-1']);
  settings.setSetting('agents.autoRefreshModels', 'true');
  let restore = upstream({ ids: ['a'] });
  await refreshOnce(direct, log);
  restore();
  settings.setSetting('agents.autoRefreshModels', 'false');
  restore = upstream({ ids: ['b'] });
  await refreshOnce(direct, log);
  restore();
  const have = new Set(configured(p.id));
  ok('turning it off stops the next pass', have.has('a') && !have.has('b'), [...have].join(','));
}

console.log('\n=== An upstream that cannot answer ===');
{
  const p = reset(['keep-me']);
  settings.setSetting('agents.autoRefreshModels', 'true');
  const before = auditCount();
  const restore = upstream({ status: 404 });
  await refreshOnce(direct, log);
  restore();
  ok('a 404 leaves the list alone', configured(p.id).join(',') === 'keep-me');
  ok('nothing is written to the audit log', auditCount() === before);
  ok('but it is logged', logs.some((l) => l.includes('model refresh:')), logs.join('|'));
}
{
  const p = reset(['keep-me']);
  const restore = upstream({ ids: [] });
  await refreshOnce(direct, log);
  restore();
  ok('an empty list is not an answer either', configured(p.id).join(',') === 'keep-me');
}

console.log('\n=== Nothing new ===');
{
  const p = reset(['a', 'b']);
  settings.setSetting('agents.autoRefreshModels', 'true');
  const before = auditCount();
  const restore = upstream({ ids: ['a', 'b'] });
  await refreshOnce(direct, log);
  restore();
  ok('adds nothing', configured(p.id).join(',') === 'a,b', configured(p.id).join(','));
  ok('and produces no audit entry', auditCount() === before);
  ok('and says nothing', logs.length === 0, logs.join('|'));
}

manager.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

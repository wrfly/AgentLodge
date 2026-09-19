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
const { resolveUpstream, requestedModel } = await import('./upstream.js');

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

  // A name that would win the fallback if the suffix were treated as unknown
  models.create({ name: 'aaa-first', providerId: dear.id });
  const windowed = await resolveUpstream('anthropic', '/v1/messages', 'claude-opus-5[1m]');
  ok('a Claude Code window suffix still finds that row', windowed?.provider.id === cheap.id, windowed?.provider.name);
  ok('and is forwarded as written, so the window is not dropped', windowed?.upstreamModel === undefined, String(windowed?.upstreamModel));
  ok(
    'GET /v1/models advertises the window form Claude Code will look up',
    models.advertisedNames().includes('claude-opus-5[1m]'),
    models.advertisedNames().join(','),
  );

  models.create({ name: 'claude-haiku-4-5', providerId: cheap.id });
  const dated = await resolveUpstream('anthropic', '/v1/messages', 'claude-haiku-4-5-20251001');
  ok('a dated Anthropic snapshot still finds the undated row', dated?.provider.id === cheap.id, dated?.provider.name);
  ok('and is forwarded as written, so the date is not dropped', dated?.upstreamModel === undefined, String(dated?.upstreamModel));

  const thinking = await resolveUpstream('anthropic', '/v1/messages', 'claude-opus-5-thinking-high');
  ok(
    'a Cursor effort/thinking slug finds the model it is a variant of',
    thinking?.provider.id === cheap.id,
    thinking?.provider.name,
  );
  ok(
    'and is forwarded as written, so the catalogue can still resolve it',
    thinking?.upstreamModel === undefined,
    String(thinking?.upstreamModel),
  );
  ok(
    'the picker does not offer the slug',
    !models.names().includes('claude-opus-5-thinking-high') && models.names().includes('claude-opus-5'),
    models.names().join(','),
  );
}

console.log('\n=== Effort and thinking are not models ===');
{
  ok('high is stripped', models.identityOf('claude-sonnet-5-high') === 'claude-sonnet-5');
  ok('thinking-high is stripped', models.identityOf('claude-sonnet-5-thinking-high') === 'claude-sonnet-5');
  ok('max is stripped', models.identityOf('claude-sonnet-5-max') === 'claude-sonnet-5');
  ok('Fast on Grok keeps Fast and drops effort', models.identityOf('cursor-grok-4.6-high-fast') === 'cursor-grok-4.6-fast');
  ok('Composer Fast is the model name', models.identityOf('composer-2.5-fast') === 'composer-2.5-fast');
  ok('Codex Max is a model, not max-mode', models.identityOf('gpt-5.1-codex-max') === 'gpt-5.1-codex-max');
  ok('latest is an alias', models.identityOf('gemini-flash-latest') === 'gemini-flash');
  ok('a hyphenated version is the dotted one', models.identityOf('composer-2-5') === 'composer-2.5');
  ok('and Fast on a hyphenated name stays Fast', models.identityOf('composer-2-5-fast') === 'composer-2.5-fast');
  ok('Anthropic ids keep their hyphens', models.identityOf('claude-opus-4-5') === 'claude-opus-4-5');
  ok("Cursor's word order is the Anthropic id", models.identityOf('claude-4.5-sonnet') === 'claude-sonnet-4-5');
  ok('and so is the hyphenated Cursor order', models.identityOf('claude-4-5-sonnet') === 'claude-sonnet-4-5');
  ok('and so is the short name', models.identityOf('sonnet-4.5') === 'claude-sonnet-4-5');
  ok('and a dotted Anthropic id', models.identityOf('claude-sonnet-4.5') === 'claude-sonnet-4-5');
  ok('a major-only Cursor slug is Sonnet 4', models.identityOf('claude-4-sonnet') === 'claude-sonnet-4');
  ok('Claude 3.5 keeps the old word order', models.identityOf('claude-3-5-sonnet') === 'claude-3-5-sonnet');
  ok('opus-5 is claude-opus-5', models.identityOf('opus-5') === 'claude-opus-5');
  ok('Fast on a Cursor Claude slug stays Fast', models.identityOf('claude-4.5-opus-fast') === 'claude-opus-4-5-fast');

  const cursor = models.create({ name: 'claude-sonnet-5-high', providerId: cheap.id });
  models.create({ name: 'claude-sonnet-5-thinking-high', providerId: cheap.id });
  const n = models.collapseVariantRows(cheap.id);
  ok('collapsing removes the variant rows', n >= 2, String(n));
  ok(
    'and keeps the identity',
    models.list().some((m) => m.name === 'claude-sonnet-5' && m.providerId === cheap.id),
  );
  ok('the high slug is gone', !models.list().some((m) => m.id === cursor.id || m.name === 'claude-sonnet-5-high'));

  models.create({ name: 'composer-latest', providerId: cheap.id });
  models.create({ name: 'composer-2-5', providerId: cheap.id });
  models.create({ name: 'composer-2.5', providerId: cheap.id });
  models.create({ name: 'composer-2.5-fast', providerId: cheap.id });
  models.collapseVariantRows(cheap.id);
  const composers = models.list().filter((m) => m.providerId === cheap.id && m.name.startsWith('composer')).map((m) => m.name).sort();
  ok(
    'Composer aliases collapse to 2.5, Fast stays',
    composers.includes('composer-2.5') && composers.includes('composer-2.5-fast')
      && !composers.includes('composer-latest') && !composers.includes('composer-2-5'),
    composers.join(','),
  );

  models.create({ name: 'claude-4.5-sonnet', providerId: cheap.id });
  models.create({ name: 'claude-sonnet-4-5', providerId: cheap.id });
  models.create({ name: 'sonnet-4.5', providerId: cheap.id });
  models.collapseVariantRows(cheap.id);
  ok(
    'claude-4.5-sonnet is claude-sonnet-4-5',
    models.list().some((m) => m.providerId === cheap.id && m.name === 'claude-sonnet-4-5')
      && !models.list().some((m) => m.providerId === cheap.id && (m.name === 'claude-4.5-sonnet' || m.name === 'sonnet-4.5')),
    models.list().filter((m) => m.providerId === cheap.id && /sonnet/.test(m.name)).map((m) => m.name).join(','),
  );
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

console.log('\n=== The conversation\'s model outranks the harness ===');
{
  ok('a Cursor pick wins over Claude Code\'s Default', requestedModel('claude-opus-5[1m]', 'composer-2.5[fast=false]') === 'composer-2.5[fast=false]');
  ok('and with no conversation choice the body is used', requestedModel('claude-opus-5[1m]', undefined) === 'claude-opus-5[1m]');
  ok('an empty conversation model is not a choice', requestedModel('claude-opus-5', '') === 'claude-opus-5');
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

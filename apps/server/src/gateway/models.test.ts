/**
 * Asking an upstream for its model list.
 *
 * The parts that break quietly: a compatibility layer's prefix left on the URL (a 404 that
 * reads as "this upstream has no models"), an empty list returned as success (the console
 * would clear a working list), and a refusal to leave without an audit proxy turning into a
 * direct connection.
 *
 * Run: npm -w @agentlodge/server run test:models
 */
import type { Provider } from '../core/db/providers.js';
import { fetchModels } from './models.js';

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

function provider(over: Partial<Provider> = {}): Provider {
  return {
    id: 'p1',
    name: 'test',
    kind: 'anthropic-native',
    baseUrl: 'https://api.example.com',
    keyFile: '',
    active: true,
    models: [],
    defaultModel: '',
    createdAt: '',
    updatedAt: '',
    ...over,
  } as Provider;
}

/** Records where the request went, and answers with whatever the case needs */
function upstream(answer: { status?: number; body?: unknown; throws?: boolean }) {
  const seen: { url?: string; headers?: Record<string, string> } = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.url = String(url);
    seen.headers = (init?.headers ?? {}) as Record<string, string>;
    if (answer.throws) throw new Error('connect ECONNREFUSED');
    return new Response(JSON.stringify(answer.body ?? {}), {
      status: answer.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

const direct = (url: string) => ({ url, headers: {} });
const LIST = { data: [{ id: 'claude-opus-5' }, { id: 'claude-sonnet-5' }] };

console.log('\n=== Where the question is sent ===');
{
  const u = upstream({ body: LIST });
  await fetchModels(provider(), 'sk-key', direct);
  ok('anthropic-native asks /v1/models', u.seen.url === 'https://api.example.com/v1/models', String(u.seen.url));
  u.restore();
}
{
  const u = upstream({ body: LIST });
  await fetchModels(provider({ kind: 'openai-chat' }), 'sk-key', direct);
  ok('an openai-chat upstream asks /models', u.seen.url === 'https://api.example.com/models', String(u.seen.url));
  u.restore();
}
{
  const u = upstream({ body: LIST });
  // DeepSeek's compatibility layer lives under /anthropic; the model list does not
  await fetchModels(provider({ baseUrl: 'https://api.deepseek.com/anthropic' }), 'sk-key', direct);
  ok(
    "a vendor's compatibility prefix is stripped",
    u.seen.url === 'https://api.deepseek.com/v1/models',
    String(u.seen.url),
  );
  u.restore();
}
{
  const u = upstream({ body: LIST });
  await fetchModels(provider({ baseUrl: 'https://api.example.com/' }), 'sk-key', direct);
  ok('a trailing slash does not double up', u.seen.url === 'https://api.example.com/v1/models', String(u.seen.url));
  u.restore();
}

console.log('\n=== The credential goes the way that upstream expects ===');
{
  const u = upstream({ body: LIST });
  await fetchModels(provider(), 'sk-ant-api-key', direct);
  ok('an anthropic upstream gets x-api-key', u.seen.headers?.['x-api-key'] === 'sk-ant-api-key');
  ok('and a version', u.seen.headers?.['anthropic-version'] === '2023-06-01');
  u.restore();
}
{
  const u = upstream({ body: LIST });
  await fetchModels(provider({ kind: 'openai-chat' }), 'sk-key', direct);
  ok('an openai upstream gets only the bearer', u.seen.headers?.authorization === 'Bearer sk-key' && u.seen.headers?.['x-api-key'] === undefined);
  u.restore();
}

console.log('\n=== What comes back ===');
{
  const u = upstream({ body: LIST });
  const r = await fetchModels(provider(), 'sk-key', direct);
  ok('ids, in order', r.models.join(',') === 'claude-opus-5,claude-sonnet-5', r.models.join(','));
  ok('and no error', r.error === undefined);
  u.restore();
}
{
  const u = upstream({ body: { data: [{ id: 'a' }, {}, { id: '' }, { id: 'b' }] } });
  const r = await fetchModels(provider(), 'sk-key', direct);
  ok('entries without a usable id are dropped', r.models.join(',') === 'a,b', r.models.join(','));
  u.restore();
}
{
  const u = upstream({ body: { data: [] } });
  const r = await fetchModels(provider(), 'sk-key', direct);
  ok('an empty list is an error, not a silent clearing of the field', r.models.length === 0 && !!r.error, String(r.error));
  u.restore();
}

console.log('\n=== When it cannot answer ===');
{
  const u = upstream({ status: 404, body: {} });
  const r = await fetchModels(provider(), 'sk-key', direct);
  ok('404 says which address was tried', r.error?.includes('/v1/models') === true, String(r.error));
  u.restore();
}
{
  const u = upstream({ status: 401, body: {} });
  const r = await fetchModels(provider(), 'sk-key', direct);
  ok('another status is reported as itself', r.error === 'The upstream returned 401', String(r.error));
  u.restore();
}
{
  const u = upstream({ throws: true });
  const r = await fetchModels(provider(), 'sk-key', direct);
  ok('an unreachable upstream is named as unreachable', r.error?.startsWith('Could not reach') === true, String(r.error));
  u.restore();
}
{
  const r = await fetchModels(provider({ kind: 'mock' }), 'sk-key', direct);
  ok('the built-in mock says it has no list rather than failing', r.error?.includes('no model list') === true, String(r.error));
}
{
  const r = await fetchModels(provider(), '', direct);
  ok('no key configured is said plainly', r.error?.includes('no API key') === true, String(r.error));
}
{
  const u = upstream({ body: LIST });
  const r = await fetchModels(provider(), 'sk-key', () => null);
  ok('refused egress does not become a direct connection', u.seen.url === undefined && !!r.error, String(u.seen.url));
  u.restore();
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

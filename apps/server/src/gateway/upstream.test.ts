/**
 * The outbound request headers.
 *
 * Every failure here is a 401 or 404 from somewhere else, with nothing to see locally:
 *   an OAuth token in x-api-key      → an invalid API key goes out
 *   anthropic-beta overwritten, not merged → the client's prompt caching quietly stops
 *   the oauth beta missing           → the official endpoint rejects the OAuth token
 * So these cases pin down what the headers actually are, not whether the function runs.
 *
 * Run: npm -w @agentlodge/server run test:upstream
 */
import { betaUrl, isOAuthToken, mergeBeta, outboundHeaders, withBillingSystem } from './upstream.js';

const API_KEY = 'sk-ant-api03-real-api-key';
const OAUTH = 'sk-ant-oat01-real-oauth-token';

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

console.log('\n=== Telling the credential kinds apart ===');
ok('sk-ant-oat is an OAuth token', isOAuthToken(OAUTH));
ok('sk-ant-api is not', !isOAuthToken(API_KEY));
ok('the empty string is not', !isOAuthToken(''));

console.log('\n=== An API key goes in both auth headers ===');
{
  const h = outboundHeaders({}, 'anthropic', API_KEY);
  ok('x-api-key carries the key', h['x-api-key'] === API_KEY);
  ok('authorization carries it too', h.authorization === `Bearer ${API_KEY}`);
  ok('no oauth beta', h['anthropic-beta'] === undefined, String(h['anthropic-beta']));
  ok('anthropic-version has a default', h['anthropic-version'] === '2023-06-01');
  ok('accept has a default', h.accept === 'application/json');
}

console.log('\n=== An OAuth token goes in Authorization only ===');
{
  const h = outboundHeaders({}, 'anthropic', OAUTH);
  ok('no x-api-key — sending one would send an invalid API key', h['x-api-key'] === undefined, String(h['x-api-key']));
  ok('authorization is a Bearer', h.authorization === `Bearer ${OAUTH}`);
  ok('the oauth beta is added', (h['anthropic-beta'] ?? '').split(',').includes('oauth-2025-04-20'), String(h['anthropic-beta']));
}

console.log('\n=== anthropic-beta is merged, not overwritten ===');
{
  const h = outboundHeaders(
    { 'anthropic-beta': 'prompt-caching-2024-07-31,fine-grained-tool-streaming-2025-05-14' },
    'anthropic',
    OAUTH,
  );
  const parts = (h['anthropic-beta'] ?? '').split(',');
  ok('what the client enabled survives', parts.includes('prompt-caching-2024-07-31') && parts.includes('fine-grained-tool-streaming-2025-05-14'), h['anthropic-beta']);
  ok('and the oauth beta is there too', parts.includes('oauth-2025-04-20'), h['anthropic-beta']);
}
{
  const h = outboundHeaders({ 'anthropic-beta': 'oauth-2025-04-20' }, 'anthropic', OAUTH);
  const sent = (h['anthropic-beta'] ?? '').split(',');
  ok('no duplicate when the client already sent it', sent.filter((x) => x === 'oauth-2025-04-20').length === 1, String(h['anthropic-beta']));
}
{
  const h = outboundHeaders({ 'anthropic-beta': ['a', 'b'] }, 'anthropic', API_KEY);
  ok('a repeated header, arriving as an array, merges too', h['anthropic-beta'] === 'a,b', String(h['anthropic-beta']));
}
ok('mergeBeta drops empty segments', mergeBeta('a,,b , ') === 'a,b', String(mergeBeta('a,,b , ')));
ok('mergeBeta returns undefined when everything is empty', mergeBeta('') === undefined);
ok('mergeBeta de-duplicates', mergeBeta('a,b', 'a') === 'a,b', String(mergeBeta('a,b', 'a')));

console.log('\n=== Identity headers pass through ===');
{
  const h = outboundHeaders(
    {
      'user-agent': 'claude-cli/2.1.238 (external, cli)',
      'x-app': 'cli',
      'x-claude-code-session-id': 'sess-123',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime-version': 'v26.3.0',
    },
    'anthropic',
    API_KEY,
  );
  ok('user-agent passes through', h['user-agent'] === 'claude-cli/2.1.238 (external, cli)');
  ok('x-app passes through', h['x-app'] === 'cli');
  ok('x-claude-code-session-id passes through', h['x-claude-code-session-id'] === 'sess-123');
  ok('the whole x-stainless-* family passes through', h['x-stainless-arch'] === 'x64' && h['x-stainless-runtime-version'] === 'v26.3.0');
}

console.log('\n=== What the caller did not say about itself ===');
{
  const h = outboundHeaders({}, 'anthropic', OAUTH, 'a-conversation-id');
  ok('a user agent is filled in', h['user-agent']?.startsWith('claude-cli/') === true, h['user-agent']);
  ok('so is x-app', h['x-app'] === 'cli');
  ok('the session is the conversation', h['x-claude-code-session-id'] === 'a-conversation-id');

  const noConv = outboundHeaders({}, 'anthropic', OAUTH);
  ok('with no conversation each request gets its own session', (noConv['x-claude-code-session-id'] ?? '').length === 36, noConv['x-claude-code-session-id']);
  ok('and two of them differ', noConv['x-claude-code-session-id'] !== outboundHeaders({}, 'anthropic', OAUTH)['x-claude-code-session-id']);

  const own = outboundHeaders(
    { 'user-agent': 'my-own-client/1.0', 'x-app': 'something', 'x-claude-code-session-id': 'sess-9' },
    'anthropic',
    OAUTH,
    'a-conversation-id',
  );
  ok('a client that describes itself keeps its own words', own['user-agent'] === 'my-own-client/1.0' && own['x-app'] === 'something');
  ok('including its session', own['x-claude-code-session-id'] === 'sess-9');

  const chat = outboundHeaders({}, 'chat', OAUTH, 'a-conversation-id');
  ok('none of it goes to an endpoint that is not Anthropic', chat['user-agent'] === undefined && chat['x-app'] === undefined && chat['x-claude-code-session-id'] === undefined);
}

console.log('\n=== A subscription request is sent as Claude Code ===');
{
  const h = outboundHeaders({}, 'anthropic', OAUTH);
  const beta = (h['anthropic-beta'] ?? '').split(',');
  ok('it says which client it is', beta.includes('claude-code-20250219'), h['anthropic-beta']);
  ok('and still carries the oauth beta', beta.includes('oauth-2025-04-20'), h['anthropic-beta']);
  ok('the sdk describes itself too', h['x-stainless-lang'] === 'js' && h['x-stainless-runtime'] === 'node', JSON.stringify(h));
  ok('with this machine, not a copied one', h['x-stainless-runtime-version'] === process.version, h['x-stainless-runtime-version']);

  const key = outboundHeaders({}, 'anthropic', API_KEY);
  ok('an api key gets no claude-code beta — the endpoint may not be Anthropic', key['anthropic-beta'] === undefined, String(key['anthropic-beta']));

  const own = outboundHeaders({ 'x-stainless-lang': 'python', 'anthropic-beta': 'mine-2026-01-01' }, 'anthropic', OAUTH);
  ok('an sdk that names itself is left alone', own['x-stainless-lang'] === 'python');
  ok('and its betas are merged, not replaced', (own['anthropic-beta'] ?? '').split(',').includes('mine-2026-01-01'), own['anthropic-beta']);
}

console.log('\n=== Only a subscription is dressed as the CLI ===');
{
  const key = outboundHeaders({}, 'anthropic', API_KEY, 'a-conversation-id');
  ok('an api key sends no claude-cli user agent', key['user-agent'] === undefined, String(key['user-agent']));
  ok('no x-app', key['x-app'] === undefined);
  ok('no session id it has no session for', key['x-claude-code-session-id'] === undefined);
  ok('no sdk fingerprint', key['x-stainless-lang'] === undefined);
  ok('the protocol version still goes — a compatibility layer reads it', key['anthropic-version'] === '2023-06-01');
  ok('and the key goes in both auth headers as before', key['x-api-key'] === API_KEY && key.authorization === `Bearer ${API_KEY}`);

  const runtime = outboundHeaders({ 'user-agent': 'node' }, 'anthropic', OAUTH, 'a-conversation-id');
  ok('a runtime is not a client — node fetch fills that slot itself', runtime['user-agent'] === 'claude-cli/2.1.224 (external, sdk-cli)', runtime['user-agent']);
  const named = outboundHeaders({ 'user-agent': 'my-own-client/1.0' }, 'anthropic', OAUTH, 'a-conversation-id');
  ok('a client that named itself keeps its name', named['user-agent'] === 'my-own-client/1.0');

  const sub = outboundHeaders({}, 'anthropic', OAUTH, 'a-conversation-id');
  ok('a subscription gets the whole identity', sub['user-agent']?.startsWith('claude-cli/') === true && sub['x-app'] === 'cli' && sub['x-stainless-lang'] === 'js');
}

console.log('\n=== The query and the billing line ===');
{
  ok('beta=true is added', betaUrl('https://api.anthropic.com/v1/messages') === 'https://api.anthropic.com/v1/messages?beta=true');
  ok('and joined onto a query that exists', betaUrl('https://x/v1/messages?a=1') === 'https://x/v1/messages?a=1&beta=true');
  ok('a caller that asked for one keeps it', betaUrl('https://x/v1/messages?beta=false') === 'https://x/v1/messages?beta=false');

  const none = withBillingSystem({ model: 'claude-opus-5' }) as { system: Array<{ text: string }> };
  ok('a request with no system gets one', none.system[0]?.text.startsWith('x-anthropic-billing-header:') === true, JSON.stringify(none.system));

  const str = withBillingSystem({ system: 'You are helpful.' }) as { system: Array<{ text: string }> };
  ok('a string system is kept behind it', str.system.length === 2 && str.system[1]?.text === 'You are helpful.', JSON.stringify(str.system));

  const already = { system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1; cc_entrypoint=cli;' }, { type: 'text', text: 'rest' }] };
  ok('a client that sent one is not given a second', withBillingSystem(already) === already);

  const blocks = withBillingSystem({ system: [{ type: 'text', text: 'You are helpful.' }] }) as { system: Array<{ text: string }> };
  ok('otherwise it goes in front', blocks.system.length === 2 && blocks.system[0]?.text.startsWith('x-anthropic-billing-header:') === true);
}

console.log('\n=== Anything that could change destination or identity is blocked ===');
{
  const h = outboundHeaders(
    {
      // Passed through, an agent container could redirect the audit proxy itself
      'x-forwarded-host': 'evil.example.com',
      'x-forwarded-proto': 'http',
      authorization: 'Bearer the-containers-own-ticket',
      'x-api-key': 'a key the container supplied',
      host: '127.0.0.1:8799',
      'content-length': '323',
      connection: 'keep-alive',
      'accept-encoding': 'gzip, deflate, br, zstd',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    'anthropic',
    OAUTH,
  );
  ok('x-forwarded-host is blocked, or this is an SSRF', h['x-forwarded-host'] === undefined);
  ok('x-forwarded-proto is blocked', h['x-forwarded-proto'] === undefined);
  ok('the authorization the container sent is replaced by the upstream credential', h.authorization === `Bearer ${OAUTH}`);
  ok('the x-api-key the container supplied is dropped — an oauth token is not one', h['x-api-key'] === undefined, String(h['x-api-key']));
  ok('hop-by-hop headers are blocked — the outbound layer recomputes them', h.host === undefined && h['content-length'] === undefined && h.connection === undefined && h['accept-encoding'] === undefined);
  ok('the browser-only one is blocked', h['anthropic-dangerous-direct-browser-access'] === undefined);
  ok(
    'these are all the outbound headers',
    Object.keys(h).sort().join(',')
      === [
        'accept', 'anthropic-version', 'authorization', 'content-type', 'user-agent',
        'anthropic-beta', 'x-app', 'x-claude-code-session-id',
        'x-stainless-arch', 'x-stainless-lang', 'x-stainless-os', 'x-stainless-package-version',
        'x-stainless-retry-count', 'x-stainless-runtime', 'x-stainless-runtime-version',
        'x-stainless-timeout',
      ].sort().join(','),
    Object.keys(h).sort().join(','),
  );
}

console.log('\n=== A non-anthropic wire carries no anthropic-* ===');
{
  const h = outboundHeaders({ 'anthropic-beta': 'x' }, 'chat', OAUTH);
  ok('no anthropic-version', h['anthropic-version'] === undefined);
  ok('no anthropic-beta', h['anthropic-beta'] === undefined);
  ok('no x-api-key', h['x-api-key'] === undefined);
  ok('authorization alone', h.authorization === `Bearer ${OAUTH}`);
}

console.log('\n=== What the client specifies wins ===');
{
  const h = outboundHeaders({ 'anthropic-version': '2024-01-01', accept: 'text/event-stream' }, 'anthropic', API_KEY);
  ok('anthropic-version can be overridden', h['anthropic-version'] === '2024-01-01');
  ok('accept can be overridden', h.accept === 'text/event-stream');
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

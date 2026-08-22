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
import { isOAuthToken, mergeBeta, outboundHeaders } from './upstream.js';

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
  ok('the oauth beta is added', h['anthropic-beta'] === 'oauth-2025-04-20', String(h['anthropic-beta']));
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
  ok('no duplicate when the client already sent it', h['anthropic-beta'] === 'oauth-2025-04-20', String(h['anthropic-beta']));
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
    API_KEY,
  );
  ok('x-forwarded-host is blocked, or this is an SSRF', h['x-forwarded-host'] === undefined);
  ok('x-forwarded-proto is blocked', h['x-forwarded-proto'] === undefined);
  ok('the authorization the container sent is replaced by the upstream credential', h.authorization === `Bearer ${API_KEY}`);
  ok('the x-api-key the container supplied is replaced', h['x-api-key'] === API_KEY);
  ok('hop-by-hop headers are blocked — the outbound layer recomputes them', h.host === undefined && h['content-length'] === undefined && h.connection === undefined && h['accept-encoding'] === undefined);
  ok('the browser-only one is blocked', h['anthropic-dangerous-direct-browser-access'] === undefined);
  ok('these are all the outbound headers', Object.keys(h).sort().join(',') === 'accept,anthropic-version,authorization,content-type,x-api-key', Object.keys(h).sort().join(','));
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

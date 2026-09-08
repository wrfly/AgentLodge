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
import {
  CLI_VERSION,
  betaUrl,
  billingLine,
  cliUserAgent,
  endUserId,
  isOAuthToken,
  mergeBeta,
  outboundHeaders,
  speaksAdaptiveThinking,
  withBillingSystem,
  withEndUser,
  withThinking,
} from './upstream.js';

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

console.log('\n=== Only the opaque identity headers pass through ===');
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
  ok('x-app passes through', h['x-app'] === 'cli');
  ok('x-claude-code-session-id passes through — a uuid says nothing about a machine', h['x-claude-code-session-id'] === 'sess-123');
  // These two describe the machine the request came from, which on the bring-your-own-CLI
  // path is somebody's laptop. They used to travel; the person is named in
  // metadata.user_id instead.
  ok('the architecture does not', h['x-stainless-arch'] === undefined, String(h['x-stainless-arch']));
  ok('nor the runtime version', h['x-stainless-runtime-version'] === undefined, String(h['x-stainless-runtime-version']));
  ok('nor the user agent', h['user-agent'] === undefined, String(h['user-agent']));
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
  ok('a client naming itself no longer displaces the deployment\'s identity', own['user-agent'] === cliUserAgent(CLI_VERSION), own['user-agent']);
  ok('though x-app, being a constant, is left as sent', own['x-app'] === 'something');
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
  // The set is written whole, so there is no half-and-half to produce: a python lang beside
  // this host's Node version would be a client that does not exist.
  ok('an sdk naming itself does not get a say', own['x-stainless-lang'] === 'js', String(own['x-stainless-lang']));
  ok(
    'and the family is this deployment\'s throughout',
    own['x-stainless-runtime'] === 'node' && own['x-stainless-runtime-version'] === process.version,
    JSON.stringify(own),
  );
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
  ok('a runtime is not a client — node fetch fills that slot itself', runtime['user-agent'] === `claude-cli/${CLI_VERSION} (external, sdk-cli)`, runtime['user-agent']);
  const named = outboundHeaders({ 'user-agent': 'my-own-client/1.0' }, 'anthropic', OAUTH, 'a-conversation-id');
  ok('and so does a client that named itself', named['user-agent'] === `claude-cli/${CLI_VERSION} (external, sdk-cli)`, named['user-agent']);

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

console.log('\n=== Which Claude Code we say we are ===');
{
  /*
   * The version in the billing line is not decorative: the upstream gates models on it, and
   * answers a request for one that is too new with claude_code_version_too_old naming the
   * number it read there. gateway/cli-version.ts moves it forward from what clients send, so
   * both of these have to be built from an argument rather than baked.
   */
  ok('the line carries the version it was given', billingLine('2.1.263').includes('cc_version=2.1.263.ddf;'), billingLine('2.1.263'));
  ok('and names the entrypoint, which is what we actually are', billingLine('2.1.263').includes('cc_entrypoint=sdk-cli;'));
  ok('the user agent carries it too', cliUserAgent('2.1.263') === 'claude-cli/2.1.263 (external, sdk-cli)', cliUserAgent('2.1.263'));

  const claimed = withBillingSystem({ model: 'claude-fable-5-1' }, '2.1.263') as { system: Array<{ text: string }> };
  ok('a body with no line of its own gets the version we pass', claimed.system[0]?.text === billingLine('2.1.263'), JSON.stringify(claimed.system[0]));

  const theirs = { system: [{ type: 'text', text: billingLine('2.1.240') }, { type: 'text', text: 'rest' }] };
  ok('a client that sent one keeps its own version, whatever we would have claimed', withBillingSystem(theirs, '2.1.263') === theirs);

  const h = outboundHeaders({}, 'anthropic', OAUTH, undefined, '2.1.263');
  ok('the header follows the same version', h['user-agent'] === cliUserAgent('2.1.263'), h['user-agent']);

  // The default is the baked floor, so a caller with no database behind it — the model-list
  // fetch — keeps working unchanged
  ok('with no version given, the floor', outboundHeaders({}, 'anthropic', OAUTH)['user-agent'] === cliUserAgent(CLI_VERSION));
  ok(
    'and the body gets the floor too',
    (withBillingSystem({ model: 'x' }) as { system: Array<{ text: string }> }).system[0]?.text === billingLine(CLI_VERSION),
  );
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

console.log('\n=== Which upstreams know the word "adaptive" ===');
ok('the official endpoint', speaksAdaptiveThinking('https://api.anthropic.com/v1/messages'));
ok('a subdomain of it', speaksAdaptiveThinking('https://api.eu.anthropic.com/v1/messages'));
ok('deepseek does not', !speaksAdaptiveThinking('https://api.deepseek.com/anthropic/v1/messages'));
ok(
  'and neither does a host that merely ends in the same letters',
  !speaksAdaptiveThinking('https://notanthropic.com/v1/messages'),
);
ok('a url that will not parse is not the official endpoint', !speaksAdaptiveThinking('nonsense'));

console.log('\n=== The thinking directive is translated, not invented ===');
{
  const cli = { model: 'x', max_tokens: 64000, thinking: { type: 'adaptive' } };

  const official = withThinking(cli, true, true) as typeof cli;
  ok('the official endpoint keeps adaptive', official.thinking.type === 'adaptive', JSON.stringify(official.thinking));
  ok('and the body is not even copied', official === cli);

  const deepseek = withThinking(cli, true, false) as { thinking: { type: string; budget_tokens?: number } };
  ok('deepseek is asked in the dialect it reads', deepseek.thinking.type === 'enabled', JSON.stringify(deepseek.thinking));
  ok('with a budget below max_tokens', deepseek.thinking.budget_tokens === 8192);
  ok('the original is left alone', cli.thinking.type === 'adaptive');

  const off = withThinking(cli, false, false) as { thinking: { type: string } };
  ok('the switch off says so outright', off.thinking.type === 'disabled', JSON.stringify(off.thinking));
  ok('and off means off on the official endpoint too', (withThinking(cli, false, true) as typeof off).thinking.type === 'disabled');
}
{
  // The one that stops this turning thinking on where nobody asked: naming a conversation
  // and summarising one send no thinking field, and a Responses-wire body has no such field
  const ours = { model: 'x', max_tokens: 200 };
  ok('a body that never asked is untouched with the switch on', withThinking(ours, true, false) === ours);
  ok('and untouched with the switch off', withThinking(ours, false, false) === ours);

  const explicit = { max_tokens: 64000, thinking: { type: 'enabled', budget_tokens: 2048 } };
  ok(
    'a client that named its own budget keeps it',
    withThinking(explicit, true, false) === explicit,
  );

  const small = { max_tokens: 4000, thinking: { type: 'adaptive' } };
  const clamped = withThinking(small, true, false) as unknown as { thinking: { budget_tokens: number } };
  ok('a small max_tokens clamps the budget under it', clamped.thinking.budget_tokens === 3999, String(clamped.thinking.budget_tokens));

  const tiny = { max_tokens: 512, thinking: { type: 'adaptive' } };
  ok('a max_tokens with no room for a budget is left as it stands', withThinking(tiny, true, false) === tiny);

  const noMax = { thinking: { type: 'adaptive' } };
  const dflt = withThinking(noMax, true, false) as unknown as { thinking: { budget_tokens: number } };
  ok('no max_tokens at all still produces a valid budget', dflt.thinking.budget_tokens === 8192);

  ok('a non-object body is returned as it is', withThinking(null, true, false) === null);
}

console.log('\n=== The caller\'s machine does not travel ===');
{
  // What a real Claude Code on somebody's own laptop says about itself
  const fromLaptop = {
    'user-agent': 'claude-cli/2.1.263 (external, cli)',
    'x-app': 'cli',
    'x-claude-code-session-id': 'sess-abc',
    'x-stainless-os': 'MacOS',
    'x-stainless-arch': 'arm64',
    'x-stainless-runtime-version': 'v24.1.0',
    'x-stainless-lang': 'python',
  };
  const h = outboundHeaders(fromLaptop, 'anthropic', 'sk-ant-oat-x', 'conv-1', '2.1.263');

  ok('their Node version stays home', h['x-stainless-runtime-version'] === process.version, String(h['x-stainless-runtime-version']));
  ok('and the language they claimed does not survive', h['x-stainless-lang'] === 'js', String(h['x-stainless-lang']));
  ok(
    'the user agent is the deployment\'s own, at the version asked for',
    h['user-agent'] === cliUserAgent('2.1.263'),
    String(h['user-agent']),
  );
  ok('the session id, being opaque, still goes through', h['x-claude-code-session-id'] === 'sess-abc');
  ok('and so does x-app', h['x-app'] === 'cli');

  // An API key is billed to whoever sends it and nothing upstream asks who that is, so no
  // identity is invented there — but the caller's machine must not leak either
  const k = outboundHeaders(fromLaptop, 'anthropic', 'sk-ant-api-x');
  ok('on an API key nothing describes the caller\'s machine', k['x-stainless-os'] === undefined && k['x-stainless-arch'] === undefined, JSON.stringify(k));
  ok('and no user agent is invented', k['user-agent'] === undefined, String(k['user-agent']));
}

console.log('\n=== Claude Code\'s own headers stay on the wire that knows them ===');
{
  const fromCli = {
    'x-app': 'cli',
    'x-claude-code-session-id': 'sess-abc',
    'anthropic-beta': 'context-management-2025-06-27',
  };

  // An upstream on this wire serves Claude Code and knows what these mean
  const messages = outboundHeaders(fromCli, 'anthropic', API_KEY, 'conv-1');
  ok('the Anthropic wire still gets them', messages['x-app'] === 'cli' && messages['x-claude-code-session-id'] === 'sess-abc');
  // The protocol version and the beta list are the upstream's business, not ours: a
  // compatibility layer reads the version, and the guide for gateways is explicit that
  // stripping the beta header while forwarding the body fields it pairs with produces a
  // hard 400 rather than quietly turning the feature off
  ok('with the protocol version', messages['anthropic-version'] === '2023-06-01');
  ok('and its betas forwarded verbatim', (messages['anthropic-beta'] ?? '').includes('context-management-2025-06-27'));

  for (const wire of ['chat', 'responses'] as const) {
    const h = outboundHeaders(fromCli, wire, API_KEY, 'conv-1');
    ok(`${wire}: no x-app — an OpenAI-shaped endpoint has no use for it`, h['x-app'] === undefined, JSON.stringify(h));
    ok(`${wire}: no session id to group one person's turns by`, h['x-claude-code-session-id'] === undefined, JSON.stringify(h));
    ok(`${wire}: and none of the Anthropic protocol headers`, h['anthropic-version'] === undefined && h['anthropic-beta'] === undefined, JSON.stringify(h));
    ok(`${wire}: the credential and the content type still go`, h.authorization === `Bearer ${API_KEY}` && h['content-type'] === 'application/json');
  }
}

console.log('\n=== metadata.user_id names the person, not the machine ===');
{
  /*
   * The shape a real Claude Code sends, from a capture in trace-proxy: a fingerprint of the
   * machine and the caller's own account uuid, as a JSON string.
   */
  const body = {
    model: 'claude-x',
    metadata: {
      user_id: JSON.stringify({ device_id: '094aec26', account_uuid: 'd5ebd251', session_id: '53dca3aa' }),
    },
  };
  const out = withEndUser(body, 'anthropic', endUserId('user-1'));

  ok('the device fingerprint is gone', !out.metadata.user_id.includes('094aec26'), out.metadata.user_id);
  ok('so is the account uuid', !out.metadata.user_id.includes('d5ebd251'), out.metadata.user_id);
  ok('what is left is opaque, and far inside the 512 the API allows', /^[0-9a-f]{64}$/.test(out.metadata.user_id));
  ok('one person gets one value, every time', endUserId('user-1') === endUserId('user-1'));
  ok('two people never share one', endUserId('user-1') !== endUserId('user-2'));
  ok('and our own id cannot be read back out of it', !endUserId('user-1').includes('user-1'));

  // The generic returns what it was given, so the added key needs a type to be read back
  type WithMeta = { metadata: Record<string, unknown> };
  const added = withEndUser<WithMeta>({ model: 'm' } as unknown as WithMeta, 'anthropic', 'abc');
  ok('a body that carried no metadata gets one', added.metadata.user_id === 'abc');
  const kept = withEndUser<WithMeta>({ metadata: { other: 1 } }, 'anthropic', 'abc');
  ok('anything else in metadata is kept', kept.metadata.other === 1);

  // Dropping the machine headers is what closes this on the other wires; a body bound for a
  // third party is not the place to add a field it never received
  const chat = withEndUser({ model: 'm' }, 'chat', 'abc');
  ok('the OpenAI wires are left as they are', !('metadata' in chat), JSON.stringify(chat));
  ok('and a body that is not an object survives', withEndUser(null, 'anthropic', 'abc') === null);
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

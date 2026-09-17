/**
 * A Cursor upstream, driven through the gateway the way a CLI drives it.
 *
 * The unit tests cover each half of the bridge; this covers the seam none of them can — a
 * real request through buildGateway(), resolved to a `cursor` provider, authenticated by
 * exchanging a key, framed, answered in protobuf, and translated back into whichever
 * protocol asked. Both CLIs are driven, because "both CLIs work against Cursor" is the
 * claim the whole design rests on and it is the kind of claim that quietly stops being
 * true.
 *
 * The upstream here is an ordinary http server that speaks Connect: the bridge cannot tell
 * it from api2.cursor.sh, which is the point.
 *
 * Run: npm -w @agentlodge/server run test:cursor-relay
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { decode, encode, type Message } from './codec.js';
import { envelope, FLAG_END_STREAM } from './connect.js';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-cursor-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
process.env.CREDENTIAL_MANAGER_SOCKET = path.join(box, 'credential-manager.sock');
process.env.QUEUE_TIMEOUT_MS = '1500';

/** The credential manager, which is where the key an administrator pasted comes from */
const manager = http.createServer((req, res) => {
  const id = new URL(req.url ?? '/', 'http://unix').searchParams.get('credential') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ credential: id, accessToken: `cursor-api-key-${id}` }));
});
await new Promise<void>((r) => manager.listen(process.env.CREDENTIAL_MANAGER_SOCKET!, r));

/** What the fake Cursor answers with next, and what it saw */
let frames: Uint8Array[] = [];
let seen: { path?: string; auth?: string; clientType?: string; request?: Message } = {};
let exchanges = 0;

const cursor = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen = {
      path: req.url,
      auth: req.headers.authorization,
      clientType: req.headers['x-cursor-client-type'] as string | undefined,
      request: seen.request,
    };

    if (req.url === '/auth/exchange_user_api_key') {
      exchanges++;
      res.writeHead(200, { 'content-type': 'application/json' });
      // A JWT-shaped token with an hour on it, so the cache behaves as it would live
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      res.end(JSON.stringify({ accessToken: `ey.${payload}.sig`, refreshToken: 'refresh' }));
      return;
    }

    // The request as the bridge built it: five bytes of envelope, then the message
    seen.request = decode('aiserver.v1.StreamUnifiedChatRequest', new Uint8Array(body.subarray(5)));
    res.writeHead(200, { 'content-type': 'application/connect+proto' });
    for (const f of frames) res.write(Buffer.from(f));
    res.end();
  });
});
await new Promise<void>((r) => cursor.listen(0, '127.0.0.1', r));
const cursorUrl = `http://127.0.0.1:${(cursor.address() as { port: number }).port}`;

const { initDb } = await import('../../core/db/index.js');
initDb();
const users = await import('../../core/db/users.js');
const providers = await import('../../core/db/providers.js');
const models = await import('../../core/db/models.js');
const usage = await import('../../core/db/usage.js');
const { signRuntimeToken } = await import('../../core/runtime-token.js');
const { buildGateway } = await import('../index.js');

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
const provider = providers.create({
  name: 'Cursor', kind: 'cursor', baseUrl: cursorUrl, credentialId: 'cursor',
});
models.create({ name: 'cursor-model', providerId: provider.id });
const user = users.create({ email: 'c@example.com', username: 'cursor', passwordHash: 'x', role: 'user' });

const app = buildGateway();
const token = await signRuntimeToken(
  { sub: user.id, cid: 'conv-1', tid: 'turn-1', agent: 'claude', thinking: false },
  60_000,
);

const response = (body: Message): Uint8Array =>
  envelope(encode('aiserver.v1.StreamUnifiedChatResponse', body));
const trailer = (body: unknown = {}): Uint8Array =>
  envelope(new TextEncoder().encode(JSON.stringify(body)), FLAG_END_STREAM);

const asClaude = () =>
  app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {
      model: 'cursor-model',
      max_tokens: 1024,
      system: 'be brief',
      messages: [{ role: 'user', content: 'what is 2 + 2' }],
      tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
    },
  });

const asCodex = () =>
  app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {
      model: 'cursor-model',
      instructions: 'be brief',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is 2 + 2' }] }],
    },
  });

async function run(): Promise<void> {
  console.log('\n=== Claude Code gets an answer out of a Cursor upstream ===');
  {
    frames = [response({ text: 'four' }), trailer()];
    const res = await asClaude();

    ok('the turn succeeds', res.statusCode === 200, String(res.statusCode));
    ok('the key was exchanged for a token', exchanges === 1, String(exchanges));
    ok('which is what authenticates the call', seen.auth?.startsWith('Bearer ey.') === true, seen.auth);
    ok('the RPC is the chat one', seen.path === '/aiserver.v1.ChatService/StreamUnifiedChat', seen.path);
    ok('and we present as the client the credential belongs to', seen.clientType === 'cli', seen.clientType);

    ok('the client is answered in Anthropic frames', res.body.includes('event: message_start'), res.body.slice(0, 200));
    ok('carrying the text', res.body.includes('four'), res.body);
    ok('and a stop reason', res.body.includes('"stop_reason":"end_turn"'), res.body);

    const sent = seen.request!;
    ok('the system prompt travelled as explicit context', (sent['explicit_context'] as Message)?.['context'] === 'be brief');
    ok('the question travelled as the human turn', (sent['conversation'] as Message[])?.[0]?.['text'] === 'what is 2 + 2');
    ok("Claude Code's tool travelled as an MCP tool", (sent['mcp_tools'] as Message[])?.[0]?.['name'] === 'Read');
    ok('and the model name is the one the row names', (sent['model_details'] as Message)?.['model_name'] === 'cursor-model');
  }

  console.log('\n=== The token is not exchanged again for the next turn ===');
  {
    frames = [response({ text: 'still four' }), trailer()];
    await asClaude();
    ok('one exchange has served both turns', exchanges === 1, String(exchanges));
  }

  console.log('\n=== A tool call comes back as a tool_use block ===');
  {
    frames = [
      response({ text: 'let me look' }),
      response({ tool_call: { tool_call_id: 'c1', name: 'Read', raw_args: '{"path":"a.ts"}' } }),
      trailer(),
    ];
    const res = await asClaude();
    ok('the block is a tool_use', res.body.includes('"type":"tool_use"') && res.body.includes('"name":"Read"'), res.body);
    ok('its input arrives as json', res.body.includes('input_json_delta'), res.body);
    ok('and the turn stops for the tool', res.body.includes('"stop_reason":"tool_use"'), res.body);
  }

  console.log('\n=== Codex gets the same upstream as a Responses stream ===');
  {
    frames = [response({ text: 'four' }), trailer()];
    const res = await asCodex();
    ok('the turn succeeds', res.statusCode === 200, String(res.statusCode));
    ok('it opens as a response', res.body.includes('event: response.created'), res.body.slice(0, 200));
    ok('the text arrives as output_text', res.body.includes('response.output_text.delta') && res.body.includes('four'), res.body);
    ok('and it completes', res.body.includes('event: response.completed'), res.body);
    ok(
      'the instructions travelled as explicit context',
      (seen.request!['explicit_context'] as Message)?.['context'] === 'be brief',
      JSON.stringify(seen.request!['explicit_context']),
    );
  }

  console.log('\n=== What Cursor refuses, the client is told ===');
  {
    frames = [trailer({ error: { code: 'resource_exhausted', message: 'you have run out of fast requests' } })];
    const res = await asClaude();
    ok('the refusal reaches the client as an error event', res.body.includes('event: error'), res.body);
    ok("with Cursor's own sentence", res.body.includes('you have run out of fast requests'), res.body);
    ok('and the turn is not closed as a finished answer', !res.body.includes('message_stop'), res.body);
  }

  console.log('\n=== The turn is booked, from the estimate ===');
  {
    const totals = usage.totalsForUser(user.id);
    ok('something was recorded', totals.inputTokens > 0 && totals.outputTokens > 0, JSON.stringify(totals));
    ok('and it is attributed to this upstream', usage.byUpstreamForUser(user.id).some((u) => u.providerId === provider.id), JSON.stringify(usage.byUpstreamForUser(user.id)));
  }
}

try {
  await run();
} finally {
  cursor.close();
  manager.close();
  fs.rmSync(box, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * What reaches the client when the upstream refuses, and what keeps a slow one alive.
 *
 * Both are about a stream nobody is producing content on, and both were wrong in the same
 * direction: the gateway answered for the upstream instead of relaying it.
 *
 *   an error body run through the translator came out a well-formed message with nothing
 *     in it — and Claude Code recovers from a rejected capability by matching the
 *     upstream's own wording, so it had nothing to match
 *   a translated stream emitted nothing while the model was thinking, and the client
 *     abandons a request after 300 seconds of silence
 *
 * The gateway is built here and driven with inject, against a fake upstream and a fake
 * credential manager, because neither behaviour is visible in the pieces on their own.
 *
 * Run: npm -w @agentlodge/server run test:relay
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-relay-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
process.env.CREDENTIAL_MANAGER_SOCKET = path.join(box, 'credential-manager.sock');
// Short enough to watch, long enough that a slow machine does not produce one by accident
process.env.STREAM_KEEP_ALIVE_MS = '150';

const manager = http.createServer((req, res) => {
  const id = new URL(req.url ?? '/', 'http://unix').searchParams.get('credential') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ credential: id, accessToken: `sk-${id}` }));
});
await new Promise<void>((r) => manager.listen(process.env.CREDENTIAL_MANAGER_SOCKET!, r));

/**
 * The upstream. Each test sets `reply` to whatever it wants to come back next, so one
 * server covers a refusal, a normal answer and a stream that thinks before it speaks.
 */
let reply: (res: http.ServerResponse) => void = (res) => res.end();
const upstream = http.createServer((req, res) => {
  req.resume();
  req.on('end', () => reply(res));
});
await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;

const { initDb } = await import('../core/db/index.js');
initDb();
const users = await import('../core/db/users.js');
const providers = await import('../core/db/providers.js');
const models = await import('../core/db/models.js');
const { signRuntimeToken } = await import('../core/runtime-token.js');
const { buildGateway } = await import('./index.js');

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
// openai-chat is the kind that gets translated, which is where both bugs lived
const provider = providers.create({
  name: 'Local model', kind: 'openai-chat', baseUrl: upstreamUrl, credentialId: 'local',
});
models.create({ name: 'local-model', providerId: provider.id });

// user_quotas points at users, and the quota gate reads it on every request
const user = users.create({ email: 'r@example.com', username: 'relay', passwordHash: 'x', role: 'user' });

const app = buildGateway();
const token = await signRuntimeToken(
  { sub: user.id, cid: 'conv-1', tid: 'turn-1', agent: 'claude', thinking: false },
  60_000,
);
const ask = (body: unknown) =>
  app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: body as object,
  });
const body = { model: 'local-model', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] };

console.log('\n=== An upstream that refuses is relayed as it refused ===');
{
  // The wording is the whole payload: Claude Code reads it to decide what to drop and retry
  const refusal = JSON.stringify({
    error: { message: 'thinking is not supported by this model', type: 'invalid_request_error' },
  });
  reply = (res) => {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(refusal);
  };
  const res = await ask(body);
  ok('the status is the upstream\'s', res.statusCode === 400, String(res.statusCode));
  ok('and so is the body, to the byte', res.body === refusal, res.body);
  ok('nothing was invented in its place', !res.body.includes('msg_translated'), res.body);
}

console.log('\n=== A normal answer is still translated ===');
{
  reply = (res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      model: 'local-model',
      choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2 },
    }));
  };
  const res = await ask(body);
  const out = JSON.parse(res.body) as { type?: string; content?: Array<{ text?: string }> };
  ok('the client gets an Anthropic message', out.type === 'message', res.body);
  ok('carrying the text', out.content?.[0]?.text === 'hello there', res.body);
}

console.log('\n=== A stream that thinks before it speaks is kept alive ===');
{
  /*
   * The upstream says nothing for a while, then answers. There is no ping frame to relay on
   * this side, so the gateway writes its own; without them the client counts the silence
   * and gives up at 300 seconds.
   */
  reply = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    // Node holds the headers until the first write, and the silence has to be in the body
    // for the gateway to be inside the relay loop while it lasts
    res.flushHeaders();
    setTimeout(() => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'late' } }] })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    }, 500);
  };
  const res = await ask(body);
  const pings = res.body.match(/event: ping/g)?.length ?? 0;
  ok('pings were sent while it was quiet', pings > 0, `${pings} in ${JSON.stringify(res.body.slice(0, 120))}`);
  ok('and the answer still arrives after them', res.body.includes('late'), res.body.slice(-160));
  ok('with the stream properly closed', res.body.includes('message_stop'), res.body.slice(-160));
}

manager.close();
upstream.close();
await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

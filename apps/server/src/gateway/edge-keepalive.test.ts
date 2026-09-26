/**
 * The comment that keeps a proxy from closing a stream that has not answered yet.
 *
 * Cloudflare's proxy read timeout is 120 seconds and starts when the request is
 * forwarded. The queue and the wait for upstream headers write nothing, so a slow
 * turn becomes a 524 before the gateway has a status to send. The comment is not an
 * event: a fast answer is unchanged, a JSON answer never grows one, and a refusal
 * that arrives after the comment has committed the status is said in the stream.
 *
 * Claude's frame is `event: ping`. Codex's is the comment `: ping`. The stretch before
 * any real frame uses the comment on both wires: an event ping read as the first event
 * is what a consumer that takes that event to be the message rejects.
 *
 * Run: npm -w @agentlodge/server run test:edge-keepalive
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-edge-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
process.env.CREDENTIAL_MANAGER_SOCKET = path.join(box, 'credential-manager.sock');
// Short enough to watch, long enough that a fast answer finishes first
process.env.EDGE_KEEP_ALIVE_MS = '300';
process.env.STREAM_KEEP_ALIVE_MS = '60000';
process.env.UPSTREAM_HEADERS_TIMEOUT_MS = '5000';
process.env.UPSTREAM_IDLE_TIMEOUT_MS = '5000';
process.env.QUEUE_TIMEOUT_MS = '1500';

const SLOW_MS = 1200;

const manager = http.createServer((req, res) => {
  const id = new URL(req.url ?? '/', 'http://unix').searchParams.get('credential') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ credential: id, accessToken: `sk-${id}` }));
});
await new Promise<void>((r) => manager.listen(process.env.CREDENTIAL_MANAGER_SOCKET!, r));

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
const native = providers.create({
  name: 'Native', kind: 'anthropic-native', baseUrl: upstreamUrl, credentialId: 'native',
});
models.create({ name: 'native-model', providerId: native.id });
const chat = providers.create({
  name: 'Local model', kind: 'openai-chat', baseUrl: upstreamUrl, credentialId: 'local',
});
models.create({ name: 'local-model', providerId: chat.id });
const user = users.create({ email: 'e@example.com', username: 'edge', passwordHash: 'x', role: 'user' });

const app = buildGateway();
const token = await signRuntimeToken(
  { sub: user.id, cid: 'conv-1', tid: 'turn-1', agent: 'claude', thinking: false },
  60_000,
);

const ask = (model: string, stream: boolean) =>
  app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: {
      model,
      max_tokens: 64,
      ...(stream ? { stream: true } : {}),
      messages: [{ role: 'user', content: 'hi' }],
    },
  });

function sse(write: (res: http.ServerResponse) => void) {
  reply = (res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    write(res);
  };
}

async function run(): Promise<void> {
  console.log('\n=== A fast stream is not commented ===');
  {
    sse((res) => {
      res.end('event: message_stop\ndata: {"type":"message_stop"}\n\n');
    });
    const res = await ask('native-model', true);
    ok('no ping', !res.body.includes(': ping') && !res.body.includes('event: ping'), res.body.slice(0, 160));
    ok('and the frame is intact', res.body.includes('message_stop'), res.body.slice(0, 160));
  }

  console.log('\n=== Silence before the first frame is a comment, and it repeats ===');
  {
    reply = (res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.end('event: content_block_delta\ndata: {"text":"hello-slow"}\n\n');
      }, SLOW_MS);
    };
    const res = await ask('native-model', true);
    const n = res.body.match(/: ping/g)?.length ?? 0;
    const commentAt = res.body.indexOf(': ping');
    const bodyAt = res.body.indexOf('hello-slow');
    ok('more than one, so the wait cannot grow back to the proxy timeout', n >= 2, String(n));
    ok('and they precede the real frame', commentAt !== -1 && bodyAt !== -1 && commentAt < bodyAt, res.body.slice(0, 220));
    ok('not an event, which would be the first thing a client reads', !res.body.includes('event: ping'), res.body.slice(0, 220));
    ok('status stays 200', res.statusCode === 200, String(res.statusCode));
  }

  console.log('\n=== Once a frame exists, Claude gets its own ping ===');
  {
    sse((res) => {
      res.write('event: content_block_delta\ndata: {"text":"one"}\n\n');
      setTimeout(() => {
        res.write('event: message_stop\ndata: {"text":"two"}\n\n');
        res.end();
      }, SLOW_MS);
    });
    const res = await ask('native-model', true);
    const one = res.body.indexOf('"text":"one"');
    const ping = res.body.indexOf('event: ping\ndata: {"type":"ping"}');
    const two = res.body.indexOf('"text":"two"');
    ok('the ping lands in the gap', one !== -1 && ping > one && two > ping, res.body);
  }

  console.log('\n=== And Codex gets the comment, on the same gap ===');
  {
    sse((res) => {
      res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
      setTimeout(() => {
        res.write('data: {"choices":[{"delta":{"content":"two"}}]}\n\n');
        res.end();
      }, SLOW_MS);
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/chat/completions',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { model: 'local-model', stream: true, messages: [{ role: 'user', content: 'hi' }] },
    });
    const one = res.body.indexOf('"content":"one"');
    const ping = res.body.indexOf(': ping');
    const two = res.body.indexOf('"content":"two"');
    ok('the comment lands in the gap', one !== -1 && ping > one && two > ping, res.body.slice(0, 300));
    ok('and not Claude\'s event', !res.body.includes('event: ping'), res.body.slice(0, 240));
  }

  console.log('\n=== A slow refusal after the comment is said in the stream ===');
  {
    reply = (res) => {
      setTimeout(() => {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'model missing' } }));
      }, SLOW_MS);
    };
    const res = await ask('local-model', true);
    ok('the comment had already committed the status', res.statusCode === 200, String(res.statusCode));
    ok('so the refusal is a frame', res.body.includes('event: error'), res.body.slice(0, 300));
    ok('carrying what the upstream said', res.body.includes('model missing'), res.body.slice(0, 300));
  }

  console.log('\n=== A fast refusal is still a status ===');
  {
    reply = (res) => {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'model missing' } }));
    };
    const res = await ask('local-model', true);
    ok('no ping', !res.body.includes(': ping') && !res.body.includes('event: ping'), res.body.slice(0, 160));
    ok('the status is the upstream\'s', res.statusCode === 400, String(res.statusCode));
    const out = JSON.parse(res.body) as { type?: string; error?: { message?: string } };
    ok('and the body parses', out.type === 'error' && out.error?.message === 'model missing', res.body);
  }

  console.log('\n=== A non-streaming answer is never commented, however slow ===');
  {
    reply = (res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          model: 'local-model',
          choices: [{ message: { content: 'plain' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      }, SLOW_MS);
    };
    const res = await ask('local-model', false);
    ok('no ping in front of the JSON', !res.body.includes(': ping') && !res.body.includes('event: ping'), res.body.slice(0, 160));
    const out = JSON.parse(res.body) as { content?: Array<{ text?: string }> };
    ok('and it still parses', out.content?.[0]?.text === 'plain', res.body);
  }
}

try {
  await run();
} finally {
  manager.close();
  upstream.close();
  await app.close();
  fs.rmSync(box, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * What reaches the client when the upstream misbehaves.
 *
 * Every case here was once answered by the gateway on the upstream's behalf, and each of
 * them is invisible in the pieces on their own — they are about what the request handler
 * does with a stream nobody is producing content on. So the gateway is built and driven
 * with inject, against an http server standing in for the upstream.
 *
 * The shapes that matter, and why each has its own block:
 *   a refusal on a 200, which is how Ollama and llama.cpp report a model that will not load
 *   a refusal mid-stream, after the client is already reading translated frames
 *   an upstream that chatters in a way the translator drops — reasoning tokens, heartbeat
 *     comments — which is silence as far as the client is concerned
 *   a stream cut by the idle bound, which must not look like a complete answer
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
// Short enough to watch; the idle bound is set per-block by reloading the module is not
// possible, so it is chosen once here and the slow block is timed against it
process.env.STREAM_KEEP_ALIVE_MS = '120';
process.env.UPSTREAM_IDLE_TIMEOUT_MS = '600';

const manager = http.createServer((req, res) => {
  const id = new URL(req.url ?? '/', 'http://unix').searchParams.get('credential') ?? '';
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ credential: id, accessToken: `sk-${id}` }));
});
await new Promise<void>((r) => manager.listen(process.env.CREDENTIAL_MANAGER_SOCKET!, r));

/** The upstream. Each block sets `reply` to whatever it wants back next. */
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
// openai-chat is the kind that gets translated, which is where all of this lives
const provider = providers.create({
  name: 'Local model', kind: 'openai-chat', baseUrl: upstreamUrl, credentialId: 'local',
});
models.create({ name: 'local-model', providerId: provider.id });
/*
 * A second upstream that speaks Messages already, so nothing is translated and the bytes are
 * relayed as they arrive. Every block used to drive the translated one, which left the arm
 * where the framing decisions actually matter with no coverage at all.
 */
const native = providers.create({
  name: 'Native', kind: 'anthropic-native', baseUrl: upstreamUrl, credentialId: 'native',
});
models.create({ name: 'native-model', providerId: native.id });
// user_quotas points at users, and the quota gate reads it on every request
const user = users.create({ email: 'r@example.com', username: 'relay', passwordHash: 'x', role: 'user' });

const app = buildGateway();
const token = await signRuntimeToken(
  { sub: user.id, cid: 'conv-1', tid: 'turn-1', agent: 'claude', thinking: false },
  60_000,
);
const ask = (model = 'local-model') =>
  app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { model, max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] },
  });

/** An SSE upstream, headers flushed so the silence lands in the body where the relay is */
function sse(write: (res: http.ServerResponse) => void, status = 200) {
  reply = (res) => {
    res.writeHead(status, { 'content-type': 'text/event-stream' });
    res.flushHeaders();
    write(res);
  };
}

async function run(): Promise<void> {
  console.log('\n=== A refusal is relayed whatever status it came under ===');
  {
    const refusal = JSON.stringify({
      error: { message: 'thinking is not supported by this model', type: 'invalid_request_error' },
    });
    for (const status of [400, 200]) {
      reply = (res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(refusal);
      };
      const res = await ask();
      // 200 is the one that matters: Ollama and llama.cpp answer a model that will not load
      // exactly that way, and a status check alone lets it through the translator
      ok(
        `${status}: the upstream's words survive`,
        res.body.includes('thinking is not supported by this model'),
        res.body,
      );
      ok(`${status}: and nothing was invented in its place`, !res.body.includes('msg_translated'), res.body);
    }
  }

  console.log('\n=== A refusal that arrives mid-stream keeps its words ===');
  {
    // The client is reading Anthropic frames by now, so the body cannot be relayed as it
    // stands — but the wording is what the capability-retry path matches on
    sse((res) => {
      res.write(`data: ${JSON.stringify({ error: { message: 'context length 8192 exceeded' } })}\n\n`);
      res.end();
    });
    const res = await ask();
    ok('it becomes an error frame', res.body.includes('event: error'), res.body);
    ok('carrying what the upstream said', res.body.includes('context length 8192 exceeded'), res.body);
    ok('and no message_stop, which would mean it finished', !res.body.includes('message_stop'), res.body);
  }

  console.log('\n=== An upstream heard but not relayed is silence to the client ===');
  {
    /*
     * The shape the keep-alive exists for, and the one the first version missed: a
     * DeepSeek-R1-class model streams reasoning for minutes with no `content`. The
     * translator drops every one of those frames, so the client receives nothing — while
     * the gateway, if it keys its ping on the upstream's chatter, thinks all is well.
     */
    sse((res) => {
      let n = 0;
      const chatter = setInterval(() => {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: 'thinking' } }] })}\n\n`);
        res.write(': keep-alive\n\n');
        if (++n < 8) return;
        clearInterval(chatter);
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'done' } }] })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      }, 50);
    });
    const res = await ask();
    const pings = res.body.match(/event: ping/g)?.length ?? 0;
    ok('pings went out while the client had nothing', pings > 0, `${pings} pings; body ${res.body.slice(0, 90)}`);
    ok('and the answer still arrives', res.body.includes('done'), res.body.slice(-140));
    ok('with the stream properly closed', res.body.includes('message_stop'), res.body.slice(-140));
  }

  console.log('\n=== A stream cut short says so, rather than just stopping ===');
  {
    // Past the idle bound the gateway gives up, and the headers went out long ago — so the
    // only way to say the answer is unfinished is a frame. Without one the client reads a
    // 200 that stops early as a complete, short answer, and does not retry.
    sse((res) => {
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'half' } }] })}\n\n`);
      // and then nothing, for longer than UPSTREAM_IDLE_TIMEOUT_MS
    });
    const res = await ask();
    ok('what arrived is kept', res.body.includes('half'), res.body.slice(0, 120));
    ok('an error frame follows it', res.body.includes('event: error'), res.body.slice(-200));
    ok('and not a message_stop', !res.body.includes('message_stop'), res.body.slice(-200));
  }

  console.log('\n=== A ping is evidence the upstream is alive, not a courtesy ===');
  {
    /*
     * An upstream that says nothing at all. Pinging through that would answer the client's
     * liveness question on its behalf: the client stops counting, the gateway is the only
     * thing left that could end it, and with the bound off there would be nothing at all.
     */
    sse(() => {
      /* headers, then silence, until the idle bound ends it */
    });
    const res = await ask();
    ok('a silent upstream is not pinged for', !res.body.includes('event: ping'), res.body.slice(0, 120));
    ok('it is ended instead', res.body.includes('event: error'), res.body.slice(0, 160));
  }

  console.log('\n=== The untouched relay is pinged too, and only between frames ===');
  {
    // anthropic-native covers any endpoint speaking Messages, and only api.anthropic.com is
    // known to send pings of its own — so the arm that rewrites nothing needs them as well
    /*
     * One frame, then quiet, then the rest. The gap is what a ping is for: while the
     * upstream is chattering the bytes reach the client directly and nothing is needed.
     * The frames are CRLF, which nginx- and Spring-fronted upstreams emit — an endsWith
     * test on '\n\n' reads that as mid-frame and never pings again.
     */
    sse((res) => {
      res.write('event: content_block_delta\r\ndata: {"type":"content_block_delta"}\r\n\r\n');
      setTimeout(() => {
        res.write('event: message_stop\r\ndata: {"type":"message_stop"}\r\n\r\n');
        res.end();
      }, 420);
    });
    const res = await ask('native-model');
    const pings = res.body.match(/event: ping/g)?.length ?? 0;
    ok('CRLF frames do not stop the pings', pings > 0, res.body.slice(0, 200));
    /*
     * Exactly one, over three intervals of silence. A ping says the far end is alive, and
     * only the upstream can know that — so one is spent per thing actually heard. Pinging
     * on a timer instead answers the client's liveness question on the upstream's behalf,
     * and a hung connection becomes indistinguishable from a thinking one.
     */
    ok('and one heard chunk buys exactly one ping', pings === 1, String(pings));
    ok('and the upstream bytes are still relayed whole', res.body.includes('message_stop'), res.body.slice(-120));
    // A ping is a whole frame, so nothing it lands between can be cut in half
    ok('no frame was split by one', !/event: ping\r?\n[^\r\n]*\r?\ndata: \{"type": "content_block/.test(res.body));
  }

  console.log('\n=== A body that never finishes arriving is answered ===');
  {
    // The non-streaming branch: headers out, then a stall. It used to hold its slot for
    // good, and after the bound reached it, answer with an empty 200 — which nothing retries
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      res.write('{"choices":');
    };
    const res = await ask();
    ok('the status says it failed', res.statusCode === 504, String(res.statusCode));
    const out = JSON.parse(res.body) as { type?: string; error?: { message?: string } };
    ok('with a body the client can read', out.type === 'error' && Boolean(out.error?.message), res.body);
  }

  console.log('\n=== A refusal keeps its words and the shape of the wire ===');
  {
    // Relaying an OpenAI error object under a 200 hands an Anthropic client a body it parses
    // as a Message with no type, role or content
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: "model 'x' not found" } }));
    };
    const res = await ask();
    const out = JSON.parse(res.body) as { type?: string; error?: { message?: string } };
    ok('it arrives as an Anthropic error', out.type === 'error', res.body);
    ok('carrying what the upstream said', out.error?.message === "model 'x' not found", res.body);
  }

  console.log('\n=== A normal answer is untouched by any of it ===');
  {
    reply = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        model: 'local-model',
        choices: [{ message: { content: 'hello there' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }));
    };
    const res = await ask();
    const out = JSON.parse(res.body) as { type?: string; content?: Array<{ text?: string }> };
    ok('the client gets an Anthropic message', out.type === 'message', res.body);
    ok('carrying the text', out.content?.[0]?.text === 'hello there', res.body);
  }

  console.log('\n=== What the upstream said about waiting is passed on ===');
  {
    reply = (res) => {
      res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '42' });
      res.end(JSON.stringify({ error: { message: 'slow down' } }));
    };
    const res = await ask();
    // The gate is already holding the door for exactly this long; a client told nothing
    // falls back to its own short backoff and retries into a closed gate
    ok('retry-after reaches the client', res.headers['retry-after'] === '42', JSON.stringify(res.headers['retry-after']));
  }
}

try {
  await run();
} finally {
  // Cleanup outside the assertions: `ok()` never throws, so only a thrown error would have
  // leaked the temp database, the socket and the summary line the runner parses
  manager.close();
  upstream.close();
  await app.close();
  fs.rmSync(box, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

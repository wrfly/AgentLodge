/**
 * One live turn against Cursor, with everything shown.
 *
 * The bridge is built from the schema in the client's own bundle, and every shape in it is
 * read rather than guessed — but no amount of reading tells you whether Cursor's server
 * accepts *this* client on *this* RPC. That question needs one real request, and this is
 * it: the frames as they arrive, decoded, before any translation, and then the Chat
 * Completions stream the gateway would have produced from them.
 *
 * It is a debugging tool, not a test. Nothing here runs in CI — it needs a credential and
 * it spends a request against somebody's plan.
 *
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- "what is 2 + 2"
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --models
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --tools "list the files here"
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --model gpt-5 "hello"
 *
 * `--tools` declares one throwaway tool and asks for something that should use it, which is
 * the one behaviour a text-only probe cannot check: whether a caller's own tools reach the
 * model at all, and whether the call comes back where this bridge looks for it.
 */
import { accessToken } from './auth.js';
import { decode, encode, type Message } from './codec.js';
import { endOfStream, envelope, FrameReader } from './connect.js';
import { CHAT_RPC, CURSOR_API, fetchCursorModels } from './index.js';
import { buildChatRequest, type ChatRequest } from './request.js';
import { CursorToChat, PLAIN } from './stream.js';
import { BUNDLE_VERSION } from './schema.generated.js';
import crypto from 'node:crypto';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const key = process.env['CURSOR_API_KEY'] ?? '';
const base = process.env['CURSOR_API_BASE_URL'] ?? CURSOR_API;
const named = value('model');
const prompt = args.filter((a) => !a.startsWith('--') && a !== named).join(' ') || 'Say hello in five words.';

if (!key) {
  console.error('Set CURSOR_API_KEY to a key from cursor.com (Dashboard → API keys).');
  process.exit(1);
}

const short = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

async function models(): Promise<void> {
  const out = await fetchCursorModels(key, base);
  if (out.error) {
    console.error(`✗ ${out.error}`);
    process.exit(1);
  }
  console.log(`✓ ${out.models.length} models\n  ${out.models.join('\n  ')}`);
}

/**
 * Which model to ask for.
 *
 * Asked rather than assumed when nobody said: Cursor's names are its own
 * (`claude-4.6-opus-high-fast`), they change, and a guess that is merely stale fails in a
 * way that looks exactly like the bridge being wrong — which is the one confusion a probe
 * must not introduce.
 */
async function pickModel(): Promise<string> {
  if (named) return named;
  const out = await fetchCursorModels(key, base);
  if (out.error || !out.models.length) {
    throw new Error(`${out.error ?? 'no models'} — pass --model <name> to ask anyway`);
  }
  const choice = out.models.find((m) => m.includes('sonnet')) ?? out.models[0]!;
  console.log(`  (no --model given; using ${choice}, of ${out.models.length} available)`);
  return choice;
}

async function turn(): Promise<void> {
  const model = await pickModel();
  const body: ChatRequest = {
    model,
    messages: [
      { role: 'system', content: 'You are a probe. Answer briefly.' },
      { role: 'user', content: prompt },
    ],
    ...(flag('tools')
      ? {
          tools: [
            {
              function: {
                name: 'list_files',
                description: 'List the files in a directory',
                parameters: {
                  type: 'object',
                  properties: { path: { type: 'string', description: 'the directory' } },
                  required: ['path'],
                },
              },
            },
          ],
        }
      : {}),
  };

  const message = buildChatRequest(body, { model, conversationId: crypto.randomUUID() });
  console.log(`→ ${base}${CHAT_RPC}`);
  console.log(`  model ${model}, ${(message['conversation'] as Message[]).length} turns, `
    + `${((message['mcp_tools'] as Message[]) ?? []).length} tools, schema from ${BUNDLE_VERSION}\n`);

  const token = await accessToken(key, base);
  const started = Date.now();
  const res = await fetch(`${base}${CHAT_RPC}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/connect+proto',
      'connect-protocol-version': '1',
      'x-cursor-client-type': 'cli',
      'x-cursor-client-version': `cli-${BUNDLE_VERSION}`,
      'x-request-id': crypto.randomUUID(),
      'x-ghost-mode': 'true',
    },
    body: envelope(encode('aiserver.v1.StreamUnifiedChatRequest', message)),
  });

  console.log(`← HTTP ${res.status} ${res.headers.get('content-type') ?? ''}`);
  if (!res.ok || !res.body) {
    console.error(`✗ ${short(await res.text().catch(() => ''), 1000)}`);
    process.exit(1);
  }

  const reader = res.body.getReader();
  const frames = new FrameReader();
  const bridge = new CursorToChat({ model, promptChars: JSON.stringify(body).length, responseType: PLAIN });
  const raw: Uint8Array[] = [];
  let count = 0;
  const seen = new Set<string>();

  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done || !chunk) break;
    raw.push(chunk);
    for (const f of frames.push(chunk)) {
      const end = endOfStream(f);
      if (end) {
        console.log(`\n--- end of stream ---\n${JSON.stringify(end, null, 2)}`);
        continue;
      }
      count++;
      const decoded = decode('aiserver.v1.StreamUnifiedChatResponse', f.payload);
      for (const k of Object.keys(decoded)) seen.add(k);
      // Text arrives one small frame at a time; printing every one buries everything else
      if (Object.keys(decoded).length === 1 && typeof decoded['text'] === 'string') continue;
      console.log(`  frame ${count}: ${short(JSON.stringify(decoded))}`);
    }
  }
  console.log(`\n--- ${count} frames in ${Date.now() - started}ms; fields seen: ${[...seen].join(', ') || 'none'} ---`);

  // The same bytes through the bridge: this is what the gateway would have relayed
  const sse = raw.map((chunk) => bridge.push(chunk)).join('') + bridge.end();
  console.log(`\n--- as the relay would see it ---\n${sse.trim() || '(nothing)'}`);
}

try {
  await (flag('models') ? models() : turn());
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}

/**
 * One live turn against Cursor, with everything shown.
 *
 * The bridge is built from the schema in the CLI's own bundle, and every shape in it is read
 * rather than guessed — but no amount of reading tells you whether Cursor's server accepts
 * *this* client on *these* RPCs. That question needs one real request, and this is it.
 *
 * It is a debugging tool, not a test. Nothing here runs in CI — it needs a credential and it
 * spends a request against somebody's plan.
 *
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --models
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- "what is 2 + 2"
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --tools "search for cursor's rpc"
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --raw "hello"
 *   CURSOR_API_KEY=key_… npm -w @agentlodge/server run cursor:probe -- --model gpt-5.2 "hello"
 *
 * `--tools` declares one throwaway tool and asks for something that should use it, which is
 * the behaviour a text-only probe cannot check: whether a caller's own tools reach the model
 * at all, and whether the call comes back where this bridge looks for it. It also answers
 * whatever Cursor asks the client to do — read a file, run a command — with canned text, so
 * the tool loop is driven end to end in one process rather than across two requests.
 *
 * `--raw` skips the session and prints each decoded `AgentServerMessage` instead, which is
 * what to reach for when something arrives that the bridge does not recognise.
 */
import { accessToken } from './auth.js';
import { BidiStream } from './bidi.js';
import { decode, type Message } from './codec.js';
import { endOfStream } from './connect.js';
import { clientHeaders, CURSOR_AGENT_API, CURSOR_API, fetchCursorModels } from './index.js';
import { resolveModel } from './catalog.js';
import { buildRunRequest, type ChatRequest } from './request.js';
import { AgentSession } from './session.js';
import { BUNDLE_VERSION } from './schema.generated.js';
import { ChatStream } from './stream.js';

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

const key = process.env['CURSOR_API_KEY'] ?? '';
const base = process.env['CURSOR_API_BASE_URL'] ?? CURSOR_API;
const agentBase = process.env['CURSOR_AGENT_BASE_URL'] ?? CURSOR_AGENT_API;
const named = value('model');
const prompt = args.filter((a) => !a.startsWith('--') && a !== named).join(' ') || 'Say hello in five words.';

if (!key) {
  console.error('Set CURSOR_API_KEY to a key from cursor.com (Dashboard → API keys).');
  process.exit(1);
}

const short = (s: string, n = 300): string => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One throwaway tool, for the run that checks whether a caller's tools arrive at all */
const TOOLS: ChatRequest['tools'] = [
  {
    function: {
      name: 'lookup',
      description: 'Look a term up in the local glossary. Use it whenever you are asked to search for something.',
      parameters: {
        type: 'object',
        properties: { term: { type: 'string', description: 'What to look up' } },
        required: ['term'],
      },
    },
  },
];

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
 * Cursor's names are its own and they move, so a stale guess fails in the way that looks
 * exactly like the bridge being wrong — the one confusion a probe must not introduce. With no
 * --model it asks first and says which it picked.
 */
async function pickModel(): Promise<string> {
  if (named) return named;
  const out = await fetchCursorModels(key, base);
  if (out.error || !out.models.length) {
    console.error(`✗ could not ask which models exist (${out.error ?? 'empty list'})`);
    process.exit(1);
  }
  const preferred = out.models.find((m) => m.startsWith('composer')) ?? out.models[0]!;
  console.log(`· using ${preferred} (of ${out.models.length}; pass --model to choose)`);
  return preferred;
}

async function stream(): Promise<void> {
  const model = await pickModel();
  const tools = flag('tools') ? TOOLS : undefined;
  const token = await accessToken(key, base);

  /*
   * The resolution is half of what this probe is for. A slug names a variant of a model, and
   * `from` says whether Cursor's own catalogue was asked or whether the suffixes were read —
   * a model sent as a guess is the difference between an effort level and a silent default.
   */
  const resolved = await resolveModel(model, {
    secret: key,
    baseUrl: base,
    headers: (requestId) => clientHeaders(token, requestId),
  });
  const { request, delegate } = buildRunRequest(
    { messages: [{ role: 'user', content: prompt }], tools },
    { model: resolved },
  );

  const shown = resolved.parameters.map((p) => `${p['id']}=${p['value']}`).join(', ');
  console.log(`· cursor-agent ${BUNDLE_VERSION}`);
  console.log(`· ${model} → model_id ${resolved.id}${shown ? ` (${shown})` : ''}${resolved.max ? ' max_mode' : ''}, from the ${resolved.from}`);
  console.log(`· ${delegate ? 'agent' : 'asked'} turn, ${tools?.length ?? 0} tools declared\n`);
  const controller = new AbortController();
  const session = new AgentSession({
    apiBase: base,
    agentBase,
    token,
    headers: (requestId) => clientHeaders(token, requestId),
    egress: (url) => ({ url, headers: {} }),
    signal: controller.signal,
    workspace: process.cwd(),
    delegate: Boolean(tools),
  });

  const out = new ChatStream(model);
  const events = session.run(request);
  let sse = '';

  for (;;) {
    const step = await events.next();
    if (step.done) break;
    const event = step.value;

    if (event.kind === 'text') {
      process.stdout.write(event.text);
      sse += out.text(event.text);
      continue;
    }
    if (event.kind === 'tool') {
      console.log(`\n\n← tool ${event.name} ${JSON.stringify(event.input)}`);
      sse += out.tool(event.callId, event.name, event.input);
      /*
       * A real client would answer this in the next request, and the turn would be parked in
       * between. Answered here instead, so one run shows the whole loop.
       */
      const answer = `(probe) pretend result for ${event.name}`;
      console.log(`→ ${answer}\n`);
      await session.submit(event.callId, answer);
      continue;
    }
    if (event.kind === 'error') {
      console.error(`\n\n✗ ${event.message}${event.status ? ` (${event.status})` : ''}`);
      sse += out.error(event.message);
      await session.close();
      process.exit(1);
    }

    console.log('\n');
    if (event.usage) {
      console.log(
        `· ${event.usage.input} in, ${event.usage.output} out`
        + `, ${event.usage.cacheRead} cache read, ${event.usage.cacheWrite} cache write`
        + `, ${event.usage.reasoning} reasoning`,
      );
    } else {
      console.log('· the turn ended without reporting usage');
    }
    sse += out.done(event.usage);
    break;
  }

  await session.close();
  console.log('\n--- as the gateway would relay it ---');
  for (const line of sse.trim().split('\n\n')) console.log(short(line));
}

/** Every frame, decoded, with nothing interpreted */
async function raw(): Promise<void> {
  const model = await pickModel();
  const token = await accessToken(key, base);
  const resolved = await resolveModel(model, {
    secret: key,
    baseUrl: base,
    headers: (requestId) => clientHeaders(token, requestId),
  });
  const { request } = buildRunRequest({ messages: [{ role: 'user', content: prompt }] }, { model: resolved });
  const controller = new AbortController();
  const stream = new BidiStream({
    apiBase: base,
    agentBase,
    token,
    headers: (requestId) => clientHeaders(token, requestId),
    egress: (url) => ({ url, headers: {} }),
    signal: controller.signal,
  });

  await stream.open(request);
  console.log(`· request ${stream.requestId}\n`);
  let count = 0;
  for await (const frame of stream.read()) {
    const end = endOfStream(frame);
    if (end) {
      console.log(`[trailer] ${JSON.stringify(end)}`);
      break;
    }
    count++;
    let message: Message;
    try {
      message = decode('agent.v1.AgentServerMessage', frame.payload);
    } catch (e) {
      console.log(`[${count}] undecodable (${(e as Error).message}), ${frame.payload.length} bytes`);
      continue;
    }
    for (const [name, body] of Object.entries(message)) {
      console.log(`[${count}] ${name} ${short(JSON.stringify(body, replacer), 400)}`);
    }
  }
  await stream.close();
  console.log(`\n· ${count} frames, ${stream.pending} bytes held back`);
}

/** Bytes print as their length rather than as a list of numbers */
const replacer = (_k: string, v: unknown): unknown =>
  v instanceof Uint8Array ? `<${v.length} bytes>` : typeof v === 'bigint' ? String(v) : v;

try {
  if (flag('models')) await models();
  else if (flag('raw')) await raw();
  else await stream();
} catch (e) {
  console.error(`\n✗ ${(e as Error).message}`);
  process.exit(1);
}

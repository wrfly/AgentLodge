/**
 * A Cursor upstream, driven through the gateway the way a CLI drives it.
 *
 * The unit tests cover each half of the bridge; this covers the seam none of them can — a real
 * request through buildGateway(), resolved to a `cursor` provider, authenticated by exchanging
 * a key, posted through BidiAppend, answered over RunSSE in protobuf, and translated back into
 * whichever protocol asked. Both CLIs are driven, because "both CLIs work against Cursor" is
 * the claim the whole design rests on and it is the kind that quietly stops being true.
 *
 * The upstream here is an ordinary http server speaking Cursor's agent protocol, and it
 * answers rather than replays: it asks the client for workspace context, stores a blob and
 * asks for it back, and asks for a file to be read — so the tool loop, which is the part that
 * spans two client requests, is exercised rather than described.
 *
 * Run: npm -w @agentlodge/server run test:cursor-relay
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { decodeAppend } from './bidi.js';
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

const SERVER = 'agent.v1.AgentServerMessage';

/** One server message, framed as Connect wants it */
const frame = (body: Message): Uint8Array => envelope(encode(SERVER, body));
const trailer = (body: unknown = {}): Uint8Array =>
  envelope(new TextEncoder().encode(JSON.stringify(body)), FLAG_END_STREAM);

const text = (t: string): Uint8Array => frame({ interaction_update: { text_delta: { text: t } } });
const ended = (usage: Record<string, number>): Uint8Array => frame({ interaction_update: { turn_ended: usage } });

/* ---------------- The upstream ---------------- */

/**
 * The catalogue, in the shape a real account answers with.
 *
 * Taken from a live `AvailableModels`: a model is a base name plus a table of variants, and a
 * slug like `claude-opus-5-thinking-high` selects one of them. The names and the shape are
 * real; `cursor-model` is the row this test's provider offers.
 */
const CATALOG: Message = {
  models: [
    {
      name: 'cursor-model',
      variants: [
        { variant_string_representation: 'cursor-model', is_default_non_max_config: true, parameter_values: [] },
      ],
    },
    {
      name: 'claude-opus-5',
      legacy_slugs: ['claude-opus-4-6'],
      variants: [
        {
          variant_string_representation: 'claude-opus-5-high',
          is_default_non_max_config: true,
          parameter_values: [{ id: 'effort', value: 'high' }],
        },
        {
          variant_string_representation: 'claude-opus-5-thinking-high',
          parameter_values: [{ id: 'thinking', value: 'true' }, { id: 'effort', value: 'high' }],
        },
        {
          // The one a suffix reading gets wrong: `-max` is an effort here, and max mode is
          // its own field that this variant happens not to set
          variant_string_representation: 'claude-opus-5-thinking-max',
          parameter_values: [{ id: 'thinking', value: 'true' }, { id: 'effort', value: 'max' }],
        },
      ],
    },
    {
      name: 'composer-2.5-fast',
      variants: [{ variant_string_representation: 'composer-2.5-fast', parameter_values: [] }],
    },
  ],
};

/** What the client has said so far, in order */
let said: Message[] = [];
/** How many times the catalogue was asked for, which should not be once per turn */
let modelCalls = 0;
/** What the upstream does each time the client says something */
let script: (message: Message, push: (bytes: Uint8Array) => void) => void = () => {};
let seen: {
  runSSE?: string;
  append?: string;
  auth?: string;
  clientType?: string;
  requestId?: string;
  /** Every header of the last call on each RPC, for the ones the capture settled */
  runHeaders?: Record<string, string>;
  appendHeaders?: Record<string, string>;
} = {};
let exchanges = 0;

/**
 * The open RunSSE response, and anything written before it was open.
 *
 * The two calls race by design — the bridge posts the first message and opens the stream
 * without awaiting either first — so the script can produce frames before there is anywhere
 * to put them. They are held, and `closing` remembers that the stream was finished while it
 * was still queued: leaving that response open instead holds a gate slot for the rest of the
 * run, which starves every later scenario.
 */
let open: http.ServerResponse | undefined;
let queued: Uint8Array[] = [];
let closing = false;

function push(bytes: Uint8Array): void {
  if (open) open.write(Buffer.from(bytes));
  else queued.push(bytes);
}

/** Flush what was held and close the response if the script already asked to */
function attach(res: http.ServerResponse): void {
  open = res;
  for (const bytes of queued) res.write(Buffer.from(bytes));
  queued = [];
  if (closing) closeStream();
}

function closeStream(): void {
  closing = true;
  if (!open) return;
  open.end();
  open = undefined;
  closing = false;
}

/** The ordinary ending: a clean trailer, then the stream closed */
function endStream(): void {
  push(trailer());
  closeStream();
}

const cursor = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const body = Buffer.concat(chunks);
    seen.auth = req.headers.authorization;
    seen.clientType = req.headers['x-cursor-client-type'] as string | undefined;

    if (req.url === '/auth/exchange_user_api_key') {
      exchanges++;
      res.writeHead(200, { 'content-type': 'application/json' });
      // A JWT-shaped token with an hour on it, so the cache behaves as it would live
      const payload = Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url');
      res.end(JSON.stringify({ accessToken: `ey.${payload}.sig`, refreshToken: 'refresh' }));
      return;
    }

    if (req.url === '/aiserver.v1.BidiService/BidiAppend') {
      seen.append = req.url;
      seen.appendHeaders = req.headers as Record<string, string>;
      const { message, requestId } = decodeAppend(new Uint8Array(body));
      seen.requestId = requestId;
      said.push(message);
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end(Buffer.from(encode('aiserver.v1.BidiAppendResponse', {})));
      script(message, push);
      return;
    }

    if (req.url === '/agent.v1.AgentService/RunSSE') {
      seen.runSSE = req.url;
      seen.runHeaders = req.headers as Record<string, string>;
      // The id is the one the appends carry, sent as this call's only message
      const asked = decode('aiserver.v1.BidiRequestId', new Uint8Array(body.subarray(5)));
      if (String(asked['request_id'] ?? '') !== seen.requestId && seen.requestId) {
        res.writeHead(400).end('request id mismatch');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      attach(res);
      return;
    }

    if (req.url === '/aiserver.v1.AiService/AvailableModels') {
      modelCalls++;
      res.writeHead(200, { 'content-type': 'application/proto' });
      res.end(Buffer.from(encode('aiserver.v1.AvailableModelsResponse', CATALOG)));
      return;
    }

    res.writeHead(404).end();
  });
});
await new Promise<void>((r) => cursor.listen(0, '127.0.0.1', r));
const cursorUrl = `http://127.0.0.1:${(cursor.address() as { port: number }).port}`;

/** Reset between scenarios, so one turn's leftovers cannot answer the next */
function reset(next: typeof script): void {
  said = [];
  queued = [];
  closing = false;
  open?.end();
  open = undefined;
  seen = { ...seen, requestId: undefined };
  script = next;
}

const { initDb } = await import('../../core/db/index.js');
initDb();
const users = await import('../../core/db/users.js');
const providers = await import('../../core/db/providers.js');
const models = await import('../../core/db/models.js');
const usage = await import('../../core/db/usage.js');
const { signRuntimeToken } = await import('../../core/runtime-token.js');
const { buildGateway } = await import('../index.js');
const { fetchCursorModels } = await import('./index.js');
const catalog = await import('./catalog.js');
const { splitModel } = await import('./request.js');
const turns = await import('./turns.js');

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

/** The run request out of whatever the client has said, for asserting on what went out */
const runRequest = (): Message => said.map((m) => m['run_request'] as Message).find(Boolean) ?? {};

/** Whichever client message carries this field, decoded */
const sentWith = (field: string): Message | undefined =>
  said
    .map((m) => (m['exec_client_message'] ?? m['kv_client_message'] ?? m['exec_client_control_message']) as Message)
    .filter(Boolean)
    .find((m) => m[field] !== undefined);

const TOOLS = [{ name: 'Search', description: 'search the web', input_schema: { type: 'object' } }];

const asClaude = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { model: 'cursor-model', max_tokens: 1024, ...payload },
  });

const asCodex = (payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/v1/responses',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { model: 'cursor-model', ...payload },
  });

async function run(): Promise<void> {
  console.log('\n=== Claude Code gets an answer out of a Cursor upstream ===');
  {
    reset((message, out) => {
      if (!message['run_request']) return;
      out(text('four'));
      out(ended({ input_tokens: 120, output_tokens: 8, cache_read_tokens: 30 }));
      endStream();
    });

    const res = await asClaude({ system: 'be brief', messages: [{ role: 'user', content: 'what is 2 + 2' }] });

    ok('the turn succeeds', res.statusCode === 200, String(res.statusCode));
    ok('the key was exchanged for a token', exchanges === 1, String(exchanges));
    ok('which is what authenticates the call', seen.auth?.startsWith('Bearer ey.') === true, seen.auth);
    ok('the turn is read back over RunSSE', seen.runSSE === '/agent.v1.AgentService/RunSSE', seen.runSSE);
    ok('and each message goes out through BidiAppend', seen.append === '/aiserver.v1.BidiService/BidiAppend', seen.append);
    ok('we present as the client the credential belongs to', seen.clientType === 'cli', seen.clientType);

    /*
     * The headers a capture of the real `cursor-agent` shows on these two calls, and the one
     * it does not. The checksum in particular used to be sent and was this process inventing
     * a machine identity it does not have.
     */
    ok('both calls carry the turn id apart from the stream id', seen.runHeaders?.['x-original-request-id'] === seen.appendHeaders?.['x-original-request-id'], JSON.stringify([seen.runHeaders?.['x-original-request-id'], seen.appendHeaders?.['x-original-request-id']]));
    ok('which is not the id that joins them', seen.runHeaders?.['x-original-request-id'] !== seen.requestId, String(seen.requestId));
    ok('the agent transport says it is streaming', seen.runHeaders?.['x-cursor-streaming'] === 'true', JSON.stringify(seen.runHeaders));
    ok('and no machine checksum is invented', seen.runHeaders?.['x-cursor-checksum'] === undefined, JSON.stringify(seen.runHeaders));

    ok('the client is answered in Anthropic frames', res.body.includes('event: message_start'), res.body.slice(0, 200));
    ok('carrying the text', res.body.includes('four'), res.body);
    ok('and a stop reason', res.body.includes('"stop_reason":"end_turn"'), res.body);

    const sent = runRequest();
    const message = ((sent['action'] as Message)?.['user_message_action'] as Message)?.['user_message'] as Message;
    ok('the question travelled as the prompt', String(message?.['text']).includes('what is 2 + 2'), JSON.stringify(message));
    ok('the system prompt travelled as a custom one', sent['custom_system_prompt'] === 'be brief', String(sent['custom_system_prompt']));
    ok('the model name is the one the row names', (sent['requested_model'] as Message)?.['model_id'] === 'cursor-model');
    ok('and with no tools of its own the caller gets an asked turn', message?.['mode'] === 2, String(message?.['mode']));
  }

  console.log('\n=== The token is not exchanged again for the next turn ===');
  {
    reset((message, out) => {
      if (!message['run_request']) return;
      out(text('still four'));
      out(ended({ input_tokens: 10, output_tokens: 3 }));
      endStream();
    });
    await asClaude({ messages: [{ role: 'user', content: 'again' }] });
    ok('one exchange has served both turns', exchanges === 1, String(exchanges));
  }

  console.log('\n=== The turn is booked from the counts Cursor reported ===');
  {
    const totals = usage.totalsForUser(user.id);
    // 120 fresh + 30 cached in the first turn, 10 in the second
    ok('fresh input is counted', totals.inputTokens === 130, JSON.stringify(totals));
    ok('cache reads are counted apart from it', totals.cacheReadTokens === 30, JSON.stringify(totals));
    ok('output is counted', totals.outputTokens === 11, JSON.stringify(totals));
    ok(
      'and it is attributed to this upstream',
      usage.byUpstreamForUser(user.id).some((u) => u.providerId === provider.id),
      JSON.stringify(usage.byUpstreamForUser(user.id)),
    );
  }

  console.log('\n=== The housekeeping a turn does not progress without ===');
  {
    const blobId = new Uint8Array([1, 2, 3]);
    const blob = new TextEncoder().encode('the conversation so far');
    reset((message, out) => {
      if (message['run_request']) {
        out(frame({ exec_server_message: { id: 1, exec_id: 'e1', request_context_args: { use_cached: false } } }));
        return;
      }
      const exec = message['exec_client_message'] as Message | undefined;
      if (exec?.['request_context_result']) {
        out(frame({ kv_server_message: { id: 2, set_blob_args: { blob_id: blobId, blob_data: blob } } }));
        return;
      }
      const kv = message['kv_client_message'] as Message | undefined;
      if (kv?.['set_blob_result']) {
        out(frame({ kv_server_message: { id: 3, get_blob_args: { blob_id: blobId } } }));
        return;
      }
      if (kv?.['get_blob_result']) {
        out(text('context in hand'));
        out(ended({ input_tokens: 1, output_tokens: 1 }));
        endStream();
      }
    });

    const res = await asClaude({ messages: [{ role: 'user', content: 'go' }] });
    const context = sentWith('request_context_result')?.['request_context_result'] as Message;
    const env = ((context?.['success'] as Message)?.['request_context'] as Message)?.['env'] as Message;
    ok('the workspace question is answered', Boolean(env), JSON.stringify(context));
    ok('with somewhere to be', Array.isArray(env?.['workspace_paths']), JSON.stringify(env?.['workspace_paths']));

    const returned = sentWith('get_blob_result')?.['get_blob_result'] as Message;
    ok('a blob the server stored comes back byte for byte', Buffer.from((returned?.['blob_data'] as Uint8Array) ?? []).equals(Buffer.from(blob)), JSON.stringify(returned));
    ok('and the turn gets to its answer', res.body.includes('context in hand'), res.body);
  }

  console.log("\n=== Cursor asks the caller to read a file, across two requests ===");
  {
    reset((message, out) => {
      if (message['run_request']) {
        out(text('let me look'));
        out(frame({ exec_server_message: { id: 7, exec_id: 'e7', pi_read_args: { path: '/repo/a.ts' } } }));
        return;
      }
      const exec = message['exec_client_message'] as Message | undefined;
      if (exec?.['pi_read_result']) {
        out(text('it exports a'));
        out(ended({ input_tokens: 5, output_tokens: 4 }));
        endStream();
      }
    });

    const first = await asClaude({ messages: [{ role: 'user', content: 'what does a.ts do' }], tools: TOOLS });
    ok('the text so far reaches the client', first.body.includes('let me look'), first.body);
    ok("Cursor's own request becomes a tool_use block", first.body.includes('"type":"tool_use"'), first.body);
    ok("named after the caller's own tool", first.body.includes('"name":"Read"'), first.body);
    ok('with the path it asked for', first.body.includes('/repo/a.ts'), first.body);
    ok('and the turn stops for the tool', first.body.includes('"stop_reason":"tool_use"'), first.body);
    ok('the turn is parked rather than dropped', turns.parkedCount() === 1, String(turns.parkedCount()));

    const callId = /"id":"([^"]+)","name":"Read"/.exec(first.body)?.[1] ?? '';
    ok('the call has an id to answer under', callId.length > 0, first.body);

    const second = await asClaude({
      messages: [
        { role: 'user', content: 'what does a.ts do' },
        { role: 'assistant', content: [{ type: 'tool_use', id: callId, name: 'Read', input: { file_path: '/repo/a.ts' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: callId, content: 'export const a = 1' }] },
      ],
      tools: TOOLS,
    });

    const answered = sentWith('pi_read_result')?.['pi_read_result'] as Message;
    ok("the caller's result reaches Cursor", String((answered?.['success'] as Message)?.['output']) === 'export const a = 1', JSON.stringify(answered));
    ok('no second turn was started', said.filter((m) => m['run_request']).length === 1, String(said.filter((m) => m['run_request']).length));
    ok('the answer continues the same turn', second.body.includes('it exports a'), second.body);
    ok('which now finishes', second.body.includes('"stop_reason":"end_turn"'), second.body);
    ok('and nothing is left parked', turns.parkedCount() === 0, String(turns.parkedCount()));
  }

  console.log("\n=== A tool the caller declared is called by name ===");
  {
    reset((message, out) => {
      if (message['run_request']) {
        out(frame({
          exec_server_message: {
            id: 9,
            exec_id: 'e9',
            mcp_args: { name: 'client__Search', tool_name: 'client__Search', tool_call_id: 'mcp-1', args: { query: { string_value: 'cursor rpc' } } },
          },
        }));
        return;
      }
      const exec = message['exec_client_message'] as Message | undefined;
      if (exec?.['mcp_result']) {
        out(text('found it'));
        out(ended({ input_tokens: 2, output_tokens: 2 }));
        endStream();
      }
    });

    const first = await asClaude({ messages: [{ role: 'user', content: 'look it up' }], tools: TOOLS });
    ok('it is offered to Cursor under a prefixed name', ((runRequest()['mcp_tools'] as Message)?.['mcp_tools'] as Message[])?.[0]?.['name'] === 'client__Search');
    ok('and comes back to the caller under its own', first.body.includes('"name":"Search"'), first.body);
    ok('with the arguments Cursor chose', first.body.includes('cursor rpc'), first.body);

    const second = await asClaude({
      messages: [
        { role: 'user', content: 'look it up' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'mcp-1', name: 'Search', input: { query: 'cursor rpc' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'mcp-1', content: 'an rfc' }] },
      ],
      tools: TOOLS,
    });
    const result = sentWith('mcp_result')?.['mcp_result'] as Message;
    const block = ((result?.['success'] as Message)?.['content'] as Message[])?.[0];
    ok("the caller's answer goes back as MCP content", String((block?.['text'] as Message)?.['text']) === 'an rfc', JSON.stringify(result));
    ok('and the turn carries on', second.body.includes('found it'), second.body);
  }

  console.log('\n=== A request nothing here can run is refused, not left hanging ===');
  {
    reset((message, out) => {
      if (message['run_request']) {
        /*
         * `grep_args` as raw bytes, because it is not in the tables — which is the point: this
         * is a request the bridge can see the shape of and not answer.
         */
        out(frame({ exec_server_message: { id: 11, exec_id: 'e11', grep_args: new Uint8Array(0) } }));
        return;
      }
      if (message['exec_client_control_message']) {
        out(text('never mind'));
        out(ended({ input_tokens: 1, output_tokens: 1 }));
        endStream();
      }
    });

    const res = await asClaude({ messages: [{ role: 'user', content: 'find the todos' }], tools: TOOLS });
    const thrown = sentWith('throw')?.['throw'] as Message;
    ok('the exec is thrown rather than ignored', Boolean(thrown), JSON.stringify(said));
    ok('under the id that asked', Number(thrown?.['id']) === 11, JSON.stringify(thrown));
    ok('and the turn gets to finish', res.body.includes('never mind'), res.body);
  }

  console.log('\n=== Codex gets the same upstream as a Responses stream ===');
  {
    reset((message, out) => {
      if (!message['run_request']) return;
      out(text('four'));
      out(ended({ input_tokens: 9, output_tokens: 1 }));
      endStream();
    });

    const res = await asCodex({
      instructions: 'be brief',
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'what is 2 + 2' }] }],
    });
    ok('the turn succeeds', res.statusCode === 200, String(res.statusCode));
    ok('it opens as a response', res.body.includes('event: response.created'), res.body.slice(0, 200));
    ok('the text arrives as output_text', res.body.includes('response.output_text.delta') && res.body.includes('four'), res.body);
    ok('and it completes', res.body.includes('event: response.completed'), res.body);
    ok('the instructions travelled as the system prompt', runRequest()['custom_system_prompt'] === 'be brief', String(runRequest()['custom_system_prompt']));
  }

  console.log('\n=== A slug is resolved through the catalogue, not off the end of itself ===');
  {
    catalog.forget();
    modelCalls = 0;
    const options = {
      secret: 'cursor-api-key-cursor',
      baseUrl: cursorUrl,
      headers: (requestId: string) => ({ 'x-request-id': requestId }),
    };

    const thinking = await catalog.resolveModel('claude-opus-5-thinking-high', options);
    ok('a variant resolves to its base model', thinking.id === 'claude-opus-5', JSON.stringify(thinking));
    ok('carrying the parameters the table gives it', JSON.stringify(thinking.parameters) === '[{"id":"thinking","value":"true"},{"id":"effort","value":"high"}]', JSON.stringify(thinking.parameters));
    ok('and it is a fact rather than a guess', thinking.from === 'catalog');

    // The case the suffix reading gets wrong: `-max` is an effort level on this model, and
    // max mode is a separate field the variant does not set
    const max = await catalog.resolveModel('claude-opus-5-thinking-max', options);
    ok('`-max` is whatever the table says it is', max.max === false && max.id === 'claude-opus-5', JSON.stringify(max));
    ok('which the suffix reading gets wrong on its own', splitModel('claude-opus-5-thinking-max').max === true);

    const legacy = await catalog.resolveModel('claude-opus-4-6', options);
    ok('a name the model used to have still resolves', legacy.id === 'claude-opus-5', JSON.stringify(legacy));

    const fast = await catalog.resolveModel('composer-2.5-fast', options);
    ok('a suffix that is part of the name is left alone', fast.id === 'composer-2.5-fast' && fast.parameters.length === 0, JSON.stringify(fast));

    ok('the catalogue is asked once and held', modelCalls === 1, String(modelCalls));

    const unknown = await catalog.resolveModel('some-model-cursor-never-heard-of-high', options);
    ok('a slug it has never heard of falls back to the suffixes', unknown.from === 'suffix', JSON.stringify(unknown));
    ok('and keeps what that can work out', unknown.id === 'some-model-cursor-never-heard-of', JSON.stringify(unknown));
  }

  console.log('\n=== The model list is every slug the account can choose ===');
  {
    catalog.forget();
    const out = await fetchCursorModels('cursor-api-key-cursor', cursorUrl);
    ok(
      'the variants are listed, not just the base names',
      out.models.includes('claude-opus-5-thinking-high') && out.models.includes('claude-opus-5'),
      JSON.stringify(out),
    );
    ok('a legacy name is offered too', out.models.includes('claude-opus-4-6'), JSON.stringify(out.models));
  }

  console.log('\n=== A turn resolves its model before sending it ===');
  {
    catalog.forget();
    reset((message, out) => {
      if (!message['run_request']) return;
      out(text('resolved'));
      out(ended({ input_tokens: 1, output_tokens: 1 }));
      endStream();
    });
    await asClaude({ messages: [{ role: 'user', content: 'go' }] });
    const requested = runRequest()['requested_model'] as Message;
    ok('the model that went out is the resolved one', requested?.['model_id'] === 'cursor-model', JSON.stringify(requested));
  }
  /*
   * Last, because it leaves the provider in cooldown. A `resource_exhausted` refusal reaches
   * the client as a 429, which is the point — the gate reads the status and halves the
   * concurrency it will allow. Any gated scenario after this one would be queueing behind
   * that backoff rather than testing what it set out to.
   */
  console.log('\n=== What Cursor refuses, the client is told ===');
  {
    reset((message, out) => {
      if (!message['run_request']) return;
      out(trailer({ error: { code: 'resource_exhausted', message: 'you have run out of fast requests' } }));
      closeStream();
    });

    const res = await asClaude({ messages: [{ role: 'user', content: 'again' }] });
    // Refused before a byte of the answer, so it can still be a status — which is what the
    // client retries on and what the gate reads to decide whether to back off
    ok('the Connect code becomes the status that means it', res.statusCode === 429, String(res.statusCode));
    ok("Cursor's own sentence reaches the client", res.body.includes('you have run out of fast requests'), res.body);
    ok('and the turn is not closed as a finished answer', !res.body.includes('message_stop'), res.body);
  }

}

try {
  await run();
} finally {
  turns.clear();
  catalog.forget();
  closeStream();
  cursor.close();
  manager.close();
  fs.rmSync(box, { recursive: true, force: true });
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

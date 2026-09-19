/**
 * The Cursor bridge, piece by piece and without a network.
 *
 * Each half of the bridge on its own: the codec against its own bytes, the framing against
 * whatever boundaries TCP chose, the request builder, the tool bridge both ways, and the
 * stream writer. The seam they meet at is relay.test.ts, which drives the whole thing through
 * buildGateway() against a server speaking the real protocol.
 *
 * Run: npm -w @agentlodge/server run test:cursor
 */
import http2 from 'node:http2';
import { isErrorBody } from '../translate.js';
import { decodeAppend } from './bidi.js';
import { buildCatalog, undated } from './catalog.js';
import { decode, encode, oneofOf, type Message } from './codec.js';
import { endOfStream, envelope, FrameReader, FLAG_END_STREAM } from './connect.js';
import { EXEC_TOOLS, shellStream, toolFor } from './exec-bridge.js';
import { needsHttp2, postHttp2 } from './h2.js';
import { argsOf, clientName, fromValue, toDefinitions, toValue, wireName } from './mcp.js';
import { buildRunRequest, flatten, parseSlug, splitModel, toolResults, type ChatRequest } from './request.js';
import { MESSAGES } from './schema.generated.js';
import { ChatStream } from './stream.js';
import * as turns from './turns.js';

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

const CLIENT = 'agent.v1.AgentClientMessage';
const SERVER = 'agent.v1.AgentServerMessage';
const RUN_REQUEST = 'agent.v1.AgentRunRequest';

const roundTrip = (type: string, body: Message): Message => decode(type, encode(type, body));

/** A model already resolved, which is what buildRunRequest takes — see catalog.ts */
const asModel = (id: string, parameters: Message[] = [], max = false) => ({ id, parameters, max });

/** One server message, as Cursor would put it on the wire */
const frame = (body: Message): Uint8Array => envelope(encode(SERVER, body));

const trailer = (body: unknown = {}): Uint8Array =>
  envelope(new TextEncoder().encode(JSON.stringify(body)), FLAG_END_STREAM);

const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

/** Every `data:` payload of an SSE text, parsed */
function events(sse: string): Array<Record<string, unknown>> {
  return sse
    .split('\n')
    .filter((l) => l.startsWith('data:'))
    .map((l) => l.slice(5).trim())
    .filter((p) => p && p !== '[DONE]')
    .map((p) => JSON.parse(p) as Record<string, unknown>);
}

console.log('\n=== The schema carries the agent protocol, read out of the CLI ===');
{
  ok('both sides of the turn are there', Boolean(MESSAGES[CLIENT] && MESSAGES[SERVER]));
  const client = MESSAGES[CLIENT]!;
  ok('the run request is the first arm', client.find((f) => f.no === 1)?.name === 'run_request');
  ok('and they are a oneof, so at most one is ever set', client.every((f) => f.oneof === 'message'));
  const ended = MESSAGES['agent.v1.TurnEndedUpdate']!;
  ok(
    'the turn reports its own token counts',
    ['input_tokens', 'output_tokens', 'cache_read_tokens'].every((n) => ended.some((f) => f.name === n)),
    JSON.stringify(ended.map((f) => f.name)),
  );
  ok(
    "a tool's arguments are a Value, not a JSON string",
    MESSAGES['agent.v1.McpArgs']!.find((f) => f.name === 'args')?.type === 'google.protobuf.Value',
  );
}

console.log('\n=== The codec walks a run request back out of its own bytes ===');
{
  const { request } = buildRunRequest(
    { messages: [{ role: 'user', content: 'hello' }] },
    { model: asModel('claude-4.5-sonnet'), conversationId: 'conv-1' },
  );
  const back = roundTrip(CLIENT, request);
  const run = back['run_request'] as Message;
  ok('it is a run request', Boolean(run));
  ok('the conversation id survives', run['conversation_id'] === 'conv-1');
  ok('the model survives', (run['requested_model'] as Message)?.['model_id'] === 'claude-4.5-sonnet');
  const message = ((run['action'] as Message)?.['user_message_action'] as Message)?.['user_message'] as Message;
  ok('and the question itself, unlabelled because it is the only one', message?.['text'] === 'hello', JSON.stringify(message));
}

console.log('\n=== A field nobody asked about is stepped over, not thrown on ===');
{
  // Field 9999, length-delimited: a number no schema here knows
  const unknown = new Uint8Array([0xf8, 0xe1, 0x04, 0x2a]);
  const body = concat(encode(SERVER, { interaction_update: { text_delta: { text: 'still here' } } }), unknown);
  const back = decode(SERVER, body);
  ok(
    'the known field is read',
    (((back['interaction_update'] as Message)?.['text_delta'] as Message)?.['text']) === 'still here',
  );
  ok('the unknown one is kept rather than dropped', Boolean(back['$unknown']), JSON.stringify(back['$unknown']));
}

console.log('\n=== Framing survives whatever boundaries TCP chose ===');
{
  const bytes = concat(
    frame({ interaction_update: { text_delta: { text: 'one' } } }),
    frame({ interaction_update: { text_delta: { text: 'two' } } }),
    trailer(),
  );
  for (const cut of [1, 3, 7, 12]) {
    const reader = new FrameReader();
    const seen: string[] = [];
    let ended = false;
    for (let at = 0; at < bytes.length; at += cut) {
      for (const f of reader.push(bytes.slice(at, at + cut))) {
        if (endOfStream(f)) ended = true;
        else {
          const update = decode(SERVER, f.payload)['interaction_update'] as Message;
          seen.push(String((update['text_delta'] as Message)['text']));
        }
      }
    }
    ok(`split every ${cut} bytes: both frames, then the trailer`, seen.join(',') === 'one,two' && ended, seen.join(','));
    ok(`split every ${cut} bytes: nothing held back`, reader.pending === 0, String(reader.pending));
  }
}

console.log('\n=== The trailer is where a mid-stream refusal lives ===');
{
  const reader = new FrameReader();
  const [f] = reader.push(trailer({ error: { code: 'resource_exhausted', message: 'out of fast requests' } }));
  const end = f && endOfStream(f);
  ok('it parses as an end-of-stream frame', Boolean(end));
  ok('with the upstream code', end?.error?.code === 'resource_exhausted');
  ok('and the upstream wording', end?.error?.message === 'out of fast requests');
  ok(
    'a clean ending carries no error',
    endOfStream({ flags: FLAG_END_STREAM, payload: new TextEncoder().encode('{}') })?.error === undefined,
  );
}

console.log('\n=== A client message travels under a sequence number ===');
{
  const body = encode('aiserver.v1.BidiAppendRequest', {
    request_id: { request_id: 'req-1' },
    append_seqno: 3,
    data_binary: encode(CLIENT, { client_heartbeat: new Uint8Array(0) }),
  });
  const back = decodeAppend(body);
  ok('the id joining the two calls is carried', back.requestId === 'req-1');
  ok('so is its place in the sequence', back.seqno === 3, String(back.seqno));
  ok('and the message itself is inside it', back.message['client_heartbeat'] !== undefined, JSON.stringify(back.message));
}

console.log('\n=== The transcript becomes one prompt, tool traffic included ===');
{
  const { prompt, system } = flatten([
    { role: 'system', content: 'you are terse' },
    { role: 'user', content: 'read the file' },
    { role: 'assistant', content: 'looking', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{"p":"a.ts"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'export const a = 1' },
    { role: 'user', content: 'now explain it' },
  ]);
  ok('the system prompt is separated out', system === 'you are terse');
  ok('it is not part of the prompt', !prompt.includes('you are terse'));
  ok('the question is there', prompt.includes('User: read the file'));
  ok('so is the call the model made', prompt.includes('[tool_use Read]'), prompt);
  ok('and what came back from it', prompt.includes('export const a = 1'), prompt);
  ok('and the follow-up', prompt.includes('User: now explain it'));

  /*
   * Except when there is only the one message, which is the most common request there is. The
   * real client sends exactly the words, and a label there would be text the model reads.
   */
  const alone = flatten([{ role: 'user', content: 'say hi' }]);
  ok('a first question is sent as itself', alone.prompt === 'say hi', alone.prompt);
  const withSystem = flatten([{ role: 'system', content: 'be terse' }, { role: 'user', content: 'say hi' }]);
  ok('a system prompt does not make it a transcript', withSystem.prompt === 'say hi', withSystem.prompt);
  ok('it travels apart from the words', withSystem.system === 'be terse');
}

console.log("\n=== A caller's tools decide whether the turn can call tools at all ===");
{
  const withTools: ChatRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ function: { name: 'Read', description: 'read a file', parameters: { type: 'object' } } }],
  };
  const agentic = buildRunRequest(withTools, { model: asModel('m') });
  const run = roundTrip(CLIENT, agentic.request)['run_request'] as Message;
  const message = ((run['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('a caller with tools gets an agent turn', message['mode'] === 1, String(message['mode']));
  ok('and its tools are delegated to', agentic.delegate === true);

  const tools = (run['mcp_tools'] as Message)['mcp_tools'] as Message[];
  ok("the caller's tool travels as an MCP one", tools[0]?.['name'] === 'client__Read', JSON.stringify(tools[0]));
  ok('its schema travels as text as well as a Value', tools[0]?.['input_schema_json'] === '{"type":"object"}');
  ok('and is attributed to this gateway', tools[0]?.['provider_identifier'] === 'agentlodge');

  const plain = buildRunRequest({ messages: [{ role: 'user', content: 'hi' }] }, { model: asModel('m') });
  const asked = roundTrip(CLIENT, plain.request)['run_request'] as Message;
  const askedMessage = ((asked['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('a caller with none gets an asked turn instead', askedMessage['mode'] === 2, String(askedMessage['mode']));
  ok('and nothing is delegated to it', plain.delegate === false);
  // Present but empty, which is what a capture of the real client shows it sending
  ok('the tools field is still there, holding nothing', JSON.stringify(asked['mcp_tools']) === '{}', JSON.stringify(asked['mcp_tools']));

  const planning: ChatRequest = {
    messages: [
      {
        role: 'system',
        content:
          'Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits.',
      },
      { role: 'user', content: 'how should we do this' },
    ],
    tools: [
      { function: { name: 'Read', parameters: { type: 'object' } } },
      { function: { name: 'ExitPlanMode', parameters: { type: 'object' } } },
    ],
  };
  const planned = buildRunRequest(planning, { model: asModel('m') });
  const plannedRun = roundTrip(CLIENT, planned.request)['run_request'] as Message;
  const plannedMessage = ((plannedRun['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok("Claude Code's plan mode is a plan turn", plannedMessage['mode'] === 3, String(plannedMessage['mode']));
  ok('and its tools are still delegated to, so it can read', planned.delegate === true);

  const byTool: ChatRequest = {
    messages: [{ role: 'user', content: 'plan this' }],
    tools: [{ function: { name: 'ExitPlanMode', parameters: { type: 'object' } } }],
  };
  const fromTool = buildRunRequest(byTool, { model: asModel('m') });
  const fromToolMessage = (((roundTrip(CLIENT, fromTool.request)['run_request'] as Message)['action'] as Message)[
    'user_message_action'
  ] as Message)['user_message'] as Message;
  ok('ExitPlanMode without the prompt is enough', fromToolMessage['mode'] === 3, String(fromToolMessage['mode']));

  const both: ChatRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [
      { function: { name: 'EnterPlanMode', parameters: { type: 'object' } } },
      { function: { name: 'ExitPlanMode', parameters: { type: 'object' } } },
    ],
  };
  const bothMessage = (((roundTrip(CLIENT, buildRunRequest(both, { model: asModel('m') }).request)['run_request'] as Message)[
    'action'
  ] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('both enter and exit is still an agent turn', bothMessage['mode'] === 1, String(bothMessage['mode']));

  const continued = buildRunRequest(planning, {
    model: asModel('m'),
    messages: [{ role: 'user', content: 'and then?' }],
  });
  const continuedMessage = (((roundTrip(CLIENT, continued.request)['run_request'] as Message)['action'] as Message)[
    'user_message_action'
  ] as Message)['user_message'] as Message;
  ok('a continuation still plans, even though the slice has no system block', continuedMessage['mode'] === 3, String(continuedMessage['mode']));
}

/*
 * The shape of the real thing.
 *
 * These are not derived from the schema — they are what a capture of `cursor-agent` driving a
 * turn actually put on the wire, with the gateway's own tables decoding it. Each one is a
 * choice that looked arbitrary from the bundle alone and is settled by the capture, so each
 * one is worth a test that fails if it drifts back.
 */
console.log('\n=== The request matches the one the real client sends ===');
{
  const turnId = 'turn-1234';
  const { request } = buildRunRequest(
    { messages: [{ role: 'user', content: 'say hi' }] },
    { model: asModel('auto-smart', [{ id: 'optimize_for', value: 'balanced' }]), conversationId: 'conv-1', runId: turnId },
  );
  const run = roundTrip(CLIENT, request)['run_request'] as Message;

  ok('the turn id is the run id, not a fresh uuid', run['run_id'] === turnId, String(run['run_id']));
  ok('the conversation and its group are the same value', run['conversation_id'] === run['conversation_group_id']);
  ok('the model and its parameters travel apart', (run['requested_model'] as Message)['model_id'] === 'auto-smart');
  ok(
    'with the parameter as its own entry',
    JSON.stringify(((run['requested_model'] as Message)['parameters'] as Message[])[0]) === '{"id":"optimize_for","value":"balanced"}',
    JSON.stringify((run['requested_model'] as Message)['parameters']),
  );
  const message = ((run['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('the prompt is a user message with an id of its own', typeof message['message_id'] === 'string' && String(message['text']).includes('say hi'));
  ok('and an empty selected context rather than none', message['selected_context'] instanceof Uint8Array);
}

/*
 * The two fields a live turn settled, which no amount of reading the bundle would have: both
 * are declared, both look like exactly what this bridge wants, and the server refuses each of
 * them — one as `invalid_argument`, the other as "Workspace context exclusion is not allowed".
 */
console.log('\n=== Neither of the two fields the server refuses is sent ===');
{
  const { request } = buildRunRequest(
    { messages: [{ role: 'system', content: 'be terse' }, { role: 'user', content: 'say hi' }] },
    { model: asModel('m') },
  );
  const run = roundTrip(CLIENT, request)['run_request'] as Message;
  const message = ((run['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('the system prompt is not a field of its own', run['custom_system_prompt'] === undefined, String(run['custom_system_prompt']));
  ok('it is in front of the words instead', message['text'] === 'System: be terse\n\nsay hi', String(message['text']));
  ok('and the workspace context is not excluded', run['exclude_workspace_context'] === false, String(run['exclude_workspace_context']));
}

console.log('\n=== A client message is carried the way the real client carries it ===');
{
  /*
   * Hex in `data`, not bytes in `data_binary`. Both fields exist; the capture shows which one
   * a server is known to accept, and the bundle puts the binary one behind a feature flag.
   */
  const body = encode('aiserver.v1.BidiAppendRequest', {
    request_id: { request_id: 'req-1' },
    append_seqno: 0,
    data: Buffer.from(encode(CLIENT, { client_heartbeat: new Uint8Array(0) })).toString('hex'),
  });
  const outer = decode('aiserver.v1.BidiAppendRequest', body);
  ok('the payload goes out hex-encoded', typeof outer['data'] === 'string' && (outer['data'] as string).length > 0);
  ok('and the binary field is left alone', outer['data_binary'] === undefined);

  const back = decodeAppend(body);
  ok('which reads back as the message it was', back.message['client_heartbeat'] !== undefined, JSON.stringify(back.message));

  // The other carrier still reads, for whoever is on the encoding behind the flag
  const binary = encode('aiserver.v1.BidiAppendRequest', {
    request_id: { request_id: 'req-2' },
    append_seqno: 1,
    data_binary: encode(CLIENT, { client_heartbeat: new Uint8Array(0) }),
  });
  ok('so does the binary one', decodeAppend(binary).message['client_heartbeat'] !== undefined);
}

console.log("\n=== Cursor's own tool names are not re-registered ===");
{
  ok('a client tool goes out prefixed', wireName('Read') === 'client__Read');
  ok('and comes back as itself', clientName('client__Read') === 'Read');
  ok('a name that was never prefixed is left alone', clientName('SomeMcpTool') === 'SomeMcpTool');
  ok(
    'WebSearch is not offered as MCP, because Cursor already runs it',
    toDefinitions([{ name: 'WebSearch' }, { name: 'Read' }]).every((t) => t['name'] !== 'client__WebSearch') &&
      toDefinitions([{ name: 'WebSearch' }, { name: 'Read' }]).some((t) => t['name'] === 'client__Read'),
  );
  ok('and neither is WebFetch', toDefinitions([{ name: 'WebFetch' }]).length === 0);
}

console.log('\n=== Arguments survive the trip through google.protobuf.Value ===');
{
  const value = { s: 'text', n: 4, b: true, nil: null, list: [1, 'two'], nested: { k: 'v' } };
  const back = fromValue(roundTrip('google.protobuf.Value', toValue(value)));
  ok('the whole shape comes back', JSON.stringify(back) === JSON.stringify(value), JSON.stringify(back));

  // As the map on McpArgs carries it: one Value per key
  const args = roundTrip('agent.v1.McpArgs', { name: 'x', args: { path: toValue('a.ts'), lines: toValue(20) } });
  ok('and so does a map of them', JSON.stringify(argsOf(args['args'])) === '{"path":"a.ts","lines":20}', JSON.stringify(argsOf(args['args'])));
  ok('a definition with no schema still declares one', (toDefinitions([{ name: 'X' }])[0]?.['input_schema_json']) === '{"type":"object","properties":{}}');
}

console.log('\n=== A model slug carries its variant, and the wire wants them apart ===');
{
  const fast = splitModel('composer-2.5-fast');
  ok('the suffix becomes a parameter', fast.id === 'composer-2.5' && JSON.stringify(fast.parameters) === '[{"id":"fast","value":"true"}]', JSON.stringify(fast));
  const thinking = splitModel('claude-opus-5-thinking-high');
  ok('thinking and its effort are one parameter', thinking.id === 'claude-opus-5' && thinking.parameters.length === 1, JSON.stringify(thinking));
  ok('a plain name is left alone', splitModel('gpt-5.2').id === 'gpt-5.2');
  ok('max is a mode rather than a parameter', splitModel('gemini-3.1-pro-max').max === true);
  ok('and is off unless the slug says so', splitModel('gemini-3.1-pro').max === false);
}

/*
 * The bracket is not a syntax of ours: Claude Code reports the model it is running as with the
 * context window on the end of it, so this arrives on ordinary requests. Left on the name it is
 * a model Cursor has never heard of — the whole slug misses the catalogue and the turn goes out
 * asking for `claude-opus-5[1m]`.
 */
console.log('\n=== A window a caller named in brackets is read off the slug ===');
{
  const plain = parseSlug('claude-opus-5');
  ok('a bare name is all base and no parameters', plain.base === 'claude-opus-5' && plain.parameters.size === 0);

  const window = parseSlug('claude-opus-5[1m]');
  ok('the bracket comes off the name', window.base === 'claude-opus-5', window.base);
  ok('and a value on its own is the context window', window.parameters.get('context') === '1m', JSON.stringify([...window.parameters]));

  const named = parseSlug('claude-sonnet-5[context=300k]');
  ok('which can also be said in full', named.parameters.get('context') === '300k', JSON.stringify([...named.parameters]));

  const several = parseSlug('claude-sonnet-5-thinking-high[ context = 300k , thinking = true ]');
  ok('several travel comma-separated', several.parameters.get('thinking') === 'true', JSON.stringify([...several.parameters]));
  ok('with the spacing a person would write', several.base === 'claude-sonnet-5-thinking-high' && several.parameters.get('context') === '300k', JSON.stringify(several.base));

  const empty = parseSlug('claude-opus-5[]');
  ok('an empty bracket asks for nothing', empty.base === 'claude-opus-5' && empty.parameters.size === 0, JSON.stringify(empty.base));
}

console.log("\n=== Cursor's tool requests map onto the caller's own tools ===");
{
  const read = toolFor({ pi_read_args: { path: '/a.ts', offset: 10 } })!;
  ok('a file read becomes Read', read.name === 'Read' && read.result === 'pi_read_result');
  ok('with the path under the name that tool uses', JSON.stringify(read.input({ path: '/a.ts', offset: 10 })) === '{"file_path":"/a.ts","offset":10}');
  ok('and the answer goes back as one output string', JSON.stringify(read.output({}, 'contents', false)) === '{"success":{"output":"contents"}}');
  ok('an error keeps its arm', JSON.stringify(read.output({}, 'no such file', true)) === '{"error":{"error":"no such file"}}');

  const shell = toolFor({ shell_stream_args: { command: 'ls' } })!;
  ok('a command becomes Bash', shell.name === 'Bash' && shell.streaming === true);
  ok('which is answered as a stream', shellStream('a.ts', false, '/w').length === 3);
  const closed = shellStream('boom', true, '/w');
  ok('a failure goes out on stderr', JSON.stringify(closed[1]) === '{"stderr":{"data":"boom"}}', JSON.stringify(closed[1]));
  ok('and exits non-zero', JSON.stringify(closed[2]) === '{"exit":{"code":1,"cwd":"/w","aborted":false}}', JSON.stringify(closed[2]));

  const structured = toolFor({ read_args: { path: '/a.ts' } })!;
  const answer = structured.output({ path: '/a.ts' }, 'one\ntwo', false);
  ok('the older read shape is answered in full', (((answer['success'] as Message)?.['total_lines'])) === 2, JSON.stringify(answer));

  const edit = toolFor({ pi_edit_args: {} })!;
  ok('a single replacement becomes Edit', JSON.stringify(edit.input({ path: '/a', edits: [{ old_text: 'a', new_text: 'b' }] })) === '{"file_path":"/a","old_string":"a","new_string":"b"}');
  const many = edit.input({ path: '/a', edits: [{ old_text: 'a' }, { old_text: 'b' }] });
  ok('a batch of them is refused rather than half-applied', 'error' in many, JSON.stringify(many));

  /*
   * The one that would be silent: a bridge answering on a field the tables cannot write throws
   * mid-turn, with the client already streaming and nothing left to say why.
   */
  const answers = MESSAGES['agent.v1.ExecClientMessage']!;
  ok(
    'every bridged answer is a field the codec can actually write',
    EXEC_TOOLS.every((t) => {
      const field = answers.find((f) => f.name === t.result);
      return Boolean(field?.type && MESSAGES[field.type]);
    }),
    EXEC_TOOLS.filter((t) => {
      const field = answers.find((f) => f.name === t.result);
      return !field?.type || !MESSAGES[field.type];
    })
      .map((t) => t.result)
      .join(','),
  );
  ok('a request nothing here can run is not claimed', toolFor({ grep_args: { pattern: 'x' } }) === undefined);
}

console.log('\n=== Events become a Chat Completions stream ===');
{
  const out = new ChatStream('claude-4.5-sonnet');
  const sse = out.text('Hel') + out.text('lo') + out.done({ input: 100, output: 20, cacheRead: 40, cacheWrite: 10, reasoning: 5 });

  const evs = events(sse);
  const text = evs
    .map((e) => (e['choices'] as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content ?? '')
    .join('');
  ok('the text arrives whole', text === 'Hello', text);
  ok('the stream is closed off as a finished answer', sse.includes('"finish_reason":"stop"'));

  const usage = evs.find((e) => e['usage'])!['usage'] as Record<string, unknown>;
  ok('the counts are the ones Cursor reported, not an estimate', usage['completion_tokens'] === 20, JSON.stringify(usage));
  ok(
    'cache reads and writes travel as details, not mixed into each other',
    JSON.stringify(usage['prompt_tokens_details']) === '{"cached_tokens":40,"cache_write_tokens":10}',
  );
  ok(
    'prompt_tokens is Cursor\'s input, which already is the whole prompt',
    usage['prompt_tokens'] === 100,
    JSON.stringify(usage),
  );
  ok('reasoning is reported without being added twice', JSON.stringify(usage['completion_tokens_details']) === '{"reasoning_tokens":5}');
  ok('it ends with [DONE]', sse.trimEnd().endsWith('[DONE]'));
}

console.log('\n=== A tool call goes out once, complete ===');
{
  const out = new ChatStream('m');
  const sse = out.tool('call_1', 'Read', { file_path: 'a.ts' }) + out.done();
  const calls = events(sse).flatMap(
    (e) => (e['choices'] as Array<{ delta?: { tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]?.delta?.tool_calls ?? [],
  );
  ok('exactly one call is emitted', calls.length === 1, JSON.stringify(calls));
  ok('with its whole arguments', calls[0]?.function?.arguments === '{"file_path":"a.ts"}');
  ok('under the id the answer will come back with', calls[0]?.id === 'call_1');
  ok('and the answer is marked as stopping for a tool', sse.includes('"finish_reason":"tool_calls"'));
}

console.log('\n=== A refusal keeps its wording, in the shape the relay reads ===');
{
  const out = new ChatStream('m');
  const sse = out.text('partial') + out.error('unauthenticated: token expired');
  const last = events(sse).at(-1)!;
  ok('the translator will recognise it as a failure', isErrorBody(last), JSON.stringify(last));
  ok("the upstream's own sentence is carried", JSON.stringify(last).includes('token expired'));
  ok('and its code', JSON.stringify(last).includes('unauthenticated'));
}

console.log('\n=== A request answering a tool call says which one ===');
{
  const results = toolResults([
    { role: 'user', content: 'go' },
    { role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'Read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'the contents' },
  ]);
  ok('the id and the answer are picked out', JSON.stringify(results) === '[{"callId":"c1","text":"the contents"}]', JSON.stringify(results));
  ok('a request asking something new carries none', toolResults([{ role: 'user', content: 'go' }]).length === 0);
}

console.log('\n=== Which arm of a oneof is set is answerable without guessing ===');
{
  const message = decode(SERVER, encode(SERVER, { exec_server_message: { id: 1, pi_read_args: { path: '/a' } } }));
  ok('the arm is named', oneofOf(SERVER, message, 'message')?.name === 'exec_server_message');
  ok('and an unset group answers nothing', oneofOf(SERVER, {}, 'message') === undefined);
}

console.log('\n=== RunSSE over HTTP/2 comes back as a fetch Response ===');
{
  ok('https to the real host uses it', needsHttp2('https://agentn.us.api5.cursor.sh/agent.v1.AgentService/RunSSE'));
  ok('http to a test or the audit proxy does not', !needsHttp2('http://127.0.0.1:9/agent.v1.AgentService/RunSSE'));

  const payload = envelope(encode(SERVER, { interaction_update: { text_delta: { text: 'ok' } } }));
  const seen: { path?: string; ctype?: string } = {};
  const server = http2.createServer((req, res) => {
    seen.path = req.url;
    seen.ctype = req.headers['content-type'] as string | undefined;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/connect+proto' });
      res.end(Buffer.from(payload));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  try {
    const res = await postHttp2(`http://127.0.0.1:${port}/agent.v1.AgentService/RunSSE`, {
      headers: { 'content-type': 'application/connect+proto', connection: 'keep-alive' },
      body: envelope(encode('aiserver.v1.BidiRequestId', { request_id: 'req-1' })),
      signal: new AbortController().signal,
    });
    ok('the status is the one the server sent', res.status === 200, String(res.status));
    ok('the path is the RPC', seen.path === '/agent.v1.AgentService/RunSSE', seen.path);
    ok('hop-by-hop headers were not forwarded', seen.ctype === 'application/connect+proto', seen.ctype);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const frame = new FrameReader().push(bytes)[0];
    const text = ((decode(SERVER, frame!.payload)['interaction_update'] as Message)['text_delta'] as Message)['text'];
    ok('and the body is the framed message', text === 'ok', String(text));
  } finally {
    server.close();
  }

  const hanging = http2.createServer(() => {
    /* never answers, so abort is the only way out */
  });
  await new Promise<void>((r) => hanging.listen(0, '127.0.0.1', r));
  const hangingPort = (hanging.address() as { port: number }).port;
  try {
    const ac = new AbortController();
    const pending = postHttp2(`http://127.0.0.1:${hangingPort}/agent.v1.AgentService/RunSSE`, {
      headers: {},
      body: new Uint8Array(0),
      signal: ac.signal,
    });
    ac.abort();
    const err = await pending.then(
      () => undefined,
      (e: unknown) => e as Error,
    );
    ok('aborting the signal refuses the call', err instanceof Error, String(err));
  } finally {
    hanging.close();
  }
}

console.log('\n=== Claude Code names that miss the variant table still resolve ===');
{
  const catalog = buildCatalog([
    {
      name: 'claude-opus-4',
      variants: [
        {
          variant_string_representation: 'claude-opus-4',
          is_default_non_max_config: true,
          parameter_values: [],
        },
      ],
    },
    {
      name: 'claude-opus-4-8',
      id_aliases: ['opus', 'opus-latest'],
      variants: [
        {
          variant_string_representation: 'claude-opus-4-8',
          is_default_non_max_config: true,
          parameter_values: [{ id: 'effort', value: 'high' }],
        },
      ],
    },
    {
      name: 'claude-opus-5',
      id_aliases: ['opus'],
      variants: [
        {
          variant_string_representation: 'claude-opus-5-high',
          is_default_non_max_config: true,
          parameter_values: [{ id: 'effort', value: 'high' }],
        },
      ],
    },
    {
      name: 'claude-sonnet-4-6',
      id_aliases: ['sonnet', 'sonnet-latest'],
      variants: [
        {
          variant_string_representation: 'claude-sonnet-4-6',
          is_default_non_max_config: true,
          parameter_values: [],
        },
      ],
    },
    {
      name: 'claude-sonnet-5',
      variants: [
        {
          variant_string_representation: 'claude-sonnet-5',
          is_default_non_max_config: true,
          parameter_values: [{ id: 'effort', value: 'high' }],
        },
      ],
    },
    {
      name: 'claude-haiku-4-5',
      id_aliases: ['haiku'],
      variants: [
        {
          variant_string_representation: 'claude-haiku-4-5',
          is_default_non_max_config: true,
          parameter_values: [{ id: 'thinking', value: 'true' }],
        },
      ],
    },
  ]);
  ok('opus is Opus 5, not the first alias Cursor listed', catalog.slugs.get('opus')?.id === 'claude-opus-5');
  ok("and Cursor's own latest alias is left as Cursor listed it", catalog.slugs.get('opus-latest')?.id === 'claude-opus-4-8');
  ok('sonnet is Sonnet 5', catalog.slugs.get('sonnet')?.id === 'claude-sonnet-5');
  ok("sonnet-latest is Cursor's 4.6", catalog.slugs.get('sonnet-latest')?.id === 'claude-sonnet-4-6');
  ok('haiku is the one this account has', catalog.slugs.get('haiku')?.id === 'claude-haiku-4-5');
  ok('a shorter 4 does not beat 4-8, and neither beats 5', catalog.slugs.get('opus')?.id === 'claude-opus-5');
  ok('a dated snapshot id is the undated model', undated('claude-haiku-4-5-20251001') === 'claude-haiku-4-5');
  ok('and a date is not stripped off a version', undated('claude-opus-4-8') === 'claude-opus-4-8');
}

console.log('\n=== A parked turn belongs to the user who started it ===');
{
  const dummy = () => ({
    session: { close: async () => {}, submit: async () => {} },
    events: (async function* () {})(),
    controller: new AbortController(),
    model: 'm',
  });
  turns.clear();
  turns.park({ ...dummy(), callId: 'c1', userId: 'alice' });
  ok('the owner can resume it', turns.resume(['c1'], 'alice')?.callId === 'c1');
  turns.park({ ...dummy(), callId: 'c1', userId: 'alice' });
  ok('another user cannot', turns.resume(['c1'], 'bob') === undefined);
  ok('and it is still parked for the owner', turns.resume(['c1'], 'alice')?.callId === 'c1');
  turns.clear();
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

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
import { isErrorBody } from '../translate.js';
import { decodeAppend } from './bidi.js';
import { decode, encode, oneofOf, type Message } from './codec.js';
import { endOfStream, envelope, FrameReader, FLAG_END_STREAM } from './connect.js';
import { EXEC_TOOLS, shellStream, toolFor } from './exec-bridge.js';
import { argsOf, clientName, fromValue, toDefinitions, toValue, wireName } from './mcp.js';
import { buildRunRequest, flatten, splitModel, toolResults, type ChatRequest } from './request.js';
import { MESSAGES } from './schema.generated.js';
import { ChatStream } from './stream.js';

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
    { model: 'claude-4.5-sonnet', conversationId: 'conv-1' },
  );
  const back = roundTrip(CLIENT, request);
  const run = back['run_request'] as Message;
  ok('it is a run request', Boolean(run));
  ok('the conversation id survives', run['conversation_id'] === 'conv-1');
  ok('the model survives', (run['requested_model'] as Message)?.['model_id'] === 'claude-4.5-sonnet');
  const message = ((run['action'] as Message)?.['user_message_action'] as Message)?.['user_message'] as Message;
  ok('and the question itself', message?.['text'] === 'User: hello', JSON.stringify(message));
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
}

console.log("\n=== A caller's tools decide whether the turn can call tools at all ===");
{
  const withTools: ChatRequest = {
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ function: { name: 'Read', description: 'read a file', parameters: { type: 'object' } } }],
  };
  const agentic = buildRunRequest(withTools, { model: 'm' });
  const run = roundTrip(CLIENT, agentic.request)['run_request'] as Message;
  const message = ((run['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('a caller with tools gets an agent turn', message['mode'] === 1, String(message['mode']));
  ok('and its tools are delegated to', agentic.delegate === true);

  const tools = (run['mcp_tools'] as Message)['mcp_tools'] as Message[];
  ok("the caller's tool travels as an MCP one", tools[0]?.['name'] === 'client__Read', JSON.stringify(tools[0]));
  ok('its schema travels as text as well as a Value', tools[0]?.['input_schema_json'] === '{"type":"object"}');
  ok('and is attributed to this gateway', tools[0]?.['provider_identifier'] === 'agentlodge');

  const plain = buildRunRequest({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' });
  const asked = roundTrip(CLIENT, plain.request)['run_request'] as Message;
  const askedMessage = ((asked['action'] as Message)['user_message_action'] as Message)['user_message'] as Message;
  ok('a caller with none gets an asked turn instead', askedMessage['mode'] === 2, String(askedMessage['mode']));
  ok('and nothing is delegated to it', plain.delegate === false);
  ok('it declares no tools', asked['mcp_tools'] === undefined);
}

console.log("\n=== Cursor's own tool names are not re-registered ===");
{
  ok('a client tool goes out prefixed', wireName('Read') === 'client__Read');
  ok('and comes back as itself', clientName('client__Read') === 'Read');
  ok('a name that was never prefixed is left alone', clientName('SomeMcpTool') === 'SomeMcpTool');
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
  ok('cache reads are kept apart from fresh input', JSON.stringify(usage['prompt_tokens_details']) === '{"cached_tokens":40}');
  ok('and cache writes are billed as input', usage['prompt_tokens'] === 150, JSON.stringify(usage));
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

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

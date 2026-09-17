/**
 * The Cursor bridge, end to end without a network.
 *
 * What is being tested is the seam: a Cursor upstream is reached over a protocol neither
 * CLI has heard of, and the claim is that both of them work against it anyway. So the last
 * two sections do not stop at Chat Completions — they run the bridge's output through the
 * same translators the relay uses, and check that what comes out is an Anthropic message
 * for Claude Code and a Responses stream for Codex.
 *
 * Run: npm -w @agentlodge/server run test:cursor
 */
import { ChatToAnthropic, ChatToResponses, isErrorBody } from '../translate.js';
import { decode, encode, oneofOf, type Message } from './codec.js';
import { endOfStream, envelope, FrameReader, FLAG_END_STREAM } from './connect.js';
import { buildChatRequest, type ChatRequest } from './request.js';
import { CursorToChat, PLAIN } from './stream.js';

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

const REQUEST = 'aiserver.v1.StreamUnifiedChatRequest';
const RESPONSE = 'aiserver.v1.StreamUnifiedChatResponse';

/** One response frame, as Cursor would put it on the wire */
const frame = (body: Message): Uint8Array => envelope(encode(RESPONSE, body));

/** The frame that ends every stream, clean or otherwise */
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

console.log('\n=== The codec walks a request back out of its own bytes ===');
{
  const built = buildChatRequest(
    { messages: [{ role: 'user', content: 'hello' }] },
    { model: 'claude-4.5-sonnet', conversationId: 'conv-1' },
  );
  const back = decode(REQUEST, encode(REQUEST, built));
  const conversation = back['conversation'] as Message[];
  ok('the model survives', (back['model_details'] as Message)?.['model_name'] === 'claude-4.5-sonnet');
  ok('so does the conversation id', back['conversation_id'] === 'conv-1');
  ok('and the question itself', conversation?.[0]?.['text'] === 'hello', JSON.stringify(conversation?.[0]));
  ok('which is marked as the human turn', conversation?.[0]?.['type'] === 1);
}

console.log('\n=== A field nobody asked about is stepped over, not thrown on ===');
{
  // Field 9999, length-delimited: a number no schema here knows
  const unknown = new Uint8Array([0xf8, 0xe1, 0x04, 0x2a]);
  const body = concat(encode(RESPONSE, { text: 'still here' }), unknown);
  const back = decode(RESPONSE, body);
  ok('the known field is read', back['text'] === 'still here');
  ok('the unknown one is kept rather than dropped', Boolean(back['$unknown']), JSON.stringify(back['$unknown']));
}

console.log('\n=== Framing survives whatever boundaries TCP chose ===');
{
  const bytes = concat(frame({ text: 'one' }), frame({ text: 'two' }), trailer());
  for (const cut of [1, 3, 7, 12]) {
    const reader = new FrameReader();
    const seen: string[] = [];
    let ended = false;
    for (let at = 0; at < bytes.length; at += cut) {
      for (const f of reader.push(bytes.slice(at, at + cut))) {
        if (endOfStream(f)) ended = true;
        else seen.push(String(decode(RESPONSE, f.payload)['text']));
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
  ok('a clean ending carries no error', endOfStream({ flags: FLAG_END_STREAM, payload: new TextEncoder().encode('{}') })?.error === undefined);
}

console.log('\n=== The transcript arrives in the shape Cursor keeps ===');
{
  const body: ChatRequest = {
    messages: [
      { role: 'system', content: 'you are terse' },
      { role: 'user', content: 'read the file' },
      {
        role: 'assistant',
        content: 'looking',
        tool_calls: [{ id: 'call_1', function: { name: 'Read', arguments: '{"path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'export const a = 1' },
      { role: 'user', content: 'now explain it' },
    ],
    tools: [{ function: { name: 'Read', description: 'read a file', parameters: { type: 'object' } } }],
  };
  const built = decode(REQUEST, encode(REQUEST, buildChatRequest(body, { model: 'm' })));
  const conversation = built['conversation'] as Message[];

  ok('the system prompt becomes explicit context', (built['explicit_context'] as Message)?.['context'] === 'you are terse');
  ok('it is not a turn of its own', conversation.length === 3, String(conversation.length));

  const assistant = conversation[1]!;
  const results = assistant['tool_results'] as Message[];
  ok('the assistant turn is the AI one', assistant['type'] === 2);
  ok('the call hangs off it', results?.[0]?.['tool_call_id'] === 'call_1', JSON.stringify(results?.[0]));
  ok('with the arguments it was called with', results?.[0]?.['raw_args'] === '{"path":"a.ts"}');
  ok('and the result walked forward onto it', results?.[0]?.['content'] === 'export const a = 1');
  ok('rather than becoming a turn of its own', conversation[2]?.['text'] === 'now explain it');

  const tools = built['mcp_tools'] as Message[];
  ok("the caller's tools travel as MCP tools", tools?.[0]?.['name'] === 'Read');
  ok('their schema travels as JSON', tools?.[0]?.['parameters'] === '{"type":"object"}');
  ok('and the turn is marked agentic', built['is_agentic'] === true);
}

console.log('\n=== A result with no call left in the history is still said ===');
{
  const built = decode(
    REQUEST,
    encode(REQUEST, buildChatRequest({ messages: [{ role: 'tool', tool_call_id: 'gone', content: 'the output' }] }, { model: 'm' })),
  );
  const conversation = built['conversation'] as Message[];
  ok('it becomes a human turn rather than vanishing', conversation[0]?.['text'] === 'the output', JSON.stringify(conversation));
}

console.log('\n=== With no tools, the upstream is told not to offer its own ===');
{
  const built = decode(REQUEST, encode(REQUEST, buildChatRequest({ messages: [{ role: 'user', content: 'hi' }] }, { model: 'm' })));
  ok('tools are disabled explicitly', built['should_disable_tools'] === true);
  ok('and the turn is a chat rather than an agent run', built['is_chat'] === true && built['is_agentic'] === false);
}

console.log('\n=== A picture reaches the other side ===');
{
  const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
  const built = decode(
    REQUEST,
    encode(
      REQUEST,
      buildChatRequest(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: 'what is this' },
                { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
                { type: 'image_url', image_url: { url: 'https://example.com/x.png' } },
              ],
            },
          ],
        },
        { model: 'm' },
      ),
    ),
  );
  const images = (built['conversation'] as Message[])[0]?.['images'] as Message[];
  ok('the words are there', (built['conversation'] as Message[])[0]?.['text'] === 'what is this');
  ok('the data url arrives as bytes', (images?.[0]?.['data'] as Uint8Array)?.length === Buffer.from(PNG, 'base64').length);
  ok('an address is not fetched on the upstream’s behalf', images?.length === 1, String(images?.length));
}

console.log('\n=== Frames become a Chat Completions stream ===');
{
  const conv = new CursorToChat({ model: 'claude-4.5-sonnet', promptChars: 300, responseType: PLAIN });
  let sse = conv.push(concat(frame({ text: 'Hel' }), frame({ text: 'lo' })));
  sse += conv.push(trailer());
  sse += conv.end();

  const evs = events(sse);
  const text = evs
    .map((e) => (e['choices'] as Array<{ delta?: { content?: string } }> | undefined)?.[0]?.delta?.content ?? '')
    .join('');
  ok('the text arrives whole', text === 'Hello', text);
  ok('the stream is closed off as a finished answer', sse.includes('"finish_reason":"stop"'));
  const usage = evs.find((e) => e['usage']) as { usage?: { prompt_tokens?: number; completion_tokens?: number } } | undefined;
  ok('and carries an estimate, since Cursor reports none', (usage?.usage?.prompt_tokens ?? 0) === 100, JSON.stringify(usage?.usage));
  ok('the output side is estimated too', (usage?.usage?.completion_tokens ?? 0) > 0);
  ok('it ends with [DONE]', sse.trimEnd().endsWith('[DONE]'));
}

console.log('\n=== A tool call goes out once, complete ===');
{
  const conv = new CursorToChat({ model: 'm', promptChars: 30, responseType: PLAIN });
  // Cursor sends the same call again as its arguments fill in
  let sse = conv.push(
    concat(
      frame({ tool_call: { tool_call_id: 'c1', name: 'Read' } }),
      frame({ tool_call: { tool_call_id: 'c1', name: 'Read', raw_args: '{"pa' } }),
      frame({ tool_call: { tool_call_id: 'c1', name: 'Read', raw_args: '{"path":"a.ts"}' } }),
      trailer(),
    ),
  );
  sse += conv.end();

  const calls = events(sse).flatMap(
    (e) => (e['choices'] as Array<{ delta?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> | undefined)?.[0]?.delta?.tool_calls ?? [],
  );
  ok('exactly one call is emitted', calls.length === 1, JSON.stringify(calls));
  ok('with the whole arguments rather than a growing prefix', calls[0]?.function?.arguments === '{"path":"a.ts"}');
  ok('and the name', calls[0]?.function?.name === 'Read');
  ok('the answer is marked as stopping for a tool', sse.includes('"finish_reason":"tool_calls"'));
}

console.log('\n=== A refusal keeps its wording, in the shape the relay reads ===');
{
  const conv = new CursorToChat({ model: 'm', promptChars: 10, responseType: PLAIN });
  const sse = conv.push(concat(frame({ text: 'partial' }), trailer({ error: { code: 'unauthenticated', message: 'token expired' } })));
  const last = events(sse).at(-1)!;
  ok('the translator will recognise it as a failure', isErrorBody(last), JSON.stringify(last));
  ok("the upstream's own sentence is carried", JSON.stringify(last).includes('token expired'));
  ok('and its code', JSON.stringify(last).includes('unauthenticated'));
  ok('nothing is added after it', conv.end() === '');
}

console.log('\n=== A stream that simply stops is not reported as a finished answer ===');
{
  const conv = new CursorToChat({ model: 'm', promptChars: 10, responseType: PLAIN });
  let sse = conv.push(frame({ text: 'half an ans' }));
  sse += conv.end();
  ok('the truncation is said in band', isErrorBody(events(sse).at(-1)!), sse);
  ok('and it is not closed as a completed message', !sse.includes('"finish_reason":"stop"'));
}

console.log('\n=== Claude Code gets an Anthropic message out of it ===');
{
  const conv = new CursorToChat({ model: 'claude-4.5-sonnet', promptChars: 90, responseType: PLAIN });
  const toAnthropic = new ChatToAnthropic('claude-4.5-sonnet');

  let out = toAnthropic.push(conv.push(concat(frame({ text: 'the answer' }), frame({ tool_call: { tool_call_id: 'c1', name: 'Bash', raw_args: '{"cmd":"ls"}' } }), trailer())));
  out += toAnthropic.push(conv.end());
  out += toAnthropic.end();

  ok('it opens as a message', out.includes('event: message_start'));
  ok('the text is a text block', out.includes('"type":"text_delta"') && out.includes('the answer'));
  ok('the call is a tool_use block', out.includes('"type":"tool_use"') && out.includes('"name":"Bash"'));
  // The arguments travel as a JSON string inside a JSON event, so they arrive escaped
  ok('with its input streamed as json', out.includes('input_json_delta') && out.includes('{\\"cmd\\":\\"ls\\"}'), out);
  ok('and the turn stops for the tool', out.includes('"stop_reason":"tool_use"'), out);
  ok('it closes as a message', out.includes('event: message_stop'));
}

console.log('\n=== Codex gets a Responses stream out of the same frames ===');
{
  const conv = new CursorToChat({ model: 'gpt-5', promptChars: 90, responseType: PLAIN });
  const toResponses = new ChatToResponses('gpt-5');

  let out = toResponses.push(conv.push(concat(frame({ text: 'the answer' }), frame({ tool_call: { tool_call_id: 'c1', name: 'shell', raw_args: '{"cmd":"ls"}' } }), trailer())));
  out += toResponses.push(conv.end());
  out += toResponses.end();

  ok('it opens with response.created', out.includes('event: response.created'));
  ok('the text arrives as output_text', out.includes('response.output_text.delta') && out.includes('the answer'));
  ok('the call arrives as a function_call', out.includes('"type":"function_call"') && out.includes('"name":"shell"'));
  ok('with its arguments', out.includes('{\\"cmd\\":\\"ls\\"}'), out);
  ok('and it completes', out.includes('event: response.completed'), out);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

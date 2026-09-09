/**
 * What survives the trip between the two protocols.
 *
 * The failure this file exists for is silent: an image block that no branch recognised was
 * mapped to '' and filtered away, so a request with a screenshot in it reached the model as
 * the words around the screenshot. Nothing errored, the answer came back, and the only
 * clue was a model that would not talk about the picture.
 *
 * Run: npm -w @agentlodge/server run test:translate
 */
import {
  ChatToAnthropic,
  ChatToResponses,
  anthropicRequestToChat,
  chatResponseToAnthropic,
  responsesRequestToChat,
} from './translate.js';

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

interface ChatBody {
  messages: Array<{
    role: string;
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }> | null;
    tool_call_id?: string;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
  }>;
}

const PNG = 'iVBORw0KGgoAAAANSUhEUg==';
const chat = (body: unknown): ChatBody => anthropicRequestToChat(body as never, 'm') as ChatBody;
const parts = (c: ChatBody['messages'][number]['content']) => (Array.isArray(c) ? c : []);

console.log('\n=== An image reaches the other side ===');
{
  const out = chat({
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is in this picture' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ],
      },
    ],
  });
  const p = parts(out.messages[0]!.content);
  ok('the words are still there', p[0]?.type === 'text' && p[0].text === 'what is in this picture', JSON.stringify(p));
  ok('and so is the picture', p[1]?.type === 'image_url', JSON.stringify(p));
  ok(
    'base64 goes as a data URL, which is how OpenAI addresses one',
    p[1]?.image_url?.url === `data:image/png;base64,${PNG}`,
    p[1]?.image_url?.url,
  );
}
{
  const out = chat({
    messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }] }],
  });
  ok('a URL source travels as it stands', parts(out.messages[0]!.content)[0]?.image_url?.url === 'https://example.com/a.png');
}
{
  // `data:;base64,` is a 400 on some endpoints, and an empty picture is not worth one
  const out = chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image', source: {} }] }] });
  ok('an image with no source at all is dropped rather than sent empty', out.messages[0]!.content === 'hi', JSON.stringify(out.messages[0]));
}

console.log('\n=== A conversation with no picture in it is unchanged ===');
{
  const out = chat({ messages: [{ role: 'user', content: [{ type: 'text', text: 'plain' }] }] });
  // The array form is what a multimodal endpoint reads; a text-only one, such as Ollama's
  // older API, wants a string. So the array is used only where an image needs it.
  ok('text-only content stays a string', out.messages[0]!.content === 'plain', JSON.stringify(out.messages[0]));
}
{
  const out = chat({ system: 'be brief', messages: [{ role: 'user', content: 'hello' }] });
  ok('a string system prompt is still a string', out.messages[0]!.content === 'be brief' && out.messages[0]!.role === 'system');
  ok('and a string message with it', out.messages[1]!.content === 'hello');
}

console.log('\n=== Tools ===');
{
  const out = chat({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me look' },
          { type: 'tool_use', id: 'tu-1', name: 'Read', input: { path: 'a.txt' } },
        ],
      },
    ],
  });
  ok('a tool call keeps the text beside it', out.messages[0]!.content === 'let me look');
  ok('and the call itself', out.messages[0]!.tool_calls?.[0]?.function.name === 'Read');
}
{
  // A tool role holds text only on this side, so a screenshot a tool returned would have
  // nowhere to go; it follows as a user message rather than being dropped
  const out = chat({
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu-1',
            content: [
              { type: 'text', text: 'here is the screen' },
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: PNG } },
            ],
          },
        ],
      },
    ],
  });
  ok('the tool result is a tool message', out.messages[0]!.role === 'tool' && out.messages[0]!.tool_call_id === 'tu-1');
  ok('carrying its text', out.messages[0]!.content === 'here is the screen', JSON.stringify(out.messages[0]));
  ok('and the picture follows as a message that can hold one', out.messages[1]?.role === 'user', JSON.stringify(out.messages[1]));
  ok(
    'with the media type it was sent with',
    parts(out.messages[1]?.content ?? null)[0]?.image_url?.url === `data:image/jpeg;base64,${PNG}`,
    JSON.stringify(out.messages[1]),
  );
}
{
  const out = chat({
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', content: [], is_error: true }] }],
  });
  ok('a failed tool with nothing to say still says that', out.messages[0]!.content === '(the tool failed)');
}

console.log('\n=== Only a user turn may carry a picture ===');
{
  // OpenAI takes an image part in a user message and refuses one in an assistant message.
  // Anthropic does not produce such a turn, but a client composes its own history.
  const out = chat({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'here it is' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } },
        ],
      },
    ],
  });
  ok(
    'an assistant turn keeps its words and marks what was taken out',
    out.messages[0]!.content === 'here it is\n[image]',
    JSON.stringify(out.messages[0]),
  );
}
{
  /*
   * The turn whose only block was the picture. Flattening it to '' sent an empty assistant
   * message — refused outright by some endpoints, and read by the rest as the model having
   * said nothing, with the next question asking about an image nobody was sent.
   */
  const out = chat({
    messages: [
      { role: 'user', content: 'look' },
      { role: 'assistant', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
    ],
  });
  ok('an image-only assistant turn is not sent empty', out.messages[1]!.content === '[image]', JSON.stringify(out.messages[1]));
  ok('and two of them say so', chat({
    messages: [{ role: 'assistant', content: [
      { type: 'image', source: { data: PNG } },
      { type: 'image', source: { data: PNG } },
    ] }],
  }).messages[0]!.content === '[2 images]');
}

console.log('\n=== A tool run is not broken up by what one of them returned ===');
{
  /*
   * The tool messages have to follow the assistant's tool_calls with nothing in between.
   * Lifting a screenshot straight after the tool that produced it orphaned the next one,
   * and an OpenAI-compatible endpoint refuses the whole conversation from then on.
   */
  const out = chat({
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 'screenshot', input: {} },
          { type: 'tool_use', id: 'b', name: 'ls', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }] },
          { type: 'tool_result', tool_use_id: 'b', content: 'file list' },
        ],
      },
    ],
  });
  ok(
    'the tool replies stay together, and the picture follows them',
    out.messages.map((m) => m.role).join(' ') === 'assistant tool tool user',
    out.messages.map((m) => m.role).join(' '),
  );
  ok('both tool calls are answered', out.messages[1]!.tool_call_id === 'a' && out.messages[2]!.tool_call_id === 'b');
  ok('and the picture is in the turn that can hold it', parts(out.messages[3]!.content)[0]?.type === 'image_url', JSON.stringify(out.messages[3]));
}

console.log('\n=== A refusal is not turned into an answer ===');
{
  // An OpenAI-compatible server answers 200 with an error object often enough that the
  // status is no guide: Ollama and llama.cpp both do it for a model that will not load
  const refusal = '{"error":{"message":"model \'x\' not found"}}';
  ok('a non-streaming error body comes back as it was', chatResponseToAnthropic(refusal, 'm') === refusal);

  const t = new ChatToAnthropic('m');
  const out = t.push(`data: ${JSON.stringify({ error: { message: 'context length exceeded' } })}\n\n`) + t.end();
  ok('a streaming one becomes an error frame', out.includes('event: error'), out);
  ok('carrying the upstream\'s wording, which is what the retry path reads', out.includes('context length exceeded'), out);
  ok('and nothing after it claims the turn finished', !out.includes('message_stop'), out);

  const r = new ChatToResponses('m');
  const rout = r.push(`data: ${JSON.stringify({ error: { message: 'no' } })}\n\n`) + r.end();
  ok('the Responses side does the same', rout.includes('event: error') && !rout.includes('response.completed'), rout);
}

console.log('\n=== A refusal is recognised by there being no answer ===');
{
  /*
   * Listing the error shapes does not work. These three all walked past a test keyed on an
   * `error` key with no `choices`, and each is something a real server sends.
   */
  const shapes = [
    ['vLLM', '{"object":"error","message":"bad request","type":"BadRequestError"}', 'bad request'],
    ['a FastAPI or nginx front', '{"detail":"Not Found"}', 'Not Found'],
    ['an empty choices array beside an error', '{"choices":[],"error":{"message":"boom"}}', 'boom'],
  ] as const;
  for (const [who, body, words] of shapes) {
    ok(`${who}: the body is relayed as it stands`, chatResponseToAnthropic(body, 'm') === body, chatResponseToAnthropic(body, 'm'));
    const t = new ChatToAnthropic('m');
    const out = t.push(`data: ${body}\n\n`) + t.end();
    ok(`${who}: streaming becomes an error frame with its words`, out.includes('event: error') && out.includes(words), out);
  }
  // And an answer is still an answer
  const fine = new ChatToAnthropic('m');
  ok(
    'a chunk with a choice in it is translated as before',
    fine.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n').includes('content_block_delta'),
  );
}

console.log('\n=== Once refused, nothing more is translated ===');
{
  // The error and the frames after it can land in different reads, so the latch has to
  // survive between calls — otherwise a second message opens and never closes
  const t = new ChatToAnthropic('m');
  const first = t.push('data: {"error":{"message":"boom"}}\n\n');
  const second = t.push('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n');
  ok('the refusal goes out once', first.includes('event: error'));
  ok('and nothing follows it', second === '' && t.end() === '', JSON.stringify(second + t.end()));

  const r = new ChatToResponses('m');
  r.push('data: {"error":{"message":"no"}}\n\n');
  ok('the Responses side latches too', r.push('data: {"choices":[{"delta":{"content":"x"}}]}\n\n') === '');
}

console.log('\n=== A frame the translator cannot walk is skipped, not thrown ===');
{
  // tool_calls as an object rather than an array: LiteLLM and some quantised servers.
  // Throwing out of push loses the whole batch and ends the response with no body at all.
  const odd = 'data: {"choices":[{"delta":{"tool_calls":{"0":{"id":"a"}}}}]}\n\n';
  const good = 'data: {"choices":[{"delta":{"content":"after"}}]}\n\n';
  const r = new ChatToResponses('m');
  let threw = false;
  let out = '';
  try {
    out = r.push(odd) + r.push(good) + r.end();
  } catch {
    threw = true;
  }
  ok('push does not throw', !threw);
  ok('and what came after it still arrives', out.includes('after'), out.slice(0, 160));

  const a = new ChatToAnthropic('m');
  let threwA = false;
  try {
    a.push(odd);
  } catch {
    threwA = true;
  }
  ok('the Anthropic side likewise', !threwA);
}

console.log('\n=== The Responses side carries images too ===');
{
  const out = responsesRequestToChat(
    {
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'and this one' },
            { type: 'input_image', image_url: `data:image/png;base64,${PNG}` },
          ],
        },
      ],
    },
    'm',
  ) as ChatBody;
  const p = parts(out.messages[0]!.content);
  ok('the text survives', p[0]?.text === 'and this one', JSON.stringify(p));
  ok('and the image with it', p[1]?.image_url?.url === `data:image/png;base64,${PNG}`, JSON.stringify(p));
}
{
  const out = responsesRequestToChat(
    { instructions: 'be brief', input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'plain' }] }] },
    'm',
  ) as ChatBody;
  ok('text-only input is still a string', out.messages[1]!.content === 'plain', JSON.stringify(out.messages[1]));
  ok('and the instructions became the system turn', out.messages[0]!.role === 'system' && out.messages[0]!.content === 'be brief');
}

{
  // developer becomes system on the chat side, and a system turn holds text only
  const out = responsesRequestToChat(
    {
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [
            { type: 'input_text', text: 'be brief' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
          ],
        },
      ],
    },
    'm',
  ) as ChatBody;
  ok(
    'a system turn keeps its words and marks the rest',
    out.messages[0]!.content === 'be brief\n[image]',
    JSON.stringify(out.messages[0]),
  );
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

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
import { anthropicRequestToChat, responsesRequestToChat } from './translate.js';

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
  ok('an assistant turn is flattened to its words', out.messages[0]!.content === 'here it is', JSON.stringify(out.messages[0]));
  ok('with no image part that would be refused', !parts(out.messages[0]!.content).length);
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
  ok('a system turn keeps its words', out.messages[0]!.content === 'be brief', JSON.stringify(out.messages[0]));
  ok('and drops the part that has nowhere to go', !parts(out.messages[0]!.content).length);
}

console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

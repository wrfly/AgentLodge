/**
 * Native chat's two invariants: history comes from our database shape, and an Anthropic
 * stream becomes the same events/blocks the CLI adapters already expose.
 *
 * Run: npm -w @agentlodge/server run test:native-chat
 */
import { strict as assert } from 'node:assert';
import type { ServerEvent, StoredMessage } from '../../../core/protocol.js';
import { NativeEvents } from './events.js';
import { nativeHistory } from './history.js';
import { runNativeTurn } from './runner.js';

const stored: StoredMessage[] = [
  {
    id: 'u1',
    role: 'user',
    blocks: [{ kind: 'text', blockId: 0, text: 'Hello' }],
    createdAt: '2026-01-01T00:00:00Z',
  },
  {
    id: 'a1',
    role: 'assistant',
    blocks: [
      { kind: 'thinking', blockId: 0, text: 'private reasoning' },
      { kind: 'text', blockId: 1, text: 'I will look.' },
      {
        kind: 'tool_use',
        blockId: 2,
        toolId: 'tool-1',
        toolName: 'lookup',
        input: { term: 'x' },
        result: { isError: false, content: 'found' },
      },
    ],
    createdAt: '2026-01-01T00:00:01Z',
  },
  {
    id: 'u2',
    role: 'user',
    blocks: [{ kind: 'text', blockId: 0, text: 'Thanks' }],
    createdAt: '2026-01-01T00:00:02Z',
  },
];

const history = nativeHistory(stored);
assert.equal(history.length, 3);
assert.deepEqual(history[0], { role: 'user', content: [{ type: 'text', text: 'Hello' }] });
assert.equal(history[1]?.role, 'assistant');
assert(!JSON.stringify(history).includes('private reasoning'));
assert.equal(history[2]?.content[0]?.type, 'tool_result');
assert.equal(history[2]?.content[1]?.text, 'Thanks');

const emitted: ServerEvent[] = [];
const events = new NativeEvents((event) => emitted.push(event));
events.accept({
  type: 'message_start',
  message: { model: 'claude-sonnet-5', usage: { input_tokens: 12, cache_read_input_tokens: 3 } },
});
events.accept({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
events.accept({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello ' } });
events.accept({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'world' } });
events.accept({ type: 'content_block_stop', index: 0 });
events.accept({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } });
const finished = events.finish(25);
assert.equal(finished.blocks[0]?.kind, 'text');
assert.equal(finished.blocks[0]?.kind === 'text' ? finished.blocks[0].text : '', 'Hello world');
assert.equal(finished.usage.inputTokens, 12);
assert.equal(finished.usage.cacheReadTokens, 3);
assert.equal(finished.usage.outputTokens, 2);
assert.equal(finished.stopReason, 'end_turn');
assert(emitted.some((event) => event.type === 'text.delta'));

const toolEvents = new NativeEvents(() => {});
toolEvents.accept({
  type: 'content_block_start',
  index: 0,
  content_block: { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: {} },
});
toolEvents.accept({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'input_json_delta', partial_json: '{"query":"AgentLodge"}' },
});
toolEvents.accept({ type: 'content_block_stop', index: 0 });
toolEvents.accept({
  type: 'content_block_start',
  index: 1,
  content_block: {
    type: 'web_search_tool_result',
    tool_use_id: 'search-1',
    content: [{ type: 'web_search_result', title: 'AgentLodge' }],
  },
});
const toolFinished = toolEvents.finish(1);
const serverBlock = toolFinished.blocks[0];
assert.equal(serverBlock?.kind === 'tool_use' ? serverBlock.server : false, true);
assert(serverBlock?.kind === 'tool_use' && serverBlock.serverResult);
const replayed = nativeHistory([{
  id: 'a-server',
  role: 'assistant',
  blocks: toolFinished.blocks,
  createdAt: '2026-01-01T00:00:03Z',
}]);
assert.equal(replayed.length, 1);
assert.deepEqual(replayed[0]?.content.map((block) => block.type), [
  'server_tool_use',
  'web_search_tool_result',
]);

const originalFetch = globalThis.fetch;
let sent: Record<string, unknown> | undefined;
globalThis.fetch = async (_input, init) => {
  sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
  const frames = [
    { type: 'message_start', message: { usage: { input_tokens: 5 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Direct answer' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
    { type: 'message_stop' },
  ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('');
  return new Response(frames, { status: 200, headers: { 'content-type': 'text/event-stream' } });
};

try {
  const turn = runNativeTurn({
    prompt: 'Thanks',
    cwd: '/unused',
    messages: stored,
    model: 'claude-sonnet-5',
    serverTools: true,
    runtimeToken: 'runtime-token',
    onEvent: () => {},
    onSessionId: () => {},
  });
  const result = await turn.done;
  assert.equal(result.error, undefined);
  assert.equal(result.blocks[0]?.kind === 'text' ? result.blocks[0].text : '', 'Direct answer');
  assert.equal((sent?.messages as unknown[]).length, 3);
  assert.equal(sent?.stream, true);
  assert.deepEqual(
    (sent?.tools as Array<{ name: string }>).map((tool) => tool.name),
    ['web_search', 'web_fetch'],
  );
} finally {
  globalThis.fetch = originalFetch;
}

console.log('✓ native history and stream');

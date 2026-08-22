/** Unit tests for usage parsing. Entirely offline — no request leaves the process. */
import assert from 'node:assert/strict';
import { UsageAccumulator } from './usage.js';

let pass = 0, fail = 0;
function check(name: string, fn: () => void): void {
  try { fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${(e as Error).message.split('\n')[0]}`); }
}

console.log('Anthropic Messages SSE');
check('accumulating across message_start and message_delta', () => {
  const a = new UsageAccumulator();
  a.feedBody(
    [
      'event: message_start',
      'data: {"type":"message_start","message":{"model":"claude-opus-5","usage":{"input_tokens":1200,"cache_read_input_tokens":800,"cache_creation_input_tokens":300,"output_tokens":1}}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":57}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","usage":{"output_tokens":142}}',
      '',
    ].join('\n'),
    'text/event-stream',
  );
  assert.equal(a.usage.inputTokens, 1200);
  assert.equal(a.usage.outputTokens, 142, 'output is cumulative, so take the maximum rather than the sum');
  assert.equal(a.usage.cacheReadTokens, 800);
  assert.equal(a.usage.cacheWriteTokens, 300);
  assert.equal(a.usage.model, 'claude-opus-5');
});

console.log('\nOpenAI chat/completions');
check('top-level usage on a non-streaming response', () => {
  const a = new UsageAccumulator();
  a.feedBody(
    JSON.stringify({
      model: 'deepseek-v4-pro',
      usage: { prompt_tokens: 500, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 400 } },
    }),
    'application/json',
  );
  assert.equal(a.usage.inputTokens, 500);
  assert.equal(a.usage.outputTokens, 120);
  assert.equal(a.usage.cacheReadTokens, 400);
  assert.equal(a.usage.model, 'deepseek-v4-pro');
});
check('the final usage chunk of a stream', () => {
  const a = new UsageAccumulator();
  a.feedBody(
    [
      'data: {"model":"deepseek-v4-pro","choices":[{"delta":{"content":"hi"}}]}',
      '',
      'data: {"model":"deepseek-v4-pro","choices":[],"usage":{"prompt_tokens":80,"completion_tokens":9}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n'),
    'text/event-stream',
  );
  assert.equal(a.usage.inputTokens, 80);
  assert.equal(a.usage.outputTokens, 9);
});

console.log('\nCodex responses SSE');
check('pulling usage out of response.completed', () => {
  const a = new UsageAccumulator();
  a.feedBody(
    [
      'data: {"type":"response.output_text.delta","delta":"x"}',
      '',
      'data: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":2048,"output_tokens":333,"input_tokens_details":{"cached_tokens":1024}}}}',
      '',
    ].join('\n'),
    'text/event-stream',
  );
  assert.equal(a.usage.inputTokens, 2048);
  assert.equal(a.usage.outputTokens, 333);
  assert.equal(a.usage.cacheReadTokens, 1024);
  assert.equal(a.usage.model, 'gpt-5-codex');
});

console.log('\nRobustness');
check('a truncated SSE frame does not throw', () => {
  const a = new UsageAccumulator();
  a.feedBody('data: {"type":"message_del', 'text/event-stream');
  assert.equal(a.usage.outputTokens, 0);
});
check('a non-JSON response does not throw', () => {
  const a = new UsageAccumulator();
  a.feedBody('<html>502 Bad Gateway</html>', 'text/html');
  assert.equal(a.usage.inputTokens, 0);
});
check('usage still arrives when fed across chunk boundaries', () => {
  const a = new UsageAccumulator();
  a.feedBody('data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}\n\n', 'text/event-stream');
  a.feedBody('data: {"type":"message_delta","usage":{"output_tokens":20}}\n\n', 'text/event-stream');
  assert.equal(a.usage.inputTokens, 10);
  assert.equal(a.usage.outputTokens, 20);
});
check('an empty response body is safe', () => {
  const a = new UsageAccumulator();
  a.feedBody('', 'text/event-stream');
  assert.deepEqual(
    { i: a.usage.inputTokens, o: a.usage.outputTokens },
    { i: 0, o: 0 },
  );
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

/**
 * A fake upstream that speaks both Anthropic Messages and OpenAI Responses.
 *
 * Point the gateway's Base URL here while testing and the whole chain — CLI → gateway →
 * upstream — runs for real without spending a single token. Metering, quotas, rate limiting,
 * and the frontend's streaming rendering are all exercisable this way.
 *
 *   npm run dev:mock
 *   console → system settings → set the DeepSeek Base URL to http://127.0.0.1:9998
 *                     and put anything in API Key (the gateway only needs it non-empty)
 *
 * Environment:
 *   MOCK_PORT       port to listen on (default 9998)
 *   MOCK_DELAY_MS   thinking delay before the first byte (default 400)
 *   MOCK_TPS        tokens emitted per second (default 25; 0 sends the lot at once)
 *   MOCK_FAIL       inject a failure: 429 / 500 / timeout, for testing backoff and error paths
 *   MOCK_FAIL_RATE  how often to inject it, 0..1 (default 1, meaning every time)
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 9998);
const DELAY = Number(process.env.MOCK_DELAY_MS ?? 400);
const TPS = Number(process.env.MOCK_TPS ?? 25);
const FAIL = process.env.MOCK_FAIL ?? '';
const FAIL_RATE = Number(process.env.MOCK_FAIL_RATE ?? 1);

let inflight = 0;
let peak = 0;
const calls = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const sse = (res) => {
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
  });
  return (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
};

/** Dig out what the user actually said, so it can be echoed back — an empty reply tells you nothing about whether the frontend rendered it */
function lastUserText(body) {
  try {
    const b = JSON.parse(body);
    const msgs = b.messages ?? b.input ?? [];
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m.role && m.role !== 'user') continue;
      const c = m.content;
      if (typeof c === 'string') {
        // A reminder block can share one string with the real input, because the gateway joins
        // blocks together when it translates
        const t = c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();
        if (t) return t.slice(0, 200);
        continue;
      }
      if (Array.isArray(c)) {
        // Claude Code packs <system-reminder> into the same user message, and the real input is
        // usually the last piece — so search backwards and skip the reminders
        for (let j = c.length - 1; j >= 0; j--) {
          const part = c[j];
          if (part.type !== 'text' && part.type !== 'input_text') continue;
          const t = String(part.text ?? '').trim();
          if (!t || t.startsWith('<system-reminder>')) continue;
          return t.slice(0, 200);
        }
      }
    }
  } catch {
    /* A body shape we do not recognise; skip the echo rather than guess */
  }
  return '';
}

/**
 * Make up a plausible usage report.
 *
 * The numbers scale with the request body, so a long context really does cost more — without
 * that, quotas and the price table have nothing to tell apart.
 */
function fakeUsage(body, outputText) {
  const inputTokens = Math.max(Math.round(body.length / 3), 12);
  return {
    input: Math.round(inputTokens * 0.1),
    cacheRead: Math.round(inputTokens * 0.8),
    cacheWrite: Math.round(inputTokens * 0.1),
    output: Math.max(Math.round(outputText.length / 3), 4),
  };
}

function replyText(prompt) {
  const head = '[MOCK] A reply from the fake upstream. No real tokens were spent.';
  return prompt ? `${head}\n\nWhat you said was: ${prompt}` : head;
}

/** Emit text in chunks at MOCK_TPS, so the frontend's streaming rendering can be checked */
async function streamText(text, onChunk) {
  if (TPS <= 0) return onChunk(text);
  const chunks = text.match(/.{1,4}/gsu) ?? [text];
  const gap = 1000 / TPS;
  for (const c of chunks) {
    onChunk(c);
    await sleep(gap);
  }
}

const shouldFail = () => FAIL && Math.random() < FAIL_RATE;

http.createServer(async (req, res) => {
  if (req.url === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ peak, inflight, calls: calls.length, recent: calls.slice(-20) }));
  }
  if (req.url === '/__reset') {
    peak = 0;
    calls.length = 0;
    return res.end('ok');
  }

  let body = '';
  req.on('data', (c) => (body += c));
  await new Promise((r) => req.on('end', r));

  if (process.env.MOCK_DUMP) {
    // For debugging: dump the request body to disk, so the translator can be written against
    // real payloads
    const fs = await import('node:fs/promises');
    await fs.appendFile(process.env.MOCK_DUMP, JSON.stringify({ url: req.url, body }) + '\n');
  }

  inflight += 1;
  peak = Math.max(peak, inflight);
  calls.push({ at: new Date().toISOString(), url: req.url, bytes: body.length, inflightAtStart: inflight });

  try {
    if (shouldFail()) {
      if (FAIL === 'timeout') {
        await sleep(120_000);
        return;
      }
      const code = Number(FAIL) || 500;
      res.writeHead(code, { 'content-type': 'application/json', ...(code === 429 ? { 'retry-after': '2' } : {}) });
      return res.end(JSON.stringify({ type: 'error', error: { type: 'mock_error', message: `injected ${code} from the mock` } }));
    }

    await sleep(DELAY);

    // Claude Code asks for a token count first
    if (req.url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ input_tokens: Math.round(body.length / 3) }));
    }

    const prompt = lastUserText(body);
    const text = replyText(prompt);
    const u = fakeUsage(body, text);

    /* ---------------- Anthropic Messages（Claude Code） ---------------- */
    if (req.url.includes('/v1/messages')) {
      const send = sse(res);

      // When MOCK_TOOL appears in the prompt, answer with a real tool_use rather than text.
      // The point is to settle *which machine actually runs the tool*: the fake upstream never
      // reaches the network and costs nothing, but the agent that receives a tool_use really does
      // go and do it — and which filesystem it lands on answers the question.
      // The second round, which arrives carrying a tool_result, replies with text and ends the turn.
      if (/MOCK_TOOL/.test(body) && !/tool_result/.test(body)) {
        const input = { file_path: 'mock-tool-probe.txt', content: 'WRITTEN-BY-AGENT\n' };
        const json = JSON.stringify(input);
        send('message_start', {
          type: 'message_start',
          message: {
            id: 'msg_mock_tool', type: 'message', role: 'assistant', model: 'deepseek-mock',
            content: [], stop_reason: null, stop_sequence: null,
            usage: { input_tokens: u.input, cache_read_input_tokens: u.cacheRead, cache_creation_input_tokens: u.cacheWrite, output_tokens: 1 },
          },
        });
        send('content_block_start', {
          type: 'content_block_start', index: 0,
          content_block: { type: 'tool_use', id: 'toolu_mock_1', name: 'Write', input: {} },
        });
        // input_json_delta has to arrive in pieces, because that is how the real upstream sends it
        for (let i = 0; i < json.length; i += 20) {
          send('content_block_delta', {
            type: 'content_block_delta', index: 0,
            delta: { type: 'input_json_delta', partial_json: json.slice(i, i + 20) },
          });
        }
        send('content_block_stop', { type: 'content_block_stop', index: 0 });
        send('message_delta', {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: Math.max(Math.round(json.length / 3), 4) },
        });
        send('message_stop', { type: 'message_stop' });
        return res.end();
      }

      send('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_mock', type: 'message', role: 'assistant', model: 'deepseek-mock',
          content: [], stop_reason: null, stop_sequence: null,
          usage: {
            input_tokens: u.input,
            cache_read_input_tokens: u.cacheRead,
            cache_creation_input_tokens: u.cacheWrite,
            output_tokens: 1,
          },
        },
      });
      send('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      await streamText(text, (chunk) =>
        send('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }),
      );
      send('content_block_stop', { type: 'content_block_stop', index: 0 });
      send('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: u.output },
      });
      send('message_stop', { type: 'message_stop' });
      return res.end();
    }

    /* ---------------- OpenAI Chat Completions (local models, and Codex in chat mode) ---------------- */
    if (req.url.includes('chat/completions')) {
      const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      });
      const base = { id: 'chatcmpl_mock', object: 'chat.completion.chunk', model: 'local-mock' };
      send({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
      await streamText(text, (chunk) =>
        send({ ...base, choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }] }),
      );
      send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
      // usage comes only in the final chunk, and only if the client sent stream_options.include_usage
      send({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: u.input + u.cacheRead + u.cacheWrite,
          completion_tokens: u.output,
          total_tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
          prompt_tokens_details: { cached_tokens: u.cacheRead },
        },
      });
      res.write('data: [DONE]\n\n');
      return res.end();
    }

    /* ---------------- OpenAI Responses（Codex） ---------------- */
    if (req.url.includes('responses')) {
      const send = sse(res);
      const item = {
        type: 'message', id: 'msg_mock', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text, annotations: [] }],
      };
      send('response.created', { type: 'response.created', response: { id: 'resp_mock', model: 'deepseek-mock', status: 'in_progress', output: [] } });
      send('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } });
      send('response.content_part.added', { type: 'response.content_part.added', item_id: 'msg_mock', output_index: 0, content_index: 0, part: { type: 'output_text', text: '' } });
      await streamText(text, (chunk) =>
        send('response.output_text.delta', { type: 'response.output_text.delta', item_id: 'msg_mock', output_index: 0, content_index: 0, delta: chunk }),
      );
      send('response.output_text.done', { type: 'response.output_text.done', item_id: 'msg_mock', output_index: 0, content_index: 0, text });
      send('response.content_part.done', { type: 'response.content_part.done', item_id: 'msg_mock', output_index: 0, content_index: 0, part: { type: 'output_text', text } });
      send('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item });
      send('response.completed', {
        type: 'response.completed',
        response: {
          id: 'resp_mock', model: 'deepseek-mock', status: 'completed', output: [item],
          usage: {
            input_tokens: u.input + u.cacheRead + u.cacheWrite,
            output_tokens: u.output,
            total_tokens: u.input + u.cacheRead + u.cacheWrite + u.output,
            input_tokens_details: { cached_tokens: u.cacheRead },
          },
        },
      });
      return res.end();
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: `mock: unrecognised path ${req.url}` } }));
  } finally {
    inflight -= 1;
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`  fake upstream  http://127.0.0.1:${PORT}   delay ${DELAY}ms  ${TPS} tok/s${FAIL ? `  injecting ${FAIL}` : ''}`);
  console.log(`  Point the console's DeepSeek Base URL here, put anything in API Key, and nothing costs money\n`);
});

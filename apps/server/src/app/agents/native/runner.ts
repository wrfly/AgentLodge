import { config } from '../../../core/config.js';
import type { MessageBlock, TurnUsage } from '../../../core/protocol.js';
import type { RunningTurn, RunOptions, TurnResult } from '../types.js';
import { gatewayInternalUrl } from '../provider.js';
import { NativeEvents } from './events.js';
import { nativeHistory } from './history.js';
import { NATIVE_SYSTEM_PROMPT } from './prompt.js';

interface ErrorBody {
  error?: { message?: string };
  message?: string;
}

function errorMessage(body: string, status: number): string {
  try {
    const parsed = JSON.parse(body) as ErrorBody;
    return parsed.error?.message || parsed.message || `the gateway returned ${status}`;
  } catch {
    return body.trim() || `the gateway returned ${status}`;
  }
}

async function consumeSse(
  body: ReadableStream<Uint8Array>,
  accept: (value: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const consumeFrame = (frame: string) => {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n');
    if (!data || data === '[DONE]') return;
    accept(JSON.parse(data));
  };

  while (true) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done }).replace(/\r\n/g, '\n');
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      consumeFrame(buffer.slice(0, boundary));
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
    }
    if (done) break;
  }
  if (buffer.trim()) consumeFrame(buffer);
}

export function runNativeTurn(options: RunOptions): RunningTurn {
  const controller = new AbortController();
  const startedAt = Date.now();
  let aborted = false;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.turnTimeoutMs);

  const done = (async (): Promise<TurnResult> => {
    try {
      if (!options.runtimeToken) {
        throw new Error('Native chat requires an enabled gateway provider');
      }

      const model = options.model || config.model || 'claude-sonnet-4-5';
      const messages = nativeHistory(options.messages ?? []);
      const payload: Record<string, unknown> = {
        model,
        max_tokens: 64_000,
        stream: true,
        system: NATIVE_SYSTEM_PROMPT,
        messages,
      };
      if (options.thinking) {
        payload.thinking = { type: 'adaptive', display: 'summarized' };
      }
      if (options.effort) {
        payload.output_config = { effort: options.effort };
      }
      if (options.serverTools) {
        payload.tools = [
          { type: 'web_search_20250305', name: 'web_search', max_uses: 8 },
          { type: 'web_fetch_20250910', name: 'web_fetch', max_uses: 8 },
        ];
      }

      const blocks: MessageBlock[] = [];
      const usage: TurnUsage = {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        costUsd: 0,
        durationMs: 0,
        numTurns: 0,
        webSearchRequests: 0,
      };
      let nextBlockId = 0;

      for (let continuation = 0; continuation < 4; continuation += 1) {
        const events: NativeEvents = new NativeEvents(options.onEvent, nextBlockId);
        const response = await fetch(`${gatewayInternalUrl()}/v1/messages`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${options.runtimeToken}`,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            accept: 'text/event-stream',
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(errorMessage(await response.text(), response.status));
        }
        if (!response.body) throw new Error('the gateway returned an empty stream');

        await consumeSse(response.body, (value) => events.accept(value));
        const result: ReturnType<NativeEvents['finish']> = events.finish(Date.now() - startedAt);
        blocks.push(...result.blocks);
        nextBlockId = result.nextBlockId;
        usage.inputTokens += result.usage.inputTokens;
        usage.outputTokens += result.usage.outputTokens;
        usage.cacheReadTokens += result.usage.cacheReadTokens;
        usage.cacheCreationTokens += result.usage.cacheCreationTokens;
        usage.webSearchRequests = (usage.webSearchRequests ?? 0)
          + (result.usage.webSearchRequests ?? 0);
        usage.numTurns += 1;

        if (result.stopReason !== 'pause_turn') {
          usage.durationMs = Date.now() - startedAt;
          return { blocks, usage, aborted: false };
        }
        messages.push({ role: 'assistant', content: result.rawContent });
      }
      throw new Error('The upstream paused the turn too many times');
    } catch (error) {
      if (aborted) return { blocks: [], aborted: true };
      const message = timedOut
        ? `Timed out: a single turn exceeded ${Math.round(config.turnTimeoutMs / 1000)}s`
        : error instanceof Error
          ? error.message
          : String(error);
      return { blocks: [], error: message, aborted: false };
    } finally {
      clearTimeout(timeout);
    }
  })();

  return {
    abort() {
      aborted = true;
      controller.abort();
    },
    done,
  };
}

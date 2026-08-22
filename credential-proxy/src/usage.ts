/* ------------------------------------------------------------------ *
 * Pull token usage out of three upstream protocols. Each hides it somewhere different:
 *
 *   Anthropic Messages (SSE)
 *     event: message_start → message.usage.{input_tokens,
 *            cache_read_input_tokens, cache_creation_input_tokens}
 *     event: message_delta → usage.output_tokens (cumulative, so the last one wins)
 *
 *   OpenAI chat/completions
 *     non-streaming → top-level usage.{prompt_tokens, completion_tokens}
 *     streaming     → a final usage chunk, but only if the client asked for
 *                     stream_options.include_usage
 *
 *   Codex responses (SSE)
 *     event: response.completed → response.usage.{input_tokens, output_tokens}
 * ------------------------------------------------------------------ */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  model?: string;
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Feed JSON objects in as they arrive and accumulate. One accumulator covers all three protocols. */
export class UsageAccumulator {
  readonly usage: Usage = emptyUsage();

  feedJson(obj: unknown): void {
    if (!obj || typeof obj !== 'object') return;
    const o = obj as Record<string, unknown>;

    const model = o['model'];
    if (typeof model === 'string' && !this.usage.model) this.usage.model = model;

    // Anthropic: message_start
    const message = o['message'] as Record<string, unknown> | undefined;
    if (message) {
      const m = message['model'];
      if (typeof m === 'string' && !this.usage.model) this.usage.model = m;
      this.absorbAnthropic(message['usage']);
    }
    // Anthropic: message_delta, with usage at the top level
    if (o['type'] === 'message_delta' || o['type'] === 'message_start') {
      this.absorbAnthropic(o['usage']);
    }
    // Codex responses
    const response = o['response'] as Record<string, unknown> | undefined;
    if (response) {
      const m = response['model'];
      if (typeof m === 'string' && !this.usage.model) this.usage.model = m;
      this.absorbOpenAI(response['usage']);
    }
    // OpenAI's top-level usage
    if (o['usage']) this.absorbOpenAI(o['usage']);
  }

  private absorbAnthropic(u: unknown): void {
    if (!u || typeof u !== 'object') return;
    const x = u as Record<string, unknown>;
    // input appears once, in message_start; output is cumulative, so max guards against a
    // late frame reporting less than an earlier one
    this.usage.inputTokens = Math.max(this.usage.inputTokens, num(x['input_tokens']));
    this.usage.outputTokens = Math.max(this.usage.outputTokens, num(x['output_tokens']));
    this.usage.cacheReadTokens = Math.max(
      this.usage.cacheReadTokens,
      num(x['cache_read_input_tokens']),
    );
    this.usage.cacheWriteTokens = Math.max(
      this.usage.cacheWriteTokens,
      num(x['cache_creation_input_tokens']),
    );
  }

  private absorbOpenAI(u: unknown): void {
    if (!u || typeof u !== 'object') return;
    const x = u as Record<string, unknown>;
    const input = num(x['prompt_tokens']) || num(x['input_tokens']);
    const output = num(x['completion_tokens']) || num(x['output_tokens']);
    this.usage.inputTokens = Math.max(this.usage.inputTokens, input);
    this.usage.outputTokens = Math.max(this.usage.outputTokens, output);

    const details = x['prompt_tokens_details'] as Record<string, unknown> | undefined;
    if (details) {
      this.usage.cacheReadTokens = Math.max(
        this.usage.cacheReadTokens,
        num(details['cached_tokens']),
      );
    }
    const inputDetails = x['input_tokens_details'] as Record<string, unknown> | undefined;
    if (inputDetails) {
      this.usage.cacheReadTokens = Math.max(
        this.usage.cacheReadTokens,
        num(inputDetails['cached_tokens']),
      );
    }
  }

  /** Feed a chunk of SSE text, which may hold several frames, or end mid-frame */
  feedSseChunk(text: string): void {
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        this.feedJson(JSON.parse(payload));
      } catch {
        /* A truncated frame; the next chunk carries it whole. Usage lives in small frames, so
           the odds of losing one this way are slim. */
      }
    }
  }

  feedBody(text: string, contentType: string): void {
    if (contentType.includes('text/event-stream')) {
      this.feedSseChunk(text);
      return;
    }
    try {
      this.feedJson(JSON.parse(text));
    } catch {
      /* A non-JSON response has no usage to pull out */
    }
  }
}

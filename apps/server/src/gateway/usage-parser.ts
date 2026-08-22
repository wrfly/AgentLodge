/**
 * Pulling usage out of an upstream response.
 *
 * The two agents speak entirely different protocols — confirmed by capture:
 *   Claude Code → POST /v1/messages    Anthropic Messages, where usage is split across
 *                 message_start (input and cache) and message_delta (output)
 *   Codex       → POST /responses      OpenAI Responses, where it all arrives at once in
 *                 response.usage on response.completed
 */

export interface UsageAcc {
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Time to first byte */
  ttftMs?: number;
  model?: string;
}

export function newUsageAcc(): UsageAcc {
  return { inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, outputTokens: 0 };
}

/**
 * anthropic  = Anthropic Messages（Claude Code）
 * responses  = OpenAI Responses, Codex's default
 * chat       = OpenAI Chat Completions, for local models and Codex's chat mode
 */
export type Wire = 'anthropic' | 'responses' | 'chat';

interface AnthropicEvent {
  type?: string;
  message?: { model?: string; usage?: Record<string, number> };
  usage?: Record<string, number>;
}

interface ResponsesEvent {
  type?: string;
  response?: {
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
  };
}

interface ChatEvent {
  model?: string;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    /** vLLM and DeepSeek's OpenAI layer provide this; Ollama does not */
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/** Parse one SSE data payload and accumulate usage into acc */
export function absorbEvent(wire: Wire, raw: string, acc: UsageAcc): void {
  let ev: unknown;
  try {
    ev = JSON.parse(raw);
  } catch {
    return;
  }

  if (wire === 'anthropic') {
    const e = ev as AnthropicEvent;
    if (e.type === 'message_start') {
      const u = e.message?.usage ?? {};
      acc.inputTokens += u.input_tokens ?? 0;
      acc.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      acc.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      acc.model ??= e.message?.model;
    } else if (e.type === 'message_delta') {
      // Cumulative rather than incremental, so take the maximum in case frames arrive out of order
      acc.outputTokens = Math.max(acc.outputTokens, e.usage?.output_tokens ?? 0);
    }
    return;
  }

  if (wire === 'chat') {
    // The chat protocol only reports usage on the final chunk, and only when the request
    // carried stream_options.include_usage
    const e = ev as ChatEvent;
    const u = e.usage;
    if (u) {
      const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
      acc.inputTokens = Math.max(acc.inputTokens, (u.prompt_tokens ?? 0) - cached);
      acc.cacheReadTokens = Math.max(acc.cacheReadTokens, cached);
      acc.outputTokens = Math.max(acc.outputTokens, u.completion_tokens ?? 0);
    }
    acc.model ??= e.model;
    return;
  }

  const e = ev as ResponsesEvent;
  if (e.type === 'response.completed' || e.type === 'response.incomplete') {
    const u = e.response?.usage;
    if (!u) return;
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    // Responses folds the cached part into input_tokens; splitting it out is what lets the
    // two be weighted differently
    acc.inputTokens = Math.max(acc.inputTokens, (u.input_tokens ?? 0) - cached);
    acc.cacheReadTokens = Math.max(acc.cacheReadTokens, cached);
    acc.outputTokens = Math.max(acc.outputTokens, u.output_tokens ?? 0);
    acc.model ??= e.response?.model;
  }
}

/** A non-streaming response: parse the body once */
export function absorbBody(wire: Wire, body: string, acc: UsageAcc): void {
  if (wire === 'anthropic') {
    try {
      const j = JSON.parse(body) as AnthropicEvent;
      const u = j.usage ?? {};
      acc.inputTokens += u.input_tokens ?? 0;
      acc.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      acc.cacheCreationTokens += u.cache_creation_input_tokens ?? 0;
      acc.outputTokens += u.output_tokens ?? 0;
    } catch {
      /* What came back was not JSON */
    }
    return;
  }
  absorbEvent(wire === 'chat' ? 'chat' : 'responses', body.replace(/^data:\s*/, ''), acc);
}

/** Feed a whole SSE text through the parser at once — the built-in upstream produces a string, not a stream */
export function absorbStream(wire: Wire, text: string, acc: UsageAcc): void {
  const sniffer = new SseSniffer(wire, acc);
  sniffer.push(text.endsWith('\n\n') ? text : `${text}\n\n`);
}

/**
 * The streaming SSE framer.
 *
 * It watches without rewriting: the byte stream is relayed to the client untouched,
 * because any change risks breaking the CLI's parsing.
 */
export class SseSniffer {
  private buf = '';
  constructor(
    private readonly wire: Wire,
    private readonly acc: UsageAcc,
  ) {}

  push(chunk: string): void {
    this.buf += chunk;
    let sep: number;
    while ((sep = this.buf.indexOf('\n\n')) !== -1) {
      const frame = this.buf.slice(0, sep);
      this.buf = this.buf.slice(sep + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data:')) absorbEvent(this.wire, line.slice(5).trim(), this.acc);
      }
    }
    // Bounded, so an upstream that never sends a separator cannot grow this without limit
    if (this.buf.length > 1_000_000) this.buf = this.buf.slice(-100_000);
  }
}

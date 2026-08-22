/**
 * Translation between Anthropic Messages and OpenAI Chat Completions.
 *
 * Why it exists: local models — Ollama, LM Studio, vLLM — only speak
 * `/chat/completions`, and Claude Code only speaks Anthropic Messages. Codex needs no
 * translation, since its configuration can set wire_api to "chat" directly.
 *
 * The translation happens in the gateway and neither end knows: the CLI believes it is
 * talking to Anthropic, the local model believes it is talking to an OpenAI client.
 *
 * Covered: system, multi-turn messages, text blocks, tool definitions, tool_use,
 * tool_result, streaming deltas, usage.
 * Not covered: image input, thinking blocks, prompt cache control — none of which a local
 * model has a concept of anyway.
 */

/* ---------------- Types ---------------- */

interface AnthropicBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicBlock[];
}

export interface AnthropicRequest {
  model?: string;
  system?: string | AnthropicBlock[];
  messages?: AnthropicMessage[];
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  stream?: boolean;
  tools?: { name: string; description?: string; input_schema?: unknown }[];
  tool_choice?: { type?: string; name?: string };
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

/* ---------------- Request: Anthropic to Chat ---------------- */

const textOf = (content: unknown): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b) => {
      const blk = b as AnthropicBlock;
      if (blk.type === 'text') return blk.text ?? '';
      // A tool_result's content can itself be an array of blocks
      if (blk.type === 'tool_result') return textOf(blk.content);
      return '';
    })
    .filter(Boolean)
    .join('\n');
};

export function anthropicRequestToChat(body: AnthropicRequest, model: string): unknown {
  const messages: ChatMessage[] = [];

  const system = textOf(body.system);
  if (system) messages.push({ role: 'system', content: system });

  for (const m of body.messages ?? []) {
    const blocks = Array.isArray(m.content) ? m.content : null;

    if (!blocks) {
      messages.push({ role: m.role, content: String(m.content ?? '') });
      continue;
    }

    // A tool_result has to become its own role:'tool' message — that is how OpenAI
    // expresses it
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    for (const t of toolResults) {
      messages.push({
        role: 'tool',
        tool_call_id: t.tool_use_id ?? '',
        content: textOf(t.content) || (t.is_error ? '(the tool failed)' : ''),
      });
    }

    const toolUses = blocks.filter((b) => b.type === 'tool_use');
    const text = textOf(blocks.filter((b) => b.type === 'text'));

    if (toolUses.length) {
      messages.push({
        role: 'assistant',
        content: text || null,
        tool_calls: toolUses.map((t) => ({
          id: t.id ?? '',
          type: 'function' as const,
          function: { name: t.name ?? '', arguments: JSON.stringify(t.input ?? {}) },
        })),
      });
    } else if (text || !toolResults.length) {
      messages.push({ role: m.role, content: text });
    }
  }

  return {
    model,
    messages,
    max_tokens: body.max_tokens,
    temperature: body.temperature,
    top_p: body.top_p,
    stop: body.stop_sequences,
    stream: body.stream !== false,
    // Without this an OpenAI-compatible endpoint reports no usage while streaming, and
    // there is nothing to bill from
    stream_options: body.stream !== false ? { include_usage: true } : undefined,
    tools: body.tools?.length
      ? body.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.input_schema ?? {} },
        }))
      : undefined,
    tool_choice: body.tool_choice?.type === 'tool' ? { type: 'function', function: { name: body.tool_choice.name } }
      : body.tool_choice?.type === 'any' ? 'required'
      : body.tool_choice?.type === 'auto' ? 'auto'
      : undefined,
  };
}

/* ---------------- Response: Chat SSE to Anthropic SSE ---------------- */

const STOP_REASON: Record<string, string> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'stop_sequence',
};

interface ChatChunk {
  model?: string;
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/**
 * Rewrite the chat delta stream as Anthropic's event stream.
 *
 * The two block models differ: an OpenAI delta may carry text and tool arguments at once,
 * while Anthropic has explicit content_block_start / delta / stop. So the open and closed
 * state of each block is tracked here.
 */
export class ChatToAnthropic {
  private buf = '';
  private started = false;
  private textOpen = false;
  private nextIndex = 0;
  /** OpenAI's tool_call index to the Anthropic block index we assigned */
  private toolBlocks = new Map<number, number>();
  private finish = 'end_turn';
  private outputTokens = 0;
  private model: string;

  constructor(model: string) {
    this.model = model;
  }

  private ev(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  /** Feed in upstream bytes; get back the Anthropic SSE text to write to the CLI */
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';

    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;

      let c: ChatChunk;
      try {
        c = JSON.parse(payload) as ChatChunk;
      } catch {
        continue;
      }
      out += this.absorb(c);
    }
    return out;
  }

  private absorb(c: ChatChunk): string {
    let out = '';

    if (!this.started) {
      this.started = true;
      out += this.ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          model: c.model ?? this.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          // The real numbers arrive later in message_delta; the upstream only reports
          // usage on the final chunk
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }

    const choice = c.choices?.[0];
    const delta = choice?.delta;

    if (delta?.content) {
      if (!this.textOpen) {
        this.textOpen = true;
        out += this.ev('content_block_start', {
          type: 'content_block_start',
          index: this.nextIndex,
          content_block: { type: 'text', text: '' },
        });
      }
      out += this.ev('content_block_delta', {
        type: 'content_block_delta',
        index: this.nextIndex,
        delta: { type: 'text_delta', text: delta.content },
      });
    }

    for (const call of delta?.tool_calls ?? []) {
      const idx = call.index ?? 0;
      let block = this.toolBlocks.get(idx);

      if (block === undefined) {
        // Open a new tool_use block. Any text block closes first — Anthropic does not
        // allow blocks to interleave
        if (this.textOpen) {
          out += this.ev('content_block_stop', { type: 'content_block_stop', index: this.nextIndex });
          this.textOpen = false;
          this.nextIndex += 1;
        }
        block = this.nextIndex;
        this.toolBlocks.set(idx, block);
        this.nextIndex += 1;
        out += this.ev('content_block_start', {
          type: 'content_block_start',
          index: block,
          content_block: { type: 'tool_use', id: call.id ?? `toolu_${idx}`, name: call.function?.name ?? '', input: {} },
        });
      }

      if (call.function?.arguments) {
        out += this.ev('content_block_delta', {
          type: 'content_block_delta',
          index: block,
          delta: { type: 'input_json_delta', partial_json: call.function.arguments },
        });
      }
    }

    if (choice?.finish_reason) this.finish = STOP_REASON[choice.finish_reason] ?? 'end_turn';
    if (c.usage?.completion_tokens) this.outputTokens = c.usage.completion_tokens;

    return out;
  }

  /** The upstream stream ended; emit the closing events */
  end(): string {
    let out = '';
    if (!this.started) {
      // The upstream produced nothing at all, most likely an error — the CLI still needs
      // a complete message
      out += this.ev('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_translated', type: 'message', role: 'assistant', model: this.model,
          content: [], stop_reason: null, stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      });
    }
    if (this.textOpen) {
      out += this.ev('content_block_stop', { type: 'content_block_stop', index: this.nextIndex });
      this.textOpen = false;
    }
    for (const block of this.toolBlocks.values()) {
      out += this.ev('content_block_stop', { type: 'content_block_stop', index: block });
    }
    out += this.ev('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.finish, stop_sequence: null },
      usage: { output_tokens: this.outputTokens },
    });
    out += this.ev('message_stop', { type: 'message_stop' });
    return out;
  }
}

/** Translation for a non-streaming response. CLIs stream almost always; this is for probes and as a fallback. */
export function chatResponseToAnthropic(text: string, model: string): string {
  let body: {
    model?: string;
    choices?: { message?: { content?: string; tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  try {
    body = JSON.parse(text);
  } catch {
    return text;
  }

  const msg = body.choices?.[0]?.message;
  const content: unknown[] = [];
  if (msg?.content) content.push({ type: 'text', text: msg.content });
  for (const [i, call] of (msg?.tool_calls ?? []).entries()) {
    let input: unknown = {};
    try {
      input = JSON.parse(call.function?.arguments ?? '{}');
    } catch {
      /* Arguments that are not valid JSON become an empty object rather than failing the whole response */
    }
    content.push({ type: 'tool_use', id: call.id ?? `toolu_${i}`, name: call.function?.name ?? '', input });
  }

  return JSON.stringify({
    id: 'msg_translated',
    type: 'message',
    role: 'assistant',
    model: body.model ?? model,
    content,
    stop_reason: STOP_REASON[body.choices?.[0]?.finish_reason ?? 'stop'] ?? 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    },
  });
}

/* ================================================================
 * OpenAI Responses ⇄ Chat Completions
 *
 * Codex 0.147 removed `wire_api = "chat"`, leaving only Responses. So pointing Codex at a
 * local model means the gateway translates that direction too. The request shape comes
 * from a capture: instructions + input[] + tools[].
 * ================================================================ */

interface ResponsesInputItem {
  type?: string;
  role?: string;
  content?: { type?: string; text?: string }[];
  name?: string;
  arguments?: string;
  call_id?: string;
  output?: unknown;
}

export interface ResponsesRequest {
  model?: string;
  instructions?: string;
  input?: ResponsesInputItem[];
  tools?: { type?: string; name?: string; description?: string; parameters?: unknown }[];
  tool_choice?: unknown;
  parallel_tool_calls?: boolean;
  max_output_tokens?: number;
  stream?: boolean;
}

export function responsesRequestToChat(body: ResponsesRequest, model: string): unknown {
  const messages: ChatMessage[] = [];

  if (body.instructions) messages.push({ role: 'system', content: body.instructions });

  for (const item of body.input ?? []) {
    if (item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: item.call_id ?? '',
            type: 'function',
            function: { name: item.name ?? '', arguments: item.arguments ?? '{}' },
          },
        ],
      });
      continue;
    }

    if (item.type === 'function_call_output') {
      messages.push({
        role: 'tool',
        tool_call_id: item.call_id ?? '',
        content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? ''),
      });
      continue;
    }

    const text = (item.content ?? [])
      .map((c) => c.text ?? '')
      .filter(Boolean)
      .join('\n');
    if (!text) continue;

    // The developer role is specific to Responses; on the chat side it becomes system
    const role = item.role === 'assistant' ? 'assistant' : item.role === 'developer' ? 'system' : 'user';
    messages.push({ role, content: text });
  }

  return {
    model,
    messages,
    max_tokens: body.max_output_tokens,
    stream: body.stream !== false,
    stream_options: body.stream !== false ? { include_usage: true } : undefined,
    parallel_tool_calls: body.parallel_tool_calls,
    tools: body.tools?.length
      ? body.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters ?? {} },
        }))
      : undefined,
    tool_choice: body.tool_choice,
  };
}

/**
 * The chat delta stream as a Responses event stream.
 *
 * The sequence copies what a real Codex accepts, verified against the mock upstream:
 *   response.created → output_item.added → content_part.added
 *   → output_text.delta* → output_text.done → content_part.done
 *   → output_item.done → response.completed
 */
export class ChatToResponses {
  private buf = '';
  private created = false;
  private msgOpen = false;
  private text = '';
  private outputIndex = 0;
  private outputTokens = 0;
  private inputTokens = 0;
  private model: string;
  /** OpenAI's tool_call index to the function_call entry already emitted */
  private tools = new Map<number, { id: string; callId: string; name: string; args: string; index: number }>();

  constructor(model: string) {
    this.model = model;
  }

  private ev(event: string, data: unknown): string {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  }

  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    const parts = this.buf.split('\n');
    this.buf = parts.pop() ?? '';

    for (const line of parts) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const payload = t.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        out += this.absorb(JSON.parse(payload) as ChatChunk);
      } catch {
        /* Not valid JSON: skip this frame */
      }
    }
    return out;
  }

  private absorb(c: ChatChunk): string {
    let out = '';

    if (!this.created) {
      this.created = true;
      out += this.ev('response.created', {
        type: 'response.created',
        response: { id: 'resp_translated', model: c.model ?? this.model, status: 'in_progress', output: [] },
      });
    }

    const delta = c.choices?.[0]?.delta;

    if (delta?.content) {
      if (!this.msgOpen) {
        this.msgOpen = true;
        out += this.ev('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: this.outputIndex,
          item: { type: 'message', id: 'msg_translated', role: 'assistant', status: 'in_progress', content: [] },
        });
        out += this.ev('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: 'msg_translated',
          output_index: this.outputIndex,
          content_index: 0,
          part: { type: 'output_text', text: '' },
        });
      }
      this.text += delta.content;
      out += this.ev('response.output_text.delta', {
        type: 'response.output_text.delta',
        item_id: 'msg_translated',
        output_index: this.outputIndex,
        content_index: 0,
        delta: delta.content,
      });
    }

    for (const call of delta?.tool_calls ?? []) {
      const idx = call.index ?? 0;
      let entry = this.tools.get(idx);
      if (!entry) {
        // Close the text entry first — a Responses output_index only moves forward
        if (this.msgOpen) {
          out += this.closeMessage();
          this.msgOpen = false;
          this.outputIndex += 1;
        }
        entry = {
          id: `fc_${idx}`,
          callId: call.id ?? `call_${idx}`,
          name: call.function?.name ?? '',
          args: '',
          index: this.outputIndex,
        };
        this.tools.set(idx, entry);
        this.outputIndex += 1;
        out += this.ev('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: entry.index,
          item: { type: 'function_call', id: entry.id, call_id: entry.callId, name: entry.name, arguments: '' },
        });
      }
      if (call.function?.arguments) {
        entry.args += call.function.arguments;
        out += this.ev('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta',
          item_id: entry.id,
          output_index: entry.index,
          delta: call.function.arguments,
        });
      }
    }

    if (c.usage?.completion_tokens) this.outputTokens = c.usage.completion_tokens;
    if (c.usage?.prompt_tokens) this.inputTokens = c.usage.prompt_tokens;

    return out;
  }

  private closeMessage(): string {
    const part = { type: 'output_text', text: this.text, annotations: [] };
    return (
      this.ev('response.output_text.done', {
        type: 'response.output_text.done',
        item_id: 'msg_translated',
        output_index: this.outputIndex,
        content_index: 0,
        text: this.text,
      }) +
      this.ev('response.content_part.done', {
        type: 'response.content_part.done',
        item_id: 'msg_translated',
        output_index: this.outputIndex,
        content_index: 0,
        part,
      }) +
      this.ev('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: this.outputIndex,
        item: { type: 'message', id: 'msg_translated', role: 'assistant', status: 'completed', content: [part] },
      })
    );
  }

  end(): string {
    let out = '';
    const output: unknown[] = [];

    if (!this.created) {
      out += this.ev('response.created', {
        type: 'response.created',
        response: { id: 'resp_translated', model: this.model, status: 'in_progress', output: [] },
      });
    }

    if (this.msgOpen) {
      out += this.closeMessage();
      output.push({
        type: 'message', id: 'msg_translated', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: this.text, annotations: [] }],
      });
    }

    for (const entry of this.tools.values()) {
      out += this.ev('response.function_call_arguments.done', {
        type: 'response.function_call_arguments.done',
        item_id: entry.id,
        output_index: entry.index,
        arguments: entry.args,
      });
      const item = { type: 'function_call', id: entry.id, call_id: entry.callId, name: entry.name, arguments: entry.args, status: 'completed' };
      out += this.ev('response.output_item.done', {
        type: 'response.output_item.done',
        output_index: entry.index,
        item,
      });
      output.push(item);
    }

    out += this.ev('response.completed', {
      type: 'response.completed',
      response: {
        id: 'resp_translated',
        model: this.model,
        status: 'completed',
        output,
        usage: {
          input_tokens: this.inputTokens,
          output_tokens: this.outputTokens,
          total_tokens: this.inputTokens + this.outputTokens,
        },
      },
    });
    return out;
  }
}

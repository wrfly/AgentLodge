import type { MessageBlock, ServerEvent, ToolBlock, TurnUsage } from '../../../core/protocol.js';

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  server_tool_use?: { web_search_requests?: number };
}

interface StreamEvent {
  type?: string;
  index?: number;
  content_block?: {
    type?: string;
    id?: string;
    name?: string;
    input?: unknown;
    text?: string;
    content?: unknown;
    tool_use_id?: string;
    is_error?: boolean;
    signature?: string;
  };
  delta?: {
    type?: string;
    text?: string;
    thinking?: string;
    partial_json?: string;
    signature?: string;
    stop_reason?: string | null;
  };
  message?: { usage?: Usage };
  usage?: Usage;
  error?: { message?: string };
}

/**
 * Turns Anthropic's native message stream into the event and persisted-block shapes used
 * by the existing web client. It deliberately owns no transport, which makes recorded SSE
 * fixtures usable as tests without a server.
 */
export class NativeEvents {
  private readonly blocks = new Map<number, MessageBlock>();
  private readonly order: number[] = [];
  private readonly toolInput = new Map<number, string>();
  private readonly blockByToolId = new Map<string, ToolBlock>();
  private readonly rawBlocks = new Map<number, Record<string, unknown>>();
  private stopReason: string | null = null;
  private readonly usage: TurnUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
    webSearchRequests: 0,
  };

  constructor(
    private readonly emit: (event: ServerEvent) => void,
    private readonly blockOffset = 0,
  ) {}

  accept(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const event = value as StreamEvent;

    switch (event.type) {
      case 'message_start':
        this.absorbUsage(event.message?.usage);
        break;
      case 'content_block_start':
        this.start(event.index ?? 0, event.content_block);
        break;
      case 'content_block_delta':
        this.delta(event.index ?? 0, event.delta);
        break;
      case 'content_block_stop':
        this.stop(event.index ?? 0);
        break;
      case 'message_delta':
        this.absorbUsage(event.usage);
        this.stopReason = event.delta?.stop_reason ?? this.stopReason;
        break;
      case 'error':
        throw new Error(event.error?.message || 'The upstream stream returned an error');
    }
  }

  finish(durationMs: number): {
    blocks: MessageBlock[];
    usage: TurnUsage;
    rawContent: Array<Record<string, unknown>>;
    stopReason: string | null;
    nextBlockId: number;
  } {
    this.usage.durationMs = durationMs;

    for (const [blockId, partial] of this.toolInput) {
      const block = this.blocks.get(blockId);
      if (block?.kind !== 'tool_use' || !partial) continue;
      try {
        block.input = JSON.parse(partial);
      } catch {
        block.input = { _raw: partial };
      }
      const raw = this.rawBlocks.get(blockId - this.blockOffset);
      if (raw) raw.input = block.input;
      this.emit({ type: 'tool.input', blockId, input: block.input });
    }

    return {
      blocks: this.order
        .map((id) => this.blocks.get(id))
        .filter((block): block is MessageBlock => Boolean(block))
        .filter((block) =>
          block.kind === 'tool_use'
            ? true
            : block.text.trim().length > 0 || (block.kind === 'thinking' && Boolean(block.tokens)),
        ),
      usage: { ...this.usage },
      rawContent: [...this.rawBlocks.entries()]
        .sort(([a], [b]) => a - b)
        .map(([, block]) => block),
      stopReason: this.stopReason,
      nextBlockId: this.blockOffset
        + (this.rawBlocks.size ? Math.max(...this.rawBlocks.keys()) + 1 : 0),
    };
  }

  private start(
    blockId: number,
    block: StreamEvent['content_block'],
  ): void {
    if (!block) return;
    const rawIndex = blockId;
    blockId += this.blockOffset;
    this.rawBlocks.set(rawIndex, { ...block });

    if (block.type === 'thinking' || block.type === 'redacted_thinking') {
      this.order.push(blockId);
      this.blocks.set(blockId, { kind: 'thinking', blockId, text: block.text ?? '' });
      this.emit({ type: 'block.start', blockId, kind: 'thinking' });
      return;
    }

    if (block.type === 'tool_use' || block.type === 'server_tool_use') {
      this.order.push(blockId);
      const toolId = block.id ?? `tool_${blockId}`;
      const toolName = block.name ?? 'unknown';
      const value: ToolBlock = {
        kind: 'tool_use',
        blockId,
        toolId,
        toolName,
        input: block.input ?? {},
        server: block.type === 'server_tool_use' || undefined,
      };
      this.blocks.set(blockId, value);
      this.blockByToolId.set(toolId, value);
      this.toolInput.set(blockId, '');
      this.emit({ type: 'block.start', blockId, kind: 'tool_use', toolId, toolName });
      return;
    }

    if (block.type?.endsWith('_tool_result')) {
      const toolId = block.tool_use_id ?? '';
      const content = typeof block.content === 'string'
        ? block.content
        : JSON.stringify(block.content ?? {}, null, 2);
      const result = { isError: Boolean(block.is_error), content };
      const tool = this.blockByToolId.get(toolId);
      if (tool) {
        tool.result = result;
        if (tool.server) tool.serverResult = { ...block };
      }
      if (toolId) this.emit({ type: 'tool.result', toolId, ...result });
      return;
    }

    this.order.push(blockId);
    this.blocks.set(blockId, { kind: 'text', blockId, text: block.text ?? '' });
    this.emit({ type: 'block.start', blockId, kind: 'text' });
    if (block.text) this.emit({ type: 'text.delta', blockId, text: block.text });
  }

  private delta(index: number, delta: StreamEvent['delta']): void {
    if (!delta) return;
    const blockId = index + this.blockOffset;
    const block = this.blocks.get(blockId);
    const raw = this.rawBlocks.get(index);
    if (delta.type === 'text_delta' && delta.text && block?.kind === 'text') {
      block.text += delta.text;
      if (raw) raw.text = `${String(raw.text ?? '')}${delta.text}`;
      this.emit({ type: 'text.delta', blockId, text: delta.text });
    } else if (delta.type === 'thinking_delta' && block?.kind === 'thinking') {
      const text = delta.thinking ?? '';
      block.text += text;
      if (raw) raw.thinking = `${String(raw.thinking ?? '')}${text}`;
      if (text) this.emit({ type: 'thinking.delta', blockId, text });
    } else if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
      this.toolInput.set(blockId, (this.toolInput.get(blockId) ?? '') + delta.partial_json);
      this.emit({ type: 'tool.input.delta', blockId, partial: delta.partial_json });
    } else if (delta.type === 'signature_delta' && delta.signature && raw) {
      raw.signature = `${String(raw.signature ?? '')}${delta.signature}`;
    }
  }

  private stop(index: number): void {
    const blockId = index + this.blockOffset;
    if (this.blocks.has(blockId)) this.emit({ type: 'block.stop', blockId });
  }

  private absorbUsage(usage?: Usage): void {
    if (!usage) return;
    if (usage.input_tokens !== undefined) this.usage.inputTokens = usage.input_tokens;
    if (usage.output_tokens !== undefined) this.usage.outputTokens = usage.output_tokens;
    if (usage.cache_read_input_tokens !== undefined) {
      this.usage.cacheReadTokens = usage.cache_read_input_tokens;
    }
    if (usage.cache_creation_input_tokens !== undefined) {
      this.usage.cacheCreationTokens = usage.cache_creation_input_tokens;
    }
    if (usage.server_tool_use?.web_search_requests !== undefined) {
      this.usage.webSearchRequests = usage.server_tool_use.web_search_requests;
    }
  }
}

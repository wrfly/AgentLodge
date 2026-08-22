import readline from 'node:readline';
import { config } from '../../core/config.js';
import type { MessageBlock, ToolBlock, TurnUsage } from '../../core/protocol.js';
import { probeBin } from './probe.js';
import { claudeEnv } from './provider.js';
import { launch } from './launch.js';
import { getString } from '../../core/db/settings.js';
import * as providers from '../../core/db/providers.js';
import type {
  AgentAdapter,
  EffortOption,
  ModelOption,
  RunOptions,
  RunningTurn,
  TurnResult,
} from './types.js';

/* ---------- Claude Code's raw stream-json events; only the fields used here ---------- */

interface RawStreamEvent {
  type: 'stream_event';
  event: {
    type: string;
    index?: number;
    content_block?: { type: string; id?: string; name?: string };
    delta?: {
      type: string;
      text?: string;
      thinking?: string;
      partial_json?: string;
    };
  };
}

interface RawAssistant {
  type: 'assistant';
  message: { content: Array<{ type: string; id?: string; name?: string; input?: unknown }> };
}

interface RawUser {
  type: 'user';
  message: {
    content: Array<{
      type: string;
      tool_use_id?: string;
      is_error?: boolean;
      content?: unknown;
    }>;
  };
}

interface RawResult {
  type: 'result';
  subtype: string;
  is_error?: boolean;
  result?: string;
  duration_ms?: number;
  num_turns?: number;
  total_cost_usd?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

type RawLine =
  | RawStreamEvent
  | RawAssistant
  | RawUser
  | RawResult
  | { type: string; [k: string]: unknown };

/** Normalise a tool_result's content — a string or an array of blocks — to plain text */
function flattenToolResult(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => {
        if (typeof c === 'string') return c;
        if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text);
        return JSON.stringify(c);
      })
      .join('\n');
  }
  if (content == null) return '';
  return JSON.stringify(content, null, 2);
}

function runTurn(o: RunOptions): RunningTurn {
  const args = [
    '-p',
    o.prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode',
    config.permissionMode,
  ];
  if (o.model) args.push('--model', o.model);
  if (o.effort) args.push('--effort', o.effort);
  if (o.resumeSessionId) args.push('--resume', o.resumeSessionId);

  const child = launch(o, config.claudeBin, args, claudeEnv(o.runtimeToken, Boolean(o.containerName)), [
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_MODEL',
  ]);

  /* ---- Parser state ---- */
  let msgIndex = -1;
  let nextBlockId = 0;
  /** `${msgIndex}:${rawIndex}` to the global blockId we assigned */
  const blockIdByKey = new Map<string, number>();
  /** blockId to the block being accumulated */
  const blocks = new Map<number, MessageBlock>();
  const order: number[] = [];
  /** toolUseId -> blockId */
  const blockIdByToolId = new Map<string, number>();
  /** Buffer for assembling a tool_use's streamed arguments */
  const toolInputBuf = new Map<number, string>();

  let usage: TurnUsage | undefined;
  let errorMessage: string | undefined;
  let aborted = false;
  let stderrTail = '';
  let settled = false;

  const emit = o.onEvent;

  const timeout = setTimeout(() => {
    errorMessage = `Timed out: a single turn exceeded ${Math.round(config.turnTimeoutMs / 1000)}s`;
    kill();
  }, config.turnTimeoutMs);

  function keyFor(rawIndex: number) {
    return `${msgIndex}:${rawIndex}`;
  }

  function upsertOrder(id: number) {
    if (!order.includes(id)) order.push(id);
  }

  function handleStreamEvent(ev: RawStreamEvent['event']) {
    switch (ev.type) {
      case 'message_start':
        msgIndex += 1;
        break;

      case 'content_block_start': {
        const raw = ev.index ?? 0;
        const cb = ev.content_block;
        if (!cb) break;
        const blockId = nextBlockId++;
        blockIdByKey.set(keyFor(raw), blockId);
        upsertOrder(blockId);

        if (cb.type === 'tool_use') {
          const toolId = cb.id ?? `tool_${blockId}`;
          const toolName = cb.name ?? 'unknown';
          blockIdByToolId.set(toolId, blockId);
          toolInputBuf.set(blockId, '');
          const block: ToolBlock = { kind: 'tool_use', blockId, toolId, toolName, input: {} };
          blocks.set(blockId, block);
          emit({ type: 'block.start', blockId, kind: 'tool_use', toolId, toolName });
        } else if (cb.type === 'thinking') {
          blocks.set(blockId, { kind: 'thinking', blockId, text: '' });
          emit({ type: 'block.start', blockId, kind: 'thinking' });
        } else {
          blocks.set(blockId, { kind: 'text', blockId, text: '' });
          emit({ type: 'block.start', blockId, kind: 'text' });
        }
        break;
      }

      case 'content_block_delta': {
        const blockId = blockIdByKey.get(keyFor(ev.index ?? 0));
        if (blockId === undefined) break;
        const d = ev.delta;
        if (!d) break;
        const block = blocks.get(blockId);

        if (d.type === 'text_delta' && d.text) {
          if (block?.kind === 'text') block.text += d.text;
          emit({ type: 'text.delta', blockId, text: d.text });
        } else if (d.type === 'thinking_delta' && d.thinking) {
          if (block?.kind === 'thinking') block.text += d.thinking;
          emit({ type: 'thinking.delta', blockId, text: d.thinking });
        } else if (d.type === 'input_json_delta' && d.partial_json !== undefined) {
          toolInputBuf.set(blockId, (toolInputBuf.get(blockId) ?? '') + d.partial_json);
          emit({ type: 'tool.input.delta', blockId, partial: d.partial_json });
        }
        // signature_delta is the thinking signature; the interface has no use for it
        break;
      }

      case 'content_block_stop': {
        const blockId = blockIdByKey.get(keyFor(ev.index ?? 0));
        if (blockId === undefined) break;
        emit({ type: 'block.stop', blockId });
        break;
      }
    }
  }

  /** The assistant event carries the complete message, which corrects the arguments assembled from the stream */
  function handleAssistant(raw: RawAssistant) {
    for (const c of raw.message?.content ?? []) {
      if (c.type !== 'tool_use' || !c.id) continue;
      const blockId = blockIdByToolId.get(c.id);
      if (blockId === undefined) continue;
      const block = blocks.get(blockId);
      if (block?.kind === 'tool_use') block.input = c.input ?? {};
      emit({ type: 'tool.input', blockId, input: c.input ?? {} });
    }
  }

  function handleUser(raw: RawUser) {
    for (const c of raw.message?.content ?? []) {
      if (c.type !== 'tool_result' || !c.tool_use_id) continue;
      const content = flattenToolResult(c.content);
      const isError = Boolean(c.is_error);
      const blockId = blockIdByToolId.get(c.tool_use_id);
      if (blockId !== undefined) {
        const block = blocks.get(blockId);
        if (block?.kind === 'tool_use') block.result = { isError, content };
      }
      emit({ type: 'tool.result', toolId: c.tool_use_id, isError, content });
    }
  }

  function handleResult(raw: RawResult) {
    usage = {
      inputTokens: raw.usage?.input_tokens ?? 0,
      outputTokens: raw.usage?.output_tokens ?? 0,
      cacheReadTokens: raw.usage?.cache_read_input_tokens ?? 0,
      cacheCreationTokens: raw.usage?.cache_creation_input_tokens ?? 0,
      costUsd: raw.total_cost_usd ?? 0,
      durationMs: raw.duration_ms ?? 0,
      numTurns: raw.num_turns ?? 0,
    };
    if (raw.is_error || (raw.subtype && raw.subtype !== 'success')) {
      errorMessage ??= raw.result || `Claude returned an error: ${raw.subtype}`;
    }
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed || !trimmed.startsWith('{')) return;
    let raw: RawLine;
    try {
      raw = JSON.parse(trimmed) as RawLine;
    } catch {
      return; // non-JSON output, which is rare, is ignored
    }

    const sid = (raw as { session_id?: string }).session_id;
    if (typeof sid === 'string' && sid) o.onSessionId(sid);

    switch (raw.type) {
      case 'stream_event':
        handleStreamEvent((raw as RawStreamEvent).event);
        break;
      case 'assistant':
        handleAssistant(raw as RawAssistant);
        break;
      case 'user':
        handleUser(raw as RawUser);
        break;
      case 'result':
        handleResult(raw as RawResult);
        break;
      default:
        break; // system, rate_limit_event and the like, none of which the interface uses yet
    }
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString('utf8')).slice(-4000);
  });

  function kill() {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill('SIGINT');
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }, 3000).unref();
  }

  const done = new Promise<TurnResult>((resolve) => {
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      rl.close();

      if (!aborted && code !== 0 && !errorMessage) {
        errorMessage = stderrTail.trim() || `the claude process exited with code ${code}`;
      }

      // Fall back to the assembled arguments when no assistant event arrived
      for (const [blockId, buf] of toolInputBuf) {
        const block = blocks.get(blockId);
        if (block?.kind !== 'tool_use') continue;
        const empty = !block.input || Object.keys(block.input as object).length === 0;
        if (empty && buf) {
          try {
            block.input = JSON.parse(buf);
          } catch {
            block.input = { _raw: buf };
          }
        }
      }

      const finalBlocks = order
        .map((id) => blocks.get(id))
        .filter((b): b is MessageBlock => Boolean(b))
        // Drop entirely empty blocks, such as a thinking block carrying only a signature
        .filter((b) => (b.kind === 'tool_use' ? true : b.text.trim().length > 0));

      resolve({ blocks: finalBlocks, usage, error: errorMessage, aborted });
    };

    child.on('close', finish);
    child.on('error', (err) => {
      errorMessage ??= `Could not start ${config.claudeBin}: ${err.message}`;
      finish(-1);
    });
  });

  return {
    abort() {
      aborted = true;
      kill();
    },
    done,
  };
}

/**
 * Claude Code has no "list models" command, so this comes from configuration.
 *
 * The defaults are three aliases rather than concrete names, because aliases hold against
 * both the official API and third-party endpoints: pointed at DeepSeek, environment
 * variables such as ANTHROPIC_DEFAULT_OPUS_MODEL map them across. Override with
 * CLAUDE_MODELS, or type a name in the interface, when something exact is needed.
 */
async function claudeModels(): Promise<ModelOption[]> {
  // Order of preference: the active provider, then the environment, then the built-in
  // defaults. The list follows the provider, because a model name is a property of the
  // endpoint and switching upstream switches the whole set.
  const configured = providers.active()?.models ?? [];
  if (configured.length) return configured.map((id) => ({ id, label: id }));
  if (config.claudeModels.length) {
    return config.claudeModels.map((id) => ({ id, label: id }));
  }
  return [
    { id: '', label: 'Default', hint: "The model the CLI is configured with" },
    { id: 'opus', label: 'opus', hint: 'An alias the CLI maps to a real model' },
    { id: 'sonnet', label: 'sonnet', hint: 'An alias' },
    { id: 'haiku', label: 'haiku', hint: 'An alias' },
  ];
}

// claude --help: --effort <level> (low, medium, high, xhigh, max)
const CLAUDE_EFFORTS: EffortOption[] = [
  { id: '', label: 'Default' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
];

export const claudeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'Claude Code',
  bin: config.claudeBin,
  probe: () => probeBin(config.claudeBin, ['--version']),
  models: claudeModels,
  efforts: () => CLAUDE_EFFORTS,
  run: runTurn,
};

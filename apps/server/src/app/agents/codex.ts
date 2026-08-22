import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { config } from '../../core/config.js';
import type { MessageBlock, ToolBlock, TurnUsage } from '../../core/protocol.js';
import { probeBin } from './probe.js';
import { codexProviderArgs } from './provider.js';
import { launch } from './launch.js';
import * as providers from '../../core/db/providers.js';
import type {
  AgentAdapter,
  EffortOption,
  ModelOption,
  RunOptions,
  RunningTurn,
  TurnResult,
} from './types.js';

/* ---------- The event shapes of `codex exec --json`, as measured on codex-cli 0.147.0 ---------- */

interface CodexItem {
  id: string;
  type: string;
  /** agent_message */
  text?: string;
  /** reasoning */
  summary?: string;
  /** command_execution */
  command?: string;
  aggregated_output?: string;
  exit_code?: number | null;
  status?: string;
  /** file_change */
  changes?: unknown;
  /** mcp_tool_call */
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  /** web_search */
  query?: string;
  /** error */
  message?: string;
  [k: string]: unknown;
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    cache_write_input_tokens?: number;
    output_tokens?: number;
    reasoning_output_tokens?: number;
  };
  error?: { message?: string };
  message?: string;
}

/** codex's item types to the tool names in our protocol */
function toolNameFor(item: CodexItem): string {
  switch (item.type) {
    case 'command_execution':
      return 'Shell';
    case 'file_change':
      return 'ApplyPatch';
    case 'mcp_tool_call':
      return `${item.server ?? 'mcp'}.${item.tool ?? 'call'}`;
    case 'web_search':
      return 'WebSearch';
    case 'todo_list':
      return 'TodoList';
    default:
      return item.type;
  }
}

function toolInputFor(item: CodexItem): unknown {
  switch (item.type) {
    case 'command_execution':
      return { command: item.command ?? '' };
    case 'file_change':
      return { changes: item.changes ?? {} };
    case 'mcp_tool_call':
      return item.arguments ?? {};
    case 'web_search':
      return { query: item.query ?? '' };
    default: {
      // Drop the noisy fields and show what is left as the arguments
      const { id, type, status, ...rest } = item;
      void id;
      void type;
      void status;
      return rest;
    }
  }
}

function toolResultFor(item: CodexItem): { isError: boolean; content: string } | undefined {
  if (item.type === 'command_execution') {
    const code = item.exit_code ?? 0;
    return { isError: code !== 0, content: item.aggregated_output ?? '' };
  }
  if (item.type === 'mcp_tool_call') {
    return {
      isError: item.status === 'failed',
      content:
        typeof item.result === 'string' ? item.result : JSON.stringify(item.result ?? {}, null, 2),
    };
  }
  if (item.type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const lines = changes.map((c) => {
      const { kind, path: p } = (c ?? {}) as { kind?: string; path?: string };
      return `${(kind ?? 'change').padEnd(7)} ${p ?? ''}`;
    });
    return { isError: item.status === 'failed', content: lines.join('\n') };
  }
  if (item.type === 'todo_list' || item.type === 'web_search') {
    return { isError: false, content: '' };
  }
  return undefined;
}

function runTurn(o: RunOptions): RunningTurn {
  // resume is a subcommand: codex exec resume <thread_id> [prompt]
  const args = o.resumeSessionId ? ['exec', 'resume', o.resumeSessionId] : ['exec'];

  args.push('--json', '--skip-git-repo-check');

  // The resume subcommand takes neither --sandbox nor -C, but both paths accept -c, so
  // sandbox_mode goes through -c uniformly and the working directory comes from spawn's cwd.
  args.push('-c', `sandbox_mode="${config.codexSandbox}"`);
  args.push(...codexProviderArgs(o.runtimeToken, Boolean(o.containerName)));

  if (o.model) args.push('-m', o.model);
  // codex has no --effort flag, so this goes through a configuration override
  if (o.effort) args.push('-c', `model_reasoning_effort="${o.effort}"`);
  args.push(o.prompt);

  // codex takes its credential through -c, so no extra environment variable is needed
  const child = launch(o, config.codexBin, args, process.env);

  /* ---- Parser state ---- */
  let nextBlockId = 0;
  const blockIdByItemId = new Map<string, number>();
  const blocks = new Map<number, MessageBlock>();
  const order: number[] = [];

  let usage: TurnUsage | undefined;
  let errorMessage: string | undefined;
  let aborted = false;
  let stderrTail = '';
  let settled = false;
  const startedAt = Date.now();
  let turnCount = 0;

  const emit = o.onEvent;

  const timeout = setTimeout(() => {
    errorMessage = `Timed out: a single turn exceeded ${Math.round(config.turnTimeoutMs / 1000)}s`;
    kill();
  }, config.turnTimeoutMs);

  function allocBlock(itemId: string): number {
    const existing = blockIdByItemId.get(itemId);
    if (existing !== undefined) return existing;
    const blockId = nextBlockId++;
    blockIdByItemId.set(itemId, blockId);
    order.push(blockId);
    return blockId;
  }

  function startItem(item: CodexItem) {
    const blockId = allocBlock(item.id);
    if (blocks.has(blockId)) return;

    if (item.type === 'agent_message') {
      blocks.set(blockId, { kind: 'text', blockId, text: '' });
      emit({ type: 'block.start', blockId, kind: 'text' });
      return;
    }
    if (item.type === 'reasoning') {
      blocks.set(blockId, { kind: 'thinking', blockId, text: '' });
      emit({ type: 'block.start', blockId, kind: 'thinking' });
      return;
    }
    const toolName = toolNameFor(item);
    const block: ToolBlock = {
      kind: 'tool_use',
      blockId,
      toolId: item.id,
      toolName,
      input: toolInputFor(item),
    };
    blocks.set(blockId, block);
    emit({ type: 'block.start', blockId, kind: 'tool_use', toolId: item.id, toolName });
    emit({ type: 'tool.input', blockId, input: block.input });
  }

  function completeItem(item: CodexItem) {
    startItem(item); // an item.completed may arrive with no matching item.started
    const blockId = blockIdByItemId.get(item.id)!;
    const block = blocks.get(blockId);
    if (!block) return;

    if (block.kind === 'text' || block.kind === 'thinking') {
      // codex sends no deltas; the whole thing arrives at once
      const text = (item.type === 'reasoning' ? (item.summary ?? item.text) : item.text) ?? '';
      block.text = text;
      emit(
        block.kind === 'text'
          ? { type: 'text.delta', blockId, text }
          : { type: 'thinking.delta', blockId, text },
      );
      emit({ type: 'block.stop', blockId });
      return;
    }

    block.input = toolInputFor(item);
    emit({ type: 'tool.input', blockId, input: block.input });

    const result = toolResultFor(item);
    if (result) {
      block.result = result;
      emit({ type: 'tool.result', toolId: item.id, ...result });
    }
    emit({ type: 'block.stop', blockId });
  }

  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) return;
    let ev: CodexEvent;
    try {
      ev = JSON.parse(trimmed) as CodexEvent;
    } catch {
      return;
    }

    switch (ev.type) {
      case 'thread.started':
        if (ev.thread_id) o.onSessionId(ev.thread_id);
        break;
      case 'turn.started':
        turnCount += 1;
        break;
      case 'item.started':
        if (ev.item) startItem(ev.item);
        break;
      case 'item.updated':
        // Only status changes so far, which the interface does not need
        break;
      case 'item.completed':
        if (ev.item) completeItem(ev.item);
        break;
      case 'turn.completed':
        usage = {
          inputTokens: ev.usage?.input_tokens ?? 0,
          outputTokens:
            (ev.usage?.output_tokens ?? 0) + (ev.usage?.reasoning_output_tokens ?? 0),
          cacheReadTokens: ev.usage?.cached_input_tokens ?? 0,
          cacheCreationTokens: ev.usage?.cache_write_input_tokens ?? 0,
          // codex reports no cost; the metering gateway computes it
          costUsd: 0,
          durationMs: Date.now() - startedAt,
          numTurns: turnCount,
        };
        break;
      case 'turn.failed':
      case 'error':
        errorMessage ??= ev.error?.message ?? ev.message ?? 'Codex returned an error';
        break;
      default:
        break;
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
        // codex writes notes such as "Reading additional input from stdin..." to stderr
        const noise = /Reading additional input/i;
        const tail = stderrTail
          .split('\n')
          .filter((l) => l.trim() && !noise.test(l))
          .join('\n')
          .trim();
        errorMessage = tail || `the codex process exited with code ${code}`;
      }

      const finalBlocks = order
        .map((id) => blocks.get(id))
        .filter((b): b is MessageBlock => Boolean(b))
        .filter((b) => (b.kind === 'tool_use' ? true : b.text.trim().length > 0));

      resolve({ blocks: finalBlocks, usage, error: errorMessage, aborted });
    };

    child.on('close', finish);
    child.on('error', (err) => {
      errorMessage ??= `Could not start ${config.codexBin}: ${err.message}`;
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

/** codex ships its own model list (model_catalog_json in config.toml); read it directly */
async function codexModels(): Promise<ModelOption[]> {
  // As with claude: the list belongs to the active provider, then the environment, then
  // codex's own models.json
  const configured = providers.active()?.models ?? [];
  if (configured.length) return configured.map((id) => ({ id, label: id }));
  if (config.codexModels.length) {
    return config.codexModels.map((id) => ({ id, label: id }));
  }
  const catalog = path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'models.json');
  try {
    const raw = JSON.parse(await fs.readFile(catalog, 'utf8')) as {
      models?: Array<string | { id?: string; slug?: string; name?: string }>;
    };
    const ids = (raw.models ?? [])
      .map((m) => (typeof m === 'string' ? m : (m.id ?? m.slug ?? m.name)))
      .filter((v): v is string => Boolean(v));
    if (ids.length) {
      return [
        { id: '', label: 'Default', hint: 'The model configured in config.toml' },
        ...ids.map((id) => ({ id, label: id })),
      ];
    }
  } catch {
    /* No such file: fall back to the defaults */
  }
  return [{ id: '', label: 'Default', hint: 'The model configured in config.toml' }];
}

// Measured: an invalid value comes back as `expected one of none, minimal, low, medium, high, xhigh, max`
const CODEX_EFFORTS: EffortOption[] = [
  { id: '', label: 'Default' },
  { id: 'none', label: 'none' },
  { id: 'minimal', label: 'minimal' },
  { id: 'low', label: 'low' },
  { id: 'medium', label: 'medium' },
  { id: 'high', label: 'high' },
  { id: 'xhigh', label: 'xhigh' },
  { id: 'max', label: 'max' },
];

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  bin: config.codexBin,
  probe: () => probeBin(config.codexBin, ['--version']),
  models: codexModels,
  efforts: () => CODEX_EFFORTS,
  run: runTurn,
};

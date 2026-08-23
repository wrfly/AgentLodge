import type { MessageBlock, ServerEvent, TurnUsage } from '../../core/protocol.js';

export type AgentId = 'claude' | 'codex';

export interface RunOptions {
  prompt: string;
  cwd: string;
  /** The session identifier from the previous turn, so the CLI can resume context */
  resumeSessionId?: string;
  model?: string;
  effort?: string;
  /** The gateway credential. Empty bypasses the gateway and uses the CLI's own configuration. */
  runtimeToken?: string;
  /** Container name. Empty runs on the host directly. */
  containerName?: string;
  /** The working directory inside the container */
  containerCwd?: string;
  /** The user's memory directory, as the CLI will see it (container path in container mode) */
  memoryDir?: string;
  onEvent: (e: ServerEvent) => void;
  onSessionId: (sessionId: string) => void;
}

export interface TurnResult {
  blocks: MessageBlock[];
  usage?: TurnUsage;
  error?: string;
  aborted: boolean;
}

export interface RunningTurn {
  abort(): void;
  done: Promise<TurnResult>;
}

/**
 * An adapter for one CLI agent.
 *
 * The agents differ in three places: how the process starts, how a session resumes, and
 * what schema the event stream uses. An adapter absorbs those three and emits the
 * ServerEvent shape from protocol.ts, which is what lets SSE transport, conversation
 * storage, quota and authentication all be shared.
 *
 * The interface is not shared: each agent has its own rendering in the frontend
 * (/claude, /codex), routed by conversation.agent.
 */
export interface AgentAdapter {
  readonly id: AgentId;
  readonly displayName: string;
  /** Default executable name, overridable from the environment */
  readonly bin: string;
  /** Probe whether this agent is usable here, meaning whether its CLI exists */
  probe(): Promise<AgentAvailability>;
  /** Available models. May be empty — the frontend always offers a free-text option. */
  models(): Promise<ModelOption[]>;
  /** Reasoning effort levels. The two CLIs accept different values, so this is per agent. */
  efforts(): EffortOption[];
  run(opts: RunOptions): RunningTurn;
}

export interface ModelOption {
  /** The --model value passed to the CLI. Empty passes nothing and leaves the CLI on its default. */
  id: string;
  label: string;
  hint?: string;
}

export interface EffortOption {
  /** The value passed to the CLI. Empty passes nothing. */
  id: string;
  label: string;
}

export interface AgentAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

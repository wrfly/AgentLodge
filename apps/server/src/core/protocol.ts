/**
 * The event protocol shared by frontend and backend.
 *
 * This file exists twice, byte for byte: apps/server/src/core/protocol.ts and
 * apps/web/src/lib/protocol.ts. A workspace package was deliberately avoided early on to
 * keep the build configuration simple, and extracting it to packages/shared can wait.
 * Until then, a change here is a change in both — they had already drifted apart once,
 * so `npm run typecheck` diffs them now.
 */

export type BlockKind = 'text' | 'thinking' | 'tool_use';

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Only meaningful against the official API; third-party endpoints usually report 0. See DESIGN.md §7.6. */
  costUsd: number;
  durationMs: number;
  numTurns: number;
}

export type ServerEvent =
  | { type: 'turn.started'; turnId: string }
  | { type: 'block.start'; blockId: number; kind: BlockKind; toolId?: string; toolName?: string }
  | { type: 'text.delta'; blockId: number; text: string }
  | { type: 'thinking.delta'; blockId: number; text: string }
  | { type: 'tool.input.delta'; blockId: number; partial: string }
  /** The authoritative, complete tool input from the assistant event; supersedes what streaming assembled */
  | { type: 'tool.input'; blockId: number; input: unknown }
  | { type: 'block.stop'; blockId: number }
  | { type: 'tool.result'; toolId: string; isError: boolean; content: string }
  | { type: 'turn.completed'; turnId: string; usage: TurnUsage }
  | { type: 'turn.error'; turnId: string; message: string }
  | { type: 'turn.aborted'; turnId: string }
  | { type: 'title.updated'; conversationId: string; title: string }
  | { type: 'quota.updated'; quota: QuotaStatus }
  /** Pushed while queued at the gateway's concurrency gate, so the interface can say how many are ahead */
  | { type: 'queue.waiting'; turnId: string; position: number }
  | { type: 'heartbeat'; ts: number };

export type QuotaPeriod = 'rolling' | 'daily' | 'weekly' | 'monthly' | 'total';
export type LimitKind = 'tokens' | 'cost';

export interface QuotaStatus {
  /** Limit by tokens or by money */
  limitKind: LimitKind;
  /** Billable-token ceiling; null means unlimited */
  limit: number | null;
  /** Money ceiling, in micro-units (1 unit = 1e6); null means unlimited */
  costLimitMicro: number | null;
  currency: string;

  used: number;
  usedMicro: number;
  remaining: number | null;
  remainingMicro: number | null;
  ratio: number;

  period: QuotaPeriod;
  periodStart: string;
  periodEnd: string | null;
  resetsInMs: number | null;
  resetAt?: string;
  /** The reset rule, in words */
  anchorLabel: string;
  /** A one-off allowance that has expired, awaiting an administrator's top-up */
  expired: boolean;

  hardStop: boolean;
  exceeded: boolean;
  warning: boolean;
}

/* ---------- Persisted message shapes ---------- */

export interface TextBlock {
  kind: 'text';
  blockId: number;
  text: string;
}
export interface ThinkingBlock {
  kind: 'thinking';
  blockId: number;
  text: string;
}
export interface ToolBlock {
  kind: 'tool_use';
  blockId: number;
  toolId: string;
  toolName: string;
  input: unknown;
  result?: { isError: boolean; content: string };
}
export type MessageBlock = TextBlock | ThinkingBlock | ToolBlock;

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  blocks: MessageBlock[];
  createdAt: string;
  usage?: TurnUsage;
  error?: string;
  aborted?: boolean;
}

/**
 * The known agents. A runtime array rather than a bare type, because the setting for
 * which agents are offered validates against it, and core cannot import the app layer's
 * registry across the layer boundary.
 */
export const AGENT_IDS = ['claude', 'codex'] as const;

export type AgentId = (typeof AGENT_IDS)[number];

export interface ConversationSummary {
  id: string;
  title: string;
  agent: AgentId;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export interface Conversation extends ConversationSummary {
  userId: string;
  /** The CLI's own session identifier, for resuming context */
  agentSessionId?: string;
  model?: string;
  /** Reasoning effort; empty leaves the CLI on its default */
  effort?: string;
  messages: StoredMessage[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  };
}

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

/**
 * The platform's three windows.
 *
 * Not a per-user period: one subscription has one 5-hour window, one week and one month,
 * beginning and ending at the same instants for everybody. See core/db/period.ts.
 */
export type QuotaScope = 'window' | 'week' | 'month';
export type LimitKind = 'tokens' | 'cost';

/** One of the platform's windows, as it applies to one user */
export interface QuotaWindow {
  scope: QuotaScope;
  /** The ceiling, top-up included, in the unit `limitKind` names. null means unlimited. */
  limit: number | null;
  /** How much of that ceiling came from a top-up */
  boost: number;
  used: number;
  remaining: number | null;
  /** 0..1, clamped */
  ratio: number;
  /**
   * The window's boundaries — **the same instants for every user**.
   *
   * A window measured from each user's own first message would tell somebody who started
   * at four that they have until nine, when the pool empties at seven.
   */
  startsAt: string;
  endsAt: string;
  exceeded: boolean;
}

export interface QuotaStatus {
  limitKind: LimitKind;
  currency: string;
  hardStop: boolean;
  /** All three, always present; an unlimited one has a null limit */
  windows: Record<QuotaScope, QuotaWindow>;
  /** Any window over its ceiling */
  exceeded: boolean;
  /** Any limited window at 90% or more */
  warning: boolean;
  /** Whichever limited window is closest to refusing, or null when none is limited */
  tightest: QuotaScope | null;
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
  /**
   * Whether the upstream is asked for the agent's thinking. On unless it was turned off:
   * the CLI asks for thinking on every request, and this is the switch that says no.
   */
  thinking: boolean;
  messages: StoredMessage[];
  totals: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    costUsd: number;
  };
}

/* ---------- Grouping a model list ---------- */

/**
 * A flat model list is unreadable once an upstream has a dozen names in it, most of them
 * older versions of four families:
 *
 *   claude-opus-5  claude-sonnet-5  claude-fable-5  claude-opus-4-8  claude-opus-4-7
 *   claude-sonnet-4-6  claude-opus-4-6  claude-opus-4-5-20251101  claude-haiku-4-5-20251001
 *
 * The picker groups them into opus / sonnet / fable / haiku and shows the newest of each,
 * with the older ones one click away. Nothing is hidden — an older version is still
 * selectable, and a name that was typed by hand still works.
 *
 * It lives in the shared file because the rule has to be the same on both sides and there is
 * nowhere else both can reach.
 */

export interface ModelLike {
  id: string;
  label: string;
  hint?: string;
}

export interface ModelGroup<T extends ModelLike = ModelLike> {
  /** Empty for the entries that carry no version at all — the "Default" row */
  label: string;
  /** Newest first */
  models: T[];
}

/**
 * Split a name into the family and its version.
 *
 * The version is the **trailing run of numeric segments**, which is what every naming scheme
 * in use here has in common: `claude-opus-4-5-20251101` is opus at 4.5, dated; `gpt-5` is
 * gpt at 5; `deepseek-v4-flash` ends in a word, so it has no version and is a family of one.
 * At least one segment always stays with the family, so a name that is entirely numeric does
 * not vanish.
 */
function splitVersion(id: string): { family: string; version: number[] } {
  const parts = id.split('-');
  let cut = parts.length;
  while (cut > 1 && /^\d+$/.test(parts[cut - 1] ?? '')) cut--;
  return { family: parts.slice(0, cut).join('-'), version: parts.slice(cut).map(Number) };
}

/**
 * Newest first.
 *
 * Compared segment by segment, so 5 beats 4-8. When one is a prefix of the other the shorter
 * wins: `claude-opus-4-5` is the alias that follows the latest snapshot, and
 * `claude-opus-4-5-20251101` is one particular snapshot of it.
 */
function byVersionDesc(a: number[], b: number[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return (b[i] ?? 0) - (a[i] ?? 0);
  }
  return a.length - b.length;
}

/** How many leading segments every family shares — `claude-opus`, `claude-sonnet` share one */
function commonPrefix(families: string[]): number {
  if (families.length === 0) return 0;
  const parts = families.map((f) => f.split('-'));
  // Never strip a family down to nothing: one family of `claude-opus` still reads as `opus`
  const limit = Math.min(...parts.map((p) => p.length - 1));
  let n = 0;
  while (n < limit && parts.every((p) => p[n] === parts[0]?.[n])) n++;
  return n;
}

/** A vendor and the families it offers: the first level of the picker */
export interface ModelVendor<T extends ModelLike = ModelLike> {
  /** The leading segment of the names — `claude`, `deepseek`. Empty for the "Default" row. */
  label: string;
  families: Array<ModelGroup<T>>;
  /** Everything under it, newest first within each family — for counting and for ticks */
  models: T[];
}

/**
 * Group by vendor, then by family, then by version.
 *
 * Names in use here all start with who made the model, and a deployment with two upstreams
 * has enough of them that one flat list is not read. So the first level is that leading
 * segment, and what a vendor has more than one of goes a level down.
 *
 * Order: vendors and families in the order they were configured, versions sorted, because
 * an administrator's order carries a meaning we cannot see, while a version number does not.
 */
export function groupByVendor<T extends ModelLike>(models: T[]): Array<ModelVendor<T>> {
  const out: Array<ModelVendor<T>> = [];
  const byVendor = new Map<string, ModelVendor<T>>();

  for (const m of models) {
    // The "Default" row carries no name to parse and belongs above the vendors
    const vendorLabel = m.id ? (m.id.split('-')[0] ?? m.id) : '';
    let vendor = byVendor.get(vendorLabel);
    if (!vendor) {
      vendor = { label: vendorLabel, families: [], models: [] };
      byVendor.set(vendorLabel, vendor);
      out.push(vendor);
    }
    vendor.models.push(m);
  }

  for (const vendor of out) {
    // Inside a vendor the leading segment is the same for everything, so it is dropped from
    // the family labels: under `claude`, the families read `opus` and `sonnet`
    vendor.families = groupModels(vendor.models).map((g) => ({
      ...g,
      label: g.label.startsWith(`${vendor.label}-`) ? g.label.slice(vendor.label.length + 1) : g.label,
    }));
    vendor.models = vendor.families.flatMap((g) => g.models);
  }
  return out;
}

/**
 * Group by family, newest first inside each, families in the order they were configured.
 *
 * The order is deliberate: the model list is typed in by an administrator and the hint under
 * that field says the picker uses it directly, so re-sorting families would quietly overrule
 * them. Versions inside a family are sorted, because those are facts about the names.
 */
export function groupModels<T extends ModelLike>(models: T[]): Array<ModelGroup<T>> {
  const plain: T[] = [];
  const order: string[] = [];
  const byFamily = new Map<string, Array<{ model: T; version: number[] }>>();

  for (const m of models) {
    // The "Default" row carries no name to parse and belongs above the groups
    if (!m.id) {
      plain.push(m);
      continue;
    }
    const { family, version } = splitVersion(m.id);
    if (!byFamily.has(family)) {
      byFamily.set(family, []);
      order.push(family);
    }
    byFamily.get(family)!.push({ model: m, version });
  }

  const cut = commonPrefix(order);
  const groups: Array<ModelGroup<T>> = plain.length ? [{ label: '', models: plain }] : [];
  for (const family of order) {
    const entries = byFamily.get(family)!.slice().sort((a, b) => byVersionDesc(a.version, b.version));
    groups.push({
      label: family.split('-').slice(cut).join('-'),
      models: entries.map((e) => e.model),
    });
  }
  return groups;
}

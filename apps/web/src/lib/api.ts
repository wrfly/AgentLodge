import { getLocale, t } from './i18n';
import type {
  ThreadSummary,
  AgentId,
  Conversation,
  ConversationSummary,
  DeferredTurn,
  StoredMessage,
} from './protocol';

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  role: 'user' | 'admin';
  status: 'active' | 'suspended';
  createdAt: string;
  lastLoginAt?: string;
}

export interface ModelOption {
  id: string;
  label: string;
  hint?: string;
}

export interface EffortOption {
  id: string;
  label: string;
}

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  /**
   * Whether an administrator offers this agent at all.
   *
   * Separate from `availability`, which answers whether the CLI is installed
   * and working. A missing CLI is a fault and says so; a disabled agent is a
   * deployment decision and should simply not appear.
   */
  enabled: boolean;
  availability: { available: boolean; version?: string; reason?: string };
  models: ModelOption[];
  efforts: EffortOption[];
}

export interface DeviceSession {
  id: string;
  platform?: string;
  ip?: string;
  userAgent?: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
}

/* ---------- The access token lives in memory only, never in localStorage ---------- */

let accessToken: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setUnauthorizedHandler(fn: () => void): void {
  onUnauthorized = fn;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiError(body.error ?? t('Request failed ({status})', { status: res.status }), res.status);
  }
  return (await res.json()) as T;
}

/**
 * At most one refresh in flight at a time.
 *
 * Cold-start restore and the 401 retry share this one entrance. Without it, StrictMode's
 * double mount refreshes the same cookie twice concurrently, the server reads the second
 * one as a replayed token, and every device gets signed out.
 */
let refreshInflight: Promise<AuthResult | null> | null = null;

function refreshSession(): Promise<AuthResult | null> {
  refreshInflight ??= (async () => {
    try {
      const res = await fetch('/api/auth/refresh', {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) return null;
      const data = (await res.json()) as AuthResult;
      accessToken = data.accessToken;
      return data;
    } catch {
      return null;
    } finally {
      // Hand it back, so the next caller starts a fresh one
      setTimeout(() => (refreshInflight = null), 0);
    }
  })();
  return refreshInflight;
}

async function refreshOnce(): Promise<boolean> {
  return (await refreshSession()) !== null;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);

  // The server answers errors in this language. It is the locale the user picked here, not
  // the browser's — those disagree the moment somebody switches languages in the app, and
  // an interface in one language with errors in another is worse than either alone.
  headers.set('accept-language', getLocale());

  const res = await fetch(path, { ...init, headers, credentials: 'include' });

  if (res.status === 401 && retry) {
    if (await refreshOnce()) return request<T>(path, init, false);
    accessToken = null;
    onUnauthorized?.();
  }
  return parse<T>(res);
}

/* ---------------- Authentication ---------------- */

interface AuthResult {
  user: PublicUser;
  accessToken: string;
  expiresIn: number;
}

export const auth = {
  register: (input: {
    email: string;
    username: string;
    password: string;
    inviteCode: string;
  }) =>
    request<AuthResult>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  login: (input: { email: string; password: string }) =>
    request<AuthResult>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),

  /** Cold start: trade the cookie for an access token. Failing just means not signed in. */
  restore: (): Promise<AuthResult | null> => refreshSession(),

  logout: () => request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<{ user: PublicUser }>('/api/auth/me'),
  sessions: () => request<DeviceSession[]>('/api/auth/sessions'),
  revokeSession: (id: string) =>
    request<{ ok: boolean }>(`/api/auth/sessions/${id}`, { method: 'DELETE' }),
  streamTicket: () =>
    request<{ ticket: string }>('/api/auth/stream-ticket', { method: 'POST' }),
};

/* ---------------- Conversations ---------------- */

export const api = {
  agents: () => request<AgentInfo[]>('/api/agents'),

  listConversations: (agent: AgentId) =>
    request<ConversationSummary[]>(`/api/conversations?agent=${agent}`),

  createConversation: (agent: AgentId, model?: string, effort?: string, thinking?: boolean) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ agent, model, effort, thinking }),
    }),

  getConversation: (id: string) =>
    request<Conversation & { busy: boolean; deferred: DeferredTurn | null }>(
      `/api/conversations/${id}`,
    ),

  renameConversation: (id: string, title: string) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),

  setModel: (id: string, model: string) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),

  setEffort: (id: string, effort: string) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ effort }),
    }),

  setThinking: (id: string, thinking: boolean) =>
    request<Conversation>(`/api/conversations/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ thinking }),
    }),

  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),

  /**
   * Both outcomes are a 202: the message was taken. `deferred` instead of `turnId` means
   * it is over the ceiling and waiting for the window rather than going now. A 402 is still
   * a 402 — that is the wait being too long to be worth calling one.
   */
  sendMessage: (id: string, text: string) =>
    request<
      | { turnId: string; userMessage: StoredMessage; deferred?: undefined }
      | { deferred: DeferredTurn; quota: QuotaStatus; turnId?: undefined }
    >(`/api/conversations/${id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** Take back a waiting question; the text comes back so the composer can have it */
  cancelDeferred: (id: string) =>
    request<{ ok: true; deferred: DeferredTurn }>(`/api/conversations/${id}/deferred`, {
      method: 'DELETE',
    }),

  /** Correct the newest question: its answer goes and the corrected question is re-asked */
  editMessage: (id: string, messageId: string, text: string) =>
    request<{ turnId: string; userMessage: StoredMessage }>(
      `/api/conversations/${id}/messages/${messageId}/edit`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),

  /** Ask the newest question again, optionally somewhere else */
  retry: (id: string, opts: { model?: string; effort?: string } = {}) =>
    request<{ turnId: string; userMessage: StoredMessage }>(
      `/api/conversations/${id}/retry`,
      { method: 'POST', body: JSON.stringify(opts) },
    ),

  /**
   * Open a sub-conversation on a selection. It shares the parent's workspace and CLI
   * session; the selection becomes its first question.
   */
  createSubConversation: (id: string, text: string) =>
    request<{
      conversationId: string;
      turnId: string;
      userMessage: StoredMessage;
      conversation: Conversation;
    }>(`/api/conversations/${id}/sub`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),

  /** What this conversation has cost, split by the model that answered */
  conversationUsage: (id: string) =>
    request<{ currency: string; byModel: Array<UsageTotals & { model: string }> }>(
      `/api/conversations/${id}/usage`,
    ),

  /** The threads opened inside this conversation, newest first */
  threads: (id: string) => request<ThreadSummary[]>(`/api/conversations/${id}/threads`),

  abort: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}/abort`, { method: 'POST' }).catch(
      () => ({ ok: false }),
    ),
};

/* ---------------- Usage and memory ---------------- */

export type { QuotaScope, QuotaStatus, QuotaWindow, ThreadSummary, DeferredTurn } from './protocol';
import type { QuotaScope, QuotaStatus } from './protocol';

export type RangePreset =
  | 'window' | 'today' | 'yesterday' | 'week' | 'weekWindow' | 'month'
  | 'last7' | 'last30' | 'quota' | 'all' | 'custom';

/**
 * What was charged, per currency, in micro-units — before any conversion.
 *
 * Vendors price in their own currency, and the price table holds each at its own published
 * list rather than converting, so a figure can be checked against an invoice. The database
 * keeps every turn in the money it was charged in, and this is that, unchanged.
 *
 * **Not what a screen shows.** A report shows `costSettled`, one figure in the settlement
 * currency, and puts this behind it in a hover — `money()` returns the pair. Printing the map
 * itself, "¥12.34 + $5.67", is honest and unreadable: nobody can tell at a glance whether it
 * is more than last month.
 *
 * A currency with nothing spent in it is absent rather than zero.
 */
export type Money = Record<string, number>;

export interface UsageTotals {
  calls: number;
  /** Cost from the price table, per currency, in micro-units (1e6 = one unit) */
  cost: Money;
  /**
   * The same money in the settlement currency, at the one rate the console configures.
   *
   * **This is the figure to render**, through `money()` — which also hands back the `cost`
   * breakdown for the `title`, so the reader can always see which money was actually spent.
   */
  costSettled: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  costUsd: number;
  turns: number;
}

export interface DailyPoint extends UsageTotals {
  day: string;
}

export interface SeriesPoint extends UsageTotals {
  /** A day (YYYY-MM-DD) or an hour (YYYY-MM-DD HH:00) */
  t: string;
}

/**
 * One agent-and-model pair's share of a range.
 *
 * `model` is null for a turn that recorded none, which the table reads as "whatever the CLI
 * picked". Named once because two routes answer in this shape and one table renders both.
 */
export interface AgentModelRow extends UsageTotals {
  agent: string;
  model: string | null;
}

/** One upstream's share of a range, with the credential it authenticated on */
export interface UpstreamUsage extends UsageTotals {
  /** Empty when the gateway was not in the path, so there is no upstream of ours to name */
  providerId: string;
  name: string;
  kind: string;
  credentialId: string;
}

export interface UsageReport {
  quota: QuotaStatus;
  range: { from: string; to: string; label: string; preset: RangePreset };
  /** The upstream everything but `byUpstream` is narrowed to, or null for all of them */
  upstream: string | null;
  totals: UsageTotals;
  series: SeriesPoint[];
  seriesUnit: 'day' | 'hour';
  byAgent: AgentModelRow[];
  /** Every upstream over the range, never narrowed — this is the list being chosen from */
  byUpstream: UpstreamUsage[];
  byConversation: Array<
    UsageTotals & { conversationId: string; title: string; agent: string; updatedAt: string }
  >;
  quick: { today: UsageTotals; month: UsageTotals; allTime: UsageTotals };
}

export interface MemoryRecord {
  file: string;
  title: string;
  hook: string;
  description: string;
  type: string;
  body: string;
  updatedAt?: string;
}

export interface MemoryDoc {
  records: MemoryRecord[];
  stats: { records: number; bytes: number; updatedAt?: string };
  maxBytes: number;
  maxRecords: number;
  /** The most recent change, when there is one before it to go back to */
  lastChange?: { at: string; by: 'user' | 'agent' };
}

export interface Profile {
  since?: string;
  conversations: number;
  messages: number;
  activeDays: number;
  /** 168 buckets, UTC, Sunday 00:00 first — rotated into local time here */
  hourOfWeek: number[];
  turns: number;
  withTools: number;
  aborted: number;
  failed: number;
  turnsPerConversation: number;
  secondsPerTurn: number;
  secondsPerTurnP90: number;
  askLength: number;
  askLengthP90: number;
  cjkShare: number;
  sampled: number;
  agents: Array<{ key: string; n: number }>;
  models: Array<{ key: string; n: number }>;
  efforts: Array<{ key: string; n: number }>;
  viaOwnCli: number;
  billedTurns: number;

  /** Written from the conversation summaries below, when it has been asked for */
  portrait?: { text: string; candidates: string[]; conversations: number; createdAt: string };
  summaries: Array<{ id: string; title: string; summary: string; at: string }>;
  /** Conversations not summarised yet */
  pending: number;
}

/* ---------------- Request traces ---------------- */

export interface TraceBlock {
  type: string;
  text?: string;
  name?: string;
  input?: string;
  toolUseId?: string;
  isError?: boolean;
  chars?: number;
  truncated?: boolean;
  cacheControl?: boolean;
}

export interface TraceSummary {
  id: string;
  at: string;
  conversationId?: string;
  agent?: string;
  model?: string;
  /** runtime = a chat in the browser, in our container; api-key = the user's own CLI */
  credential?: 'runtime' | 'api-key';
  status: number;
  durationMs: number;
  messageCount: number;
  toolCount: number;
  usage?: Record<string, number>;
  preview: string;
}

export interface TraceDetail extends Omit<TraceSummary, 'status' | 'durationMs' | 'preview'> {
  turnId?: string;
  wire: string;
  stream: boolean;
  upstream?: string;
  system: TraceBlock[];
  tools: Array<{ name: string; chars: number }>;
  messages: Array<{ role: string; blocks: TraceBlock[] }>;
  response: {
    status: number;
    durationMs: number;
    ttftMs?: number;
    queueWaitMs?: number;
    usage?: Record<string, number>;
    error?: string;
  };
}

export interface ApiKeyUsage {
  calls: number;
  /** What each vendor charged, in its own money */
  cost: Money;
  /** The same, converted — what the list shows */
  costSettled: number;
}

export interface ApiKeyRow {
  id: string;
  name: string;
  /** The prefix shown in the console, e.g. al_3f9c2a1b */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
  usage: ApiKeyUsage | null;
}

export const me = {
  /** `upstream` narrows everything but the upstream breakdown; 'none' is the rows with no upstream */
  usage: (preset: RangePreset = 'quota', from?: string, to?: string, upstream?: string | null) => {
    const q = new URLSearchParams({ preset });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    if (upstream) q.set('upstream', upstream);
    return request<UsageReport>(`/api/me/usage?${q}`);
  },
  quota: () => request<QuotaStatus>('/api/me/quota'),
  profile: () => request<Profile>('/api/me/profile'),
  /**
   * Write the portrait, summarising a batch of whatever has no summary yet.
   *
   * `pending` is what did not fit in the batch. Nothing else will pick those up — calling
   * this again is what does.
   */
  recap: () =>
    request<{ portrait?: Profile['portrait']; summaries: Profile['summaries']; pending: number }>(
      '/api/me/profile/recap',
      { method: 'POST' },
    ),
  memory: () => request<MemoryDoc>('/api/me/memory'),
  saveMemory: (rec: { file?: string; title: string; body: string; hook?: string }) =>
    request<{ ok: boolean; record: MemoryRecord; stats: MemoryDoc['stats'] }>('/api/me/memory', {
      method: 'PUT',
      body: JSON.stringify(rec),
    }),
  deleteMemory: (file: string) =>
    request<{ ok: boolean; stats: MemoryDoc['stats'] }>(
      `/api/me/memory/${encodeURIComponent(file)}`,
      { method: 'DELETE' },
    ),
  undoMemory: () =>
    request<{ ok: boolean; records: MemoryRecord[] }>('/api/me/memory/undo', { method: 'POST' }),
  clearMemory: () => request<{ ok: boolean }>('/api/me/memory', { method: 'DELETE' }),
  traces: (limit = 50) =>
    request<{ traces: TraceSummary[]; enabled: boolean }>(`/api/me/traces?limit=${limit}`),
  trace: (id: string) => request<TraceDetail>(`/api/me/traces/${id}`),
  clearTraces: () => request<{ ok: boolean; removed: number }>('/api/me/traces', { method: 'DELETE' }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: boolean; revokedSessions: number }>('/api/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  apiKeys: () =>
    request<{
      currency: string; keys: ApiKeyRow[]; baseUrl: string; install: { command: string; script: string } }>(
      '/api/me/api-keys',
    ),
  /** The plaintext comes back this once, and is never retrievable again */
  createApiKey: (name: string) =>
    request<{ key: ApiKeyRow; plaintext: string }>('/api/me/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  renameApiKey: (id: string, name: string) =>
    request<{ key: Omit<ApiKeyRow, 'usage'> }>(`/api/me/api-keys/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    }),
  revokeApiKey: (id: string) =>
    request<{ ok: boolean }>(`/api/me/api-keys/${id}/revoke`, { method: 'POST' }),
  /** Only a revoked key can be deleted */
  deleteApiKey: (id: string) =>
    request<{ ok: boolean }>(`/api/me/api-keys/${id}`, { method: 'DELETE' }),
};

export const publicApi = {
  checkInvite: (code: string) =>
    request<{
      valid: boolean;
      reason?: string;
      email?: string;
      expiresAt?: string;
      /** The monthly ceiling the account starts with, in micro-units of `currency` */
      limit?: number | null;
      currency?: string;
    }>(`/api/auth/invite/${encodeURIComponent(code)}`),
  forgotPassword: (email: string) =>
    request<{ ok: boolean; message: string }>('/api/auth/forgot-password', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
  resetPassword: (token: string, newPassword: string) =>
    request<{ ok: boolean }>('/api/auth/reset-password', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),
};

/* ---------------- Admin ---------------- */

export interface AdminUser extends PublicUser {
  /** The first account: always an active administrator, so it cannot be demoted or disabled */
  first: boolean;
  quota: {
    /** The three ceilings, in micro-units of `currency`. null means that window is unlimited. */
    window: number | null;
    week: number | null;
    month: number | null;
    /** What the gate enforces on the 5-hour window right now, top-up included */
    windowCeiling: number | null;
    currency: string;
    hardStop: boolean;
  };
  usage: { period: UsageTotals; month: UsageTotals; allTime: UsageTotals };
  conversations: number;
}

/**
 * One account's spend for a range, per agent and per model — the console's per-user panel.
 *
 * The range is the server's to state, label included: the console prints the label beside
 * figures the server counted, and a label chosen here from a range chosen there is how the
 * two come to disagree.
 */
export interface UserAgentUsage {
  currency: string;
  range: { from: string; label: string };
  rows: AgentModelRow[];
  /** Counted over `range`, not summed from `rows` — see the table's footer */
  total: UsageTotals;
}

export interface InviteCode {
  id: string;
  code: string;
  email?: string;
  note?: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  /** A monthly ceiling for the account this invite creates, in micro-units */
  presetLimit: number | null;
  disabled: boolean;
  createdAt: string;
  sentAt?: string;
}

export interface SettingView {
  key: string;
  label: string;
  group: 'mail' | 'quota' | 'agents' | 'gateway';
  type: 'string' | 'secret' | 'number' | 'boolean' | 'list' | 'select';
  hint?: string;
  /** The values a `select` takes, shown as written and in this order */
  options?: string[];
  /** Only shown while the setting it names holds one of these values */
  showWhen?: { key: string; is: string[] };
  /** How many of the six columns it takes; absent means the whole row */
  span?: 1 | 2 | 3 | 4 | 6;
  /** Shown and entered as a multiple of the stored value — money is typed in whole units */
  scale?: number;
  /** Shown inside the field, in the entered scale */
  unit?: string;
  value: string;
  isSet: boolean;
  source: 'db' | 'env' | 'default' | 'unset';
}

export interface BalanceResult {
  available: boolean;
  balances: Array<{
    currency: string;
    totalBalance: string;
    grantedBalance: string;
    toppedUpBalance: string;
    used?: string;
    limit?: string;
    source?: 'deepseek' | 'cursor';
    label?: string;
    planName?: string;
    resetsAt?: string;
    billedHere?: boolean;
    /**
     * The billing cycle this remaining covers, and our own spend inside it.
     *
     * Cursor's plan is a monthly pot rather than a rolling window, so its card reports spend
     * over this interval instead of over the 5-hour quota window. `cycleSource` says whose
     * boundary it is: the vendor's reported cycle, or this platform's monthly anchor when
     * the vendor reported none. Absent from an older server, and from upstreams that have
     * no cycle to report.
     */
    cycleStart?: string;
    cycleSource?: 'upstream' | 'anchor';
    spend?: UsageTotals;
  }>;
  fetchedAt: string;
  error?: string;
}

export type TurnStatus = 'completed' | 'error' | 'aborted';

/** What is true right now, as opposed to what a period adds up to */
export interface AdminOverview {
  users: { total: number; active: number };
  window: {
    /**
     * Which window this is. `month` on a deployment whose upstreams have no rolling
     * allowance — Cursor reports none — where the month is the only one the gate enforces.
     * Optional so an older server, which always meant the 5-hour one, still reads.
     */
    scope?: QuotaScope;
    startsAt: string;
    endsAt: string;
    totals: UsageTotals;
    /** Turns that ran, by how they ended. A refusal is not one of them. */
    statuses: Record<TurnStatus, number>;
    /** People the gate turned away in this window, not attempts */
    refused: number;
  };
  currency: string;
  allTime: UsageTotals;
  /** Present when an older server still embedded the upstream query; the card loads `/api/admin/balance` itself */
  balance?: BalanceResult | null;
  agents: AgentInfo[];
}

export type PlatformPreset = 'window' | 'weekWindow' | 'today' | 'last7' | 'last30' | 'month' | 'all';

/** One model's share of one upstream. `providerId` is empty for the rows with no upstream of ours. */
export interface UpstreamModelUsage extends UsageTotals {
  providerId: string;
  model: string;
}

export interface PlatformUsage {
  range: { from: string; to: string; label: string };
  currency: string;
  totals: UsageTotals;
  series: SeriesPoint[];
  seriesUnit: 'hour' | 'day';
  /** Every upstream over the range */
  byUpstream: UpstreamUsage[];
  /**
   * Every (upstream, model) pair over the same range, for the page to reveal under the
   * upstream it belongs to. Sent whole rather than fetched per expansion: it is a couple of
   * dozen rows, and coming from the same scan as `byUpstream` is what guarantees an
   * upstream's models add up to the row they open from.
   */
  byUpstreamModel: UpstreamModelUsage[];
}

/**
 * Every account that spent anything over a period, heaviest first.
 *
 * Not a top N: `rows` is meant to account for the period, so it adds up to `totals`. Accounts
 * that spent nothing are left out — a row of zeroes is noise in a list of where money went.
 */
export interface UsersUsage {
  range: { from: string; to: string; label: string };
  currency: string;
  totals: UsageTotals;
  rows: Array<UsageTotals & { userId: string; username: string; email: string }>;
}

export interface PricingRow {
  id: number;
  model: string;
  /** The upstream this price is for. Empty means any of them. */
  providerId: string;
  currency: string;
  /** Micro-unit price per million tokens */
  priceInput: number;
  priceCacheRead: number;
  priceCacheWrite: number;
  priceOutput: number;
  effectiveFrom: string;
  note?: string;
  /** What the four prices are multiplied by inside the schedule below; 1 means no schedule */
  peakMultiplier: number;
  /**
   * The schedule as a sentence — `Mon–Fri 01:00–04:00, 06:00–10:00 UTC` — and whether this
   * instant is inside it. Both are rendered by the server, beside the code that evaluates
   * the windows: a second copy here could describe a surcharge other than the one being
   * charged.
   */
  peakLabel: string;
  peakNow: boolean;
}

export interface AuditProxyConfig {
  allow: string[];
  dynamicUpstream: boolean;
  maxCount: number;
  maxBytes: number;
  maxAgeMs: number;
  /** Read-only: these have to be 0, and cannot be changed from here */
  locked: { retry: number; maxConcurrent: number };
  stats: { traceCount: number; traceBytes: number; traceDir: string };
  /** Non-empty = this instance pins one upstream, and the allowlist plays no part */
  pinnedUpstream: string | null;
  uiEnabled: boolean;
  /** Where the proxy's own UI is mounted (empty string when it is off) */
  uiPrefix?: string;
}

export interface AuditProxyStatus {
  /**
   * Whether egress goes through the proxy. Off by default.
   *
   * This one is our own setting, so it stays readable and editable even when the proxy
   * itself is unreachable — otherwise turning it off would need the thing you are trying
   * to turn off.
   */
  enabled: boolean;
  configured: boolean;
  url?: string;
  editable?: boolean;
  reason?: string;
  config?: AuditProxyConfig;
}

/** One egress trace. The audit proxy decides the fields; only the ones the console uses are declared. */
export interface TraceRow {
  id: number;
  time: string;
  method: string;
  path: string;
  status: number;
  model?: string | null;
  stream?: boolean;
  duration_ms?: number;
  request_bytes?: number;
  response_bytes?: number;
  upstream?: string;
  stop_reason?: string | null;
  usage?: Record<string, number> | null;
  rewritten?: string[] | null;
}

export interface AdminTraces {
  available: boolean;
  /** Why it is unavailable. Showing "0 rows" instead would read as "no traffic", which is a different thing entirely. */
  reason?: string;
  traceDir?: string;
  rows: TraceRow[];
}

/** A full trace. The shape follows the proxy's, and the console picks what it needs. */
export interface TraceDetail {
  meta?: TraceRow;
  summary?: {
    model?: string;
    stream?: boolean;
    max_tokens?: number;
    system?: Array<{ type?: string; chars?: number; text?: string }> | { chars: number; text: string };
    message_count?: number;
    messages?: Array<{
      i: number;
      role?: string;
      chars?: number;
      text?: string;
      blocks?: Array<Record<string, unknown>>;
    }>;
    tools?: Array<{ name?: string } | string>;
  } | null;
  reconstructed?: {
    text?: string;
    stop_reason?: string;
    usage?: Record<string, number>;
    tool_uses?: Array<{ name?: string; input?: string }>;
    event_count?: number;
  } | null;
  responseBody?: unknown;
  error?: unknown;
  files?: string[];
}

/** What the console knows about a key file. The server returns status, never contents. */
/** One key file the credential manager can see, or why it cannot use it */
export interface KeyFileEntry {
  path: string;
  usable: boolean;
  /** Why not, when usable is false. Shown verbatim: it is the whole diagnosis. */
  error?: string;
  /** Masked value, for telling two files apart */
  hint?: string;
  /** First 8 hex of the contents' sha256 — answers "did my replacement reach it" */
  fingerprint?: string;
  size?: number;
  mtime?: string;
}

export interface KeyFileListing {
  roots: Array<{ path: string; exists: boolean; note?: string }>;
  files: KeyFileEntry[];
  /** Present when a path was named: what that one path yields right now */
  checked?: KeyFileEntry;
}

/** A model a user can pick, and the upstream that serves it */
export interface Model {
  id: string;
  name: string;
  providerId: string;
  /** The name to send upstream, when it differs. Empty means they match. */
  upstreamName: string;
  enabled: boolean;
  /** Lowest first among rows sharing a name */
  priority: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ModelInput {
  name?: string;
  providerId?: string;
  upstreamName?: string;
  enabled?: boolean;
  priority?: number;
  note?: string;
}

export interface Provider {
  id: string;
  name: string;
  kind: string;
  baseUrl: string;
  hasKey: boolean;
  note?: string;
  /** Non-empty = the key lives in this file, read afresh per request, and not in the database */
  /**
   * Non-empty = the key is a credential the credential manager holds, named here by id.
   * What goes upstream is a token that service mints, so nothing usable is stored here.
   */
  credentialId: string;
  /**
   * True = credentialId names something the credential manager no longer has, so this
   * provider is configured and unusable at once. undefined = it could not be asked, which
   * is not the same claim and is drawn as nothing.
   */
  credentialMissing?: boolean;
}

export interface ProviderInput {
  name?: string;
  kind?: string;
  baseUrl?: string;
  /** Absent = leave it alone; empty string = clear it */
  apiKey?: string;
  /**
   * Path to the key file. Mutually exclusive with apiKey: sending either one clears the
   * other source. An empty string switches back to a pasted value.
   */
  apiKeyFile?: string;
  /**
   * Id of a credential the credential manager holds. Mutually exclusive with the two
   * above — sending any one of the three clears the others.
   */
  credentialId?: string;
  note?: string;
}

/** A credential the credential manager holds, as the console is allowed to see it */
export interface Credential {
  id: string;
  /** api-key, or the subscription it is: claude / codex */
  kind: string;
  label?: string;
  /** host-file | typed | login | import */
  source: string;
  /** Enough of the value to tell two apart; never enough to use */
  hint: string;
  ready: boolean;
  /** When the current access token stops working (subscriptions only) */
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  /** False = it can serve the token it has and nothing after it: sign in again */
  renewable?: boolean;
  scopes?: string[];
  accountId?: string;
  /** kind key-file: the path it reads, plus what that file yields right now */
  path?: string;
  fingerprint?: string;
  mtime?: string;
  size?: number;
  /** Why this credential cannot be used at the moment. Shown verbatim. */
  error?: string;
}

export interface StartedLogin {
  loginId: string;
  authorizeUrl: string;
  credentialId: string;
  kind: string;
  /**
   * How this sign-in finishes: `code` wants the code the redirect page shows pasted
   * back, `poll` has nothing to bring back and is completed by asking until it stops
   * answering `pending`. Absent from an older credential manager, which only had `code`.
   */
  completion?: 'code' | 'poll';
  expiresAt: number;
}

/** One of the upstream's own limit windows, on the scale its headers use (0..1) */
export interface UpstreamAllowanceWindow {
  utilization: number | null;
  resetsAt: string | null;
  status: string | null;
  /** When this window was last mentioned; a window nobody has touched keeps its own age */
  observedAt: string;
  /** Its reset has passed, so the figure was dropped rather than shown as still current */
  expired?: boolean;
}

/**
 * What the shared subscription reports about itself.
 *
 * Users are shown their own quota instead — the pool's figures are nobody's
 * allowance in particular. This is the administrator's view of the plan.
 */
export interface UpstreamAllowance {
  provider: string;
  wire: string;
  observedAt: string;
  status: string | null;
  resetsAt: string | null;
  representative: string | null;
  /** Keyed by the upstream's own abbreviations: 5h, 7d, 7d_oi, overage */
  windows: Record<string, UpstreamAllowanceWindow>;
  /** Everything the upstream said on the subject, unparsed */
  raw: Record<string, string>;
  /** Codex reports in the response body rather than in headers */
  codex?: unknown;
}

export interface UpstreamAllowanceView {
  enabled: boolean;
  /** The most recent reading. Kept so an older console still has something to show. */
  allowance?: UpstreamAllowance | null;
  /** One per upstream that has spoken since the gateway started */
  allowances?: UpstreamAllowance[];
  unreachable?: boolean;
  error?: string;
}

/** One upstream's own in-flight pool. Limits belong to the upstream, so each has its own. */
export interface GatePool {
  providerId: string;
  /** The upstream's name, for the row's label */
  name?: string;
  active: number;
  queued: number;
  effectiveMax: number;
  max: number;
  /** True while this pool is held at `max` instead of narrowing itself after a 429 */
  pinned: boolean;
  cooldownUntil: number;
  totalGranted: number;
  totalThrottled: number;
  waitMsP50: number;
  waitMsP95: number;
}

export interface GateStatus {
  enabled: boolean;
  containers: { enabled: boolean; ok: boolean; detail: string; running: number };
  /** In a split deployment the gate lives in the gateway container; when it cannot be reached, only these two fields are filled in */
  unreachable?: boolean;
  error?: string;
  /** The ceiling every pool starts from. Stored, so it survives a restart of the gateway */
  max: number;
  /**
   * How many of that ceiling one user may hold, per upstream. Stored the same way.
   *
   * Usually the binding one: a pool of twenty with two in flight and eight queued is one
   * user at their own cap of two, not a gate that has gone wrong.
   */
  perUser: number;
  /** True while the upstream is not allowed to narrow the pools below that ceiling */
  pinned: boolean;
  /** One per upstream that has seen traffic since the gateway started */
  pools: GatePool[];
}

export interface AuditEntry {
  id: number;
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  createdAt: string;
}

export const admin = {
  overview: () => request<AdminOverview>('/api/admin/overview'),
  platformUsage: (preset: PlatformPreset) =>
    request<PlatformUsage>(`/api/admin/usage?preset=${preset}`),
  /** The same period asked about people rather than upstreams — the user usage tab */
  usageByUser: (preset: PlatformPreset) =>
    request<UsersUsage>(`/api/admin/usage-by-user?preset=${preset}`),
  users: () => request<AdminUser[]>('/api/admin/users'),
  /**
   * One account's per-model breakdown, fetched when a row in the list is opened.
   *
   * Its own route rather than the full user detail: that one also reads a 30-day series, the
   * conversations, the sessions and every memory file this user owns, none of which is on
   * screen here.
   */
  userAgentUsage: (id: string, preset: PlatformPreset, signal?: AbortSignal) =>
    request<UserAgentUsage>(
      `/api/admin/users/${encodeURIComponent(id)}/usage-by-agent?preset=${preset}`,
      { signal },
    ),
  updateUser: (
    id: string,
    patch: {
      status?: 'active' | 'suspended';
      role?: 'user' | 'admin';
      /** The three ceilings; null clears one, undefined leaves it alone */
      window?: number | null;
      week?: number | null;
      month?: number | null;
      hardStop?: boolean;
    },
    /*
     * Not an `AdminUser`: the route answers with the public user plus the raw quota row, and
     * carries neither `usage` nor `conversations` nor `windowCeiling`. Nothing reads the
     * result — the caller reloads the list — but a type that claims fields the response has
     * never had is a trap for whoever reads it next.
     */
  ) => request<PublicUser>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Top up: extra allowance on one of the platform's windows, gone when that window resets */
  topup: (
    id: string,
    input: { amount: number; scope?: QuotaScope; note?: string },
  ) =>
    request<{ ok: boolean; quota: QuotaStatus }>(`/api/admin/users/${id}/topup`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** The rows, plus the currency a new one should be entered in */
  pricing: () => request<{ currency: string; rows: PricingRow[] }>('/api/admin/pricing'),
  addPricing: (input: {
    model: string;
    priceInput: number;
    priceCacheRead: number;
    priceCacheWrite: number;
    priceOutput: number;
    note?: string;
  }) => request<PricingRow>('/api/admin/pricing', { method: 'POST', body: JSON.stringify(input) }),
  removePricing: (id: number) =>
    request<{ ok: boolean }>(`/api/admin/pricing/${id}`, { method: 'DELETE' }),

  logoutAll: (id: string) =>
    request<{ ok: boolean; revoked: number }>(`/api/admin/users/${id}/logout-all`, {
      method: 'POST',
    }),

  invites: () => request<{ currency: string; invites: InviteCode[] }>('/api/admin/invites'),
  createInvites: (input: {
    count?: number;
    note?: string;
    maxUses?: number;
    expiresInDays?: number;
    presetLimit?: number | null;
  }) => request<InviteCode[]>('/api/admin/invites', { method: 'POST', body: JSON.stringify(input) }),
  emailInvite: (input: {
    email: string;
    note?: string;
    expiresInDays?: number;
    presetLimit?: number | null;
  }) =>
    request<{ invite: InviteCode; mail: { sent: boolean; error?: string }; link?: string }>(
      '/api/admin/invites/email',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  disableInvite: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/invites/${id}`, { method: 'DELETE' }),

  settings: () => request<SettingView[]>('/api/admin/settings'),
  saveSettings: (patch: Record<string, string>) =>
    request<SettingView[]>('/api/admin/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
  testMail: (to?: string) =>
    request<{ ok: boolean; to: string }>('/api/admin/settings/test-mail', {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  balance: () => request<BalanceResult>('/api/admin/balance'),

  providers: () =>
    request<{ providers: Provider[]; kinds: Record<string, string>; autoRefreshModels: boolean }>(
      '/api/admin/providers',
    ),

  /* The model catalogue: what users pick, and which upstream serves each */
  models: () =>
    request<{ models: Model[]; providers: Array<{ id: string; name: string; kind: string }> }>(
      '/api/admin/models',
    ),
  createModel: (input: ModelInput) =>
    request<Model>('/api/admin/models', { method: 'POST', body: JSON.stringify(input) }),
  updateModel: (id: string, input: ModelInput) =>
    request<Model>(`/api/admin/models/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteModel: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/models/${id}`, { method: 'DELETE' }),
  /** Ask every upstream that can answer a list, or one of them, and add whatever is missing */
  pullModels: (providerId?: string) =>
    request<{
      added: number;
      offered?: string[];
      models: Model[];
      providers?: Array<{ id: string; name: string; added: number; offered: string[]; error?: string }>;
    }>('/api/admin/models/pull', {
      method: 'POST',
      body: JSON.stringify(providerId ? { providerId } : {}),
    }),
  createProvider: (input: ProviderInput) =>
    request<Provider>('/api/admin/providers', { method: 'POST', body: JSON.stringify(input) }),
  updateProvider: (id: string, input: ProviderInput) =>
    request<Provider>(`/api/admin/providers/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  deleteProvider: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/providers/${id}`, { method: 'DELETE' }),

  /**
   * Credentials the credential manager holds. `configured: false` means no such service
   * is running for this deployment, and the console offers only a typed key or a file.
   *
   * `store.ok === false` means that service cannot write its own state file: the
   * credentials below still work, and a restart comes back without whatever changed
   * since. It is reloaded after every change made here, so it is also how a delete or a
   * sign-in reports that it did not reach disk.
   */
  credentials: () =>
    request<{
      configured: boolean;
      credentials: Credential[];
      error?: string;
      store?: { ok: boolean; error?: string };
    }>('/api/admin/credentials'),
  /** Key files the credential manager can read; passing a path also checks that one */
  credentialFiles: (path?: string) =>
    request<KeyFileListing>(
      `/api/admin/credentials/files${path ? `?path=${encodeURIComponent(path)}` : ''}`,
    ),
  storeKeyFileCredential: (input: { id: string; label?: string; path: string }) =>
    request<{ credential: Credential }>('/api/admin/credentials', {
      method: 'POST',
      body: JSON.stringify({ ...input, kind: 'key-file' }),
    }),
  storeCredential: (input: { id: string; label?: string; apiKey: string }) =>
    request<{ credential: Credential }>('/api/admin/credentials', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Copy a credentials file the credential manager has mounted (the host's `claude login`) */
  importCredential: (input: { id: string; kind: string; label?: string }) =>
    request<{ credential: Credential }>('/api/admin/credentials/import', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  deleteCredential: (id: string) =>
    request<{ ok: boolean }>(`/api/admin/credentials/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Step one of signing a subscription in: where to authorise */
  startCredentialLogin: (input: { kind: string; id: string; label?: string }) =>
    request<StartedLogin>('/api/admin/credentials/login/start', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  /** Step two: the code the page showed after authorising */
  /** `credential` is absent while a poll sign-in is still waiting to be approved. */
  finishCredentialLogin: (input: { loginId: string; code: string; completion?: 'code' | 'poll' }) =>
    request<{ status?: string; credential?: Credential }>('/api/admin/credentials/login/finish', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  auditProxy: () => request<AuditProxyStatus>('/api/admin/audit-proxy'),

  /* Egress traces. The data lives in the audit proxy; the admin API is a forwarding layer with an admin check in front. */
  traces: () => request<AdminTraces>('/api/admin/traces'),
  trace: (id: number) => request<TraceDetail>(`/api/admin/traces/${id}`),
  clearTraces: () =>
    request<{ removed: number; remaining: number; freedMb: number }>('/api/admin/traces', {
      method: 'DELETE',
    }),
  setAuditProxy: (
    patch: Partial<Pick<AuditProxyConfig, 'allow' | 'dynamicUpstream' | 'maxCount' | 'maxBytes' | 'maxAgeMs'>>
      // `enabled` is not forwarded — it is our own setting, not the proxy's
      & { enabled?: boolean },
  ) =>
    request<AuditProxyStatus>('/api/admin/audit-proxy', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),

  gate: () => request<GateStatus>('/api/admin/gate'),
  upstreamAllowance: () => request<UpstreamAllowanceView>('/api/admin/upstream-allowance'),
  /** What the upstream itself says it has. Errors come back in the body — see gateway/models.ts */
  providerModels: (id: string) =>
    request<{ models: string[]; error?: string }>(`/api/admin/providers/${id}/models`),
  /**
   * Both of the gate's limits, in one write.
   *
   * One call rather than one per field so that changing the two together is one round trip
   * and one audit entry — they are usually adjusted as a pair, because what a deployment is
   * really choosing is the relationship between them. Send only what changed; the route
   * reads each field independently and refuses a body with nothing in it.
   *
   * `perUserInflightMax` used to go through `saveSettings` with everything else on the
   * System settings page. Same row either way — the route writes
   * `gateway.perUserInflightMax` — but sent from here it also reaches the gateway's
   * `reschedule`, so a raise lets the people already queued through instead of leaving them
   * to wait for a release that may be minutes away.
   */
  setGateLimits: (patch: { maxConcurrency?: number; perUserInflightMax?: number }) =>
    request<GateStatus>('/api/admin/gate', {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }),
  /** Pinned, the gate runs at the configured limit and a 429 no longer narrows it */
  setGatePinned: (pinned: boolean) =>
    request<GateStatus>('/api/admin/gate', {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),
  auditLogs: (limit = 200) => request<AuditEntry[]>(`/api/admin/audit-logs?limit=${limit}`),
};

/* ---------------- Workspace files ---------------- */

export interface FileEntry {
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
}

export interface FilePreview {
  path: string;
  size: number;
  truncated: boolean;
  content: string | null;
  binary: boolean;
}

export const files = {
  list: (conversationId: string) =>
    request<FileEntry[]>(`/api/conversations/${conversationId}/files`),

  preview: (conversationId: string, path: string) =>
    request<FilePreview>(
      `/api/conversations/${conversationId}/files/preview?path=${encodeURIComponent(path)}`,
    ),

  /**
   * `<a download>` cannot carry an Authorization header, so trade for a one-shot ticket and
   * put that in the query instead. It lasts 60 seconds and dies on use, which is a great
   * deal safer than putting the access token in a URL.
   */
  download: async (conversationId: string, path: string) => {
    const { ticket } = await auth.streamTicket();
    const url = `/api/conversations/${conversationId}/files/download?path=${encodeURIComponent(path)}&ticket=${ticket}`;
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() ?? 'download';
    document.body.appendChild(a);
    a.click();
    a.remove();
  },

  upload: async (conversationId: string, list: File[]) => {
    const form = new FormData();
    for (const f of list) form.append('file', f);
    // No content-type here: the browser has to set it, because only it knows the boundary
    const headers = new Headers();
    const token = getAccessToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
    const res = await fetch(`/api/conversations/${conversationId}/files`, {
      method: 'POST',
      headers,
      body: form,
      credentials: 'include',
    });
    return parse<{ uploaded: string[]; files: FileEntry[] }>(res);
  },

  remove: (conversationId: string, path: string) =>
    request<{ ok: boolean; files: FileEntry[] }>(
      `/api/conversations/${conversationId}/files?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    ),
};

/** Download a conversation as a Markdown file */
export async function exportConversation(id: string, title: string): Promise<void> {
  const headers = new Headers();
  const token = getAccessToken();
  if (token) headers.set('authorization', `Bearer ${token}`);
  const res = await fetch(`/api/conversations/${id}/export`, { headers, credentials: 'include' });
  if (!res.ok) throw new ApiError(t('Export failed'), res.status);
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 60)}.md`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}


/** Micro-units to something readable */
export const MICRO = 1_000_000;
/*
 * The currency is required on purpose. It used to default to CNY, which was right while the
 * price table was seeded in yuan — and silently wrong everywhere once the seed moved to USD.
 * The same page then printed ¥8.14 in one card and $8.14 in the table below it, for the same
 * money. Every caller has the quota's currency in scope; making it an argument is what stops
 * the two from drifting apart again.
 */
export function fmtMoney(micro: number | null | undefined, currency: string): string {
  if (micro === null || micro === undefined) return '—';
  const sym = currency === 'CNY' ? '¥' : currency === 'USD' ? '$' : `${currency} `;
  const v = micro / MICRO;
  // Small amounts need more places, or a single turn reads as ¥0.00 and looks like nothing happened
  return `${sym}${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
}

/**
 * Micro-units as a typed field, and back.
 *
 * Every ceiling, top-up and cost in the database is counted in micro-units — a sixth
 * decimal place, so that a single turn is not rounded away to nothing. Nobody types that:
 * an administrator sizing a quota types 10, and a misplaced zero in `10000000` is
 * invisible in a way that one in `10` is not. Only the fields convert.
 */
export function microToUnits(micro: number): string {
  // Number() again to drop the trailing zeros toFixed leaves behind
  return String(Number((micro / MICRO).toFixed(6)));
}

export function unitsToMicro(v: string): number {
  return Math.round(Number(v) * MICRO);
}

/**
 * What was charged, one amount per currency, joined — "¥12.34 + $5.67".
 *
 * **Not the headline any more.** Reports show one settled figure; this is the breakdown
 * behind it, and it lives in a `title` so a reader who wants to check a DeepSeek invoice can
 * still see the yuan that went into it. Printing it as the main number is honest and
 * unreadable: nobody can tell at a glance whether "¥890 + $1,100" is more than last month.
 *
 * Nothing spent reads as a zero in the settlement currency, because a blank where a number
 * belongs reads as a bug. The order is fixed rather than whatever the object happens to
 * iterate in, so the same figure does not swap ends between two renders of the same page.
 */
function fmtCost(cost: Money | null | undefined, fallbackCurrency = 'USD'): string {
  const entries = Object.entries(cost ?? {}).filter(([, v]) => v);
  if (!entries.length) return fmtMoney(0, fallbackCurrency);
  entries.sort(([a], [b]) => a.localeCompare(b));
  return entries.map(([c, v]) => fmtMoney(v, c)).join(' + ');
}

/**
 * A figure and the note that explains it: what to print, and what to put in `title`.
 *
 * Every report shows money the same way — one number in the settlement currency, with the
 * currencies it was actually charged in a hover away. Both halves come from here so that no
 * screen can end up showing the converted figure without a way to see behind it, and so that
 * "converted" means the same arithmetic everywhere.
 *
 * `title` is undefined when there is nothing a reader does not already know: spend in one
 * currency, and that currency is the one on screen. A tooltip repeating the number under the
 * cursor is noise.
 */
export function money(
  totals: { cost: Money; costSettled: number },
  currency: string,
): { text: string; title: string | undefined } {
  const spent = Object.keys(totals.cost).filter((c) => totals.cost[c]);
  const converted = spent.some((c) => c !== currency);
  return {
    text: fmtMoney(totals.costSettled, currency),
    title: converted ? fmtCost(totals.cost, currency) : undefined,
  };
}


import { getLocale, t } from './i18n';
import type {
  AgentId,
  Conversation,
  ConversationSummary,
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

  createConversation: (agent: AgentId, model?: string, effort?: string) =>
    request<Conversation>('/api/conversations', {
      method: 'POST',
      body: JSON.stringify({ agent, model, effort }),
    }),

  getConversation: (id: string) =>
    request<Conversation & { busy: boolean }>(`/api/conversations/${id}`),

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

  deleteConversation: (id: string) =>
    request<void>(`/api/conversations/${id}`, { method: 'DELETE' }),

  sendMessage: (id: string, text: string) =>
    request<{ turnId: string; userMessage: StoredMessage }>(
      `/api/conversations/${id}/messages`,
      { method: 'POST', body: JSON.stringify({ text }) },
    ),

  abort: (id: string) =>
    request<{ ok: boolean }>(`/api/conversations/${id}/abort`, { method: 'POST' }).catch(
      () => ({ ok: false }),
    ),
};

/* ---------------- Usage and memory ---------------- */

export type { QuotaScope, QuotaStatus, QuotaWindow, LimitKind } from './protocol';
import type { QuotaScope, QuotaStatus } from './protocol';

export type RangePreset =
  | 'today' | 'yesterday' | 'week' | 'month'
  | 'last7' | 'last30' | 'quota' | 'all' | 'custom';

export interface UsageTotals {
  calls: number;
  /** Cost from the price table, in micro-units of `currency` (1e6 = one unit) */
  costMicro: number;
  inputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  billableTokens: number;
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

export interface UsageReport {
  quota: QuotaStatus;
  range: { from: string; to: string; label: string; preset: RangePreset };
  totals: UsageTotals;
  series: SeriesPoint[];
  seriesUnit: 'day' | 'hour';
  byAgent: Array<UsageTotals & { agent: string; model: string | null }>;
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
  billableTokens: number;
  costMicro: number;
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
  usage: (preset: RangePreset = 'quota', from?: string, to?: string) => {
    const q = new URLSearchParams({ preset });
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return request<UsageReport>(`/api/me/usage?${q}`);
  },
  quota: () => request<QuotaStatus>('/api/me/quota'),
  profile: () => request<Profile>('/api/me/profile'),
  /** Write the portrait, catching up any conversation the sweep has not reached yet */
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
    request<{ keys: ApiKeyRow[]; baseUrl: string; install: { command: string; script: string } }>(
      '/api/me/api-keys',
    ),
  /** The plaintext comes back this once, and is never retrievable again */
  createApiKey: (name: string) =>
    request<{ key: ApiKeyRow; plaintext: string }>('/api/me/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name }),
    }),
  revokeApiKey: (id: string) =>
    request<{ ok: boolean }>(`/api/me/api-keys/${id}`, { method: 'DELETE' }),
};

export const publicApi = {
  checkInvite: (code: string) =>
    request<{
      valid: boolean;
      reason?: string;
      email?: string;
      expiresAt?: string;
      tokenLimit?: number | null;
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
  quota: {
    /** The three ceilings, in the unit limitKind names. null means that window is unlimited. */
    window: number | null;
    week: number | null;
    month: number | null;
    limitKind: 'tokens' | 'cost';
    hardStop: boolean;
  };
  usage: { period: UsageTotals; month: UsageTotals; allTime: UsageTotals };
  conversations: number;
}

export interface InviteCode {
  id: string;
  code: string;
  email?: string;
  note?: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  presetRole: 'user' | 'admin';
  presetTokenLimit: number | null;
  disabled: boolean;
  createdAt: string;
  sentAt?: string;
}

export interface SettingView {
  key: string;
  label: string;
  group: 'mail' | 'quota' | 'agents';
  type: 'string' | 'secret' | 'number' | 'boolean' | 'list' | 'select';
  hint?: string;
  /** The values a `select` takes, shown as written and in this order */
  options?: string[];
  /** Only shown while the setting it names holds one of these values */
  showWhen?: { key: string; is: string[] };
  /** How many of the six columns it takes; absent means the whole row */
  span?: number;
  /** Shown and entered as a multiple of the stored value — a token limit is typed in millions */
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
  }>;
  fetchedAt: string;
  error?: string;
}

export interface AdminOverview {
  users: { total: number; active: number };
  usage: {
    month: UsageTotals;
    allTime: UsageTotals;
    daily: DailyPoint[];
    topUsers: Array<UsageTotals & { userId: string; username: string; email: string }>;
  };
  balance: BalanceResult | null;
  agents: AgentInfo[];
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
  expiresAt: number;
}

/** One of the upstream's own limit windows, on the scale its headers use (0..1) */
export interface UpstreamAllowanceWindow {
  utilization: number | null;
  resetsAt: string | null;
  status: string | null;
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
  /** null until an upstream response has passed through the gateway since it started */
  allowance?: UpstreamAllowance | null;
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
  /** The ceiling every pool starts from */
  max: number;
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
  users: () => request<AdminUser[]>('/api/admin/users'),
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
      limitKind?: 'tokens' | 'cost';
    },
  ) => request<AdminUser>(`/api/admin/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  /** Top up: extra allowance on one of the platform's windows, gone when that window resets */
  topup: (
    id: string,
    input: { amount?: number; tokens?: number; scope?: QuotaScope; note?: string },
  ) =>
    request<{ ok: boolean; quota: QuotaStatus }>(`/api/admin/users/${id}/topup`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  pricing: () => request<PricingRow[]>('/api/admin/pricing'),
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

  resetUsage: (id: string, undo = false) =>
    request<{ ok: boolean; clearedTokens?: number; undone?: boolean; quota: QuotaStatus }>(
      `/api/admin/users/${id}/reset-usage`,
      { method: 'POST', body: JSON.stringify({ undo }) },
    ),
  logoutAll: (id: string) =>
    request<{ ok: boolean; revoked: number }>(`/api/admin/users/${id}/logout-all`, {
      method: 'POST',
    }),

  invites: () => request<InviteCode[]>('/api/admin/invites'),
  createInvites: (input: {
    count?: number;
    note?: string;
    maxUses?: number;
    expiresInDays?: number;
    presetRole?: 'user' | 'admin';
    presetTokenLimit?: number | null;
  }) => request<InviteCode[]>('/api/admin/invites', { method: 'POST', body: JSON.stringify(input) }),
  emailInvite: (input: {
    email: string;
    note?: string;
    expiresInDays?: number;
    presetRole?: 'user' | 'admin';
    presetTokenLimit?: number | null;
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
  /** Ask one upstream what it offers and add whatever is missing */
  pullModels: (providerId: string) =>
    request<{ added: number; offered: string[]; models: Model[] }>('/api/admin/models/pull', {
      method: 'POST',
      body: JSON.stringify({ providerId }),
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
  finishCredentialLogin: (input: { loginId: string; code: string }) =>
    request<{ credential: Credential }>('/api/admin/credentials/login/finish', {
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
  setGateConcurrency: (maxConcurrency: number) =>
    request<GateStatus>('/api/admin/gate', {
      method: 'PATCH',
      body: JSON.stringify({ maxConcurrency }),
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
export function fmtMoney(micro: number | null | undefined, currency = 'CNY'): string {
  if (micro === null || micro === undefined) return '—';
  const sym = currency === 'CNY' ? '¥' : '$';
  const v = micro / MICRO;
  // Small amounts need more places, or a single turn reads as ¥0.00 and looks like nothing happened
  return `${sym}${v < 1 ? v.toFixed(4) : v.toFixed(2)}`;
}

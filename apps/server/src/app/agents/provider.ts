import { config } from '../../core/config.js';
import * as models from '../../core/db/models.js';
import * as providers from '../../core/db/providers.js';
import * as usageRepo from '../../core/db/usage.js';
import { fetchCursorBalance } from '../../gateway/cursor/balance.js';

/**
 * Pointing an agent's upstream at the metering gateway.
 *
 * The agent does not get the upstream key. It gets a runtime token bound to
 * (user, conversation, turn), and the real key only exists in the gateway process. So:
 *   - the key never appears in a child process's or container's environment
 *   - metering and quota cannot be bypassed, because without the gateway there is no upstream
 *   - a global concurrency gate becomes meaningful
 *
 * The CLI is a harness, not an account. It must not inherit the operator's `~/.claude` or
 * `~/.codex` login — that would bill a personal subscription and skip metering. No model
 * row means the gateway cannot route, and a turn is refused rather than sent around it.
 */

/**
 * The gateway is enabled exactly when the console has an enabled model row.
 *
 * A provider with nothing pointing at it receives no traffic. The mock upstream and the
 * local agent count once they have a row: they cost nothing, but the path through the
 * system is complete.
 */
export function gatewayEnabled(): boolean {
  return models.any();
}

/*
 * There used to be a gatewayEnabledFor(agent) here, letting Codex use the host's
 * ~/.codex/auth.json — a ChatGPT subscription — and bypass the gateway. It is gone. That
 * path **could not work in container mode anyway**: the credential is on the host, not in
 * the container, so Codex would go straight to api.openai.com and get a 401 — and container
 * mode is this project's normal shape. Outside containers it meant usage degraded to what
 * the CLI reports, quota could not stop a turn from inside, and the gate did not apply.
 * Keeping it only gave "does this go through the gateway" two answers. Both agents are now
 * treated alike: an active provider means the gateway.
 */

/**
 * The address an agent uses to reach the gateway.
 *
 * Three deployment shapes:
 *   directly on the host                      → 127.0.0.1:port
 *   container plus host gateway (macOS dev)   → host.containers.internal:port
 *   container plus container gateway (Linux)  → GATEWAY_URL, e.g. http://gateway:8788
 *
 * ⚠️ Only the third satisfies both "the container has no internet" and "it can reach the
 * gateway": on an internal network a container cannot even reach the host, so the gateway
 * has to be on the same container network.
 */
export function gatewayBaseUrl(forContainer = false): string {
  // GATEWAY_URL is **the agent's** address for the gateway. This process must not use it:
  // the value may be host.containers.internal, which only resolves inside a container, or
  // it may point at the trace proxy — neither reachable from here. Use gatewayInternalUrl().
  if (forContainer && config.gatewayUrl) return config.gatewayUrl;
  if (forContainer) return `http://host.containers.internal:${config.gatewayPort}`;
  return `http://${config.gatewayHost}:${config.gatewayPort}`;
}

/** Claude Code switches upstream through the environment */
export function claudeEnv(runtimeToken?: string, inContainer = false): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: gatewayBaseUrl(inContainer),
    // A missing ticket still displaces the host login. The CLI then 401s at the gateway
    // instead of silently answering from ~/.claude.
    ANTHROPIC_AUTH_TOKEN: runtimeToken || 'unconfigured',
  };

  /*
   * An official key outranks ANTHROPIC_AUTH_TOKEN, so with both present the CLI takes the
   * key. One exported on the host would displace the ticket we signed and send the agent
   * straight upstream: no ticket means no usage record, no quota, no gate, and nothing for
   * the audit proxy to see. So it has to not exist.
   *
   * `delete` rather than an empty string: an empty value still counts as set under a
   * presence test, and Claude Code's startup line — "ANTHROPIC_API_KEY ... is set and takes
   * precedence" — would name it, making it look as though a key really were configured
   * somewhere. Deleting it also stops launch.ts, whose test is `if (v !== undefined)`, from
   * passing a pointless `-e ANTHROPIC_API_KEY=` into the container.
   *
   * This does not make that startup line go away: ANTHROPIC_AUTH_TOKEN is itself the
   * "another auth source" it refers to, and that is the premise of the whole design.
   */
  delete env.ANTHROPIC_API_KEY;
  // A Cursor slug in ANTHROPIC_MODEL is refused the same way as `--model composer-2.5`.
  if (env.ANTHROPIC_MODEL && !claudeCliModel(env.ANTHROPIC_MODEL)) delete env.ANTHROPIC_MODEL;
  return env;
}

/**
 * The `--model` Claude Code will actually accept.
 *
 * It is an Anthropic client: `composer-2.5` and `composer-2.5[fast=false]` are Cursor
 * slugs, and passing them here is refused as "the selected model may not exist" before a
 * request is even sent. Those names stay on the conversation; the gateway routes by that
 * row. A window suffix (`[1m]`) is Anthropic's own and is kept.
 *
 * `sonnet` is what the CLI gets when the conversation picked a Cursor slug — any alias in
 * its own catalogue works; this one is in every build.
 */
export function claudeCliModel(name?: string): string | undefined {
  const n = name?.trim();
  if (!n) return undefined;
  if (/\[[^\]]*=/.test(n)) return undefined;
  const stem = n.replace(/\[[^\]]*\]$/, '');
  if (/^(claude-|opus$|sonnet$|haiku$|fable$)/i.test(stem)) return n;
  return undefined;
}

export const CLAUDE_HARNESS_MODEL = 'sonnet';

/**
 * Codex has no equivalent environment variable, so this overrides its configuration with
 * -c. The fields mirror [model_providers.*] in ~/.codex/config.toml. Confirmed by capture:
 * `responses` is appended straight onto base_url, so /v1/ belongs here.
 */
export function codexProviderArgs(runtimeToken?: string, inContainer = false): string[] {
  // Always override the host ~/.codex login, even without a ticket: an empty override list
  // used to mean "use ChatGPT on this machine", which is the same leak as Claude's.
  // Always responses: Codex 0.147 removed `wire_api = "chat"` — its own words are
  // "`wire_api = \"chat\"` is no longer supported". So when the upstream only speaks chat,
  // the translation has to happen in the gateway.
  return [
    '-c', 'model_provider="agentlodge"',
    '-c', 'model_providers.agentlodge.name="AgentLodge gateway"',
    '-c', `model_providers.agentlodge.base_url="${gatewayBaseUrl(inContainer)}/v1/"`,
    '-c', 'model_providers.agentlodge.wire_api="responses"',
    '-c', `model_providers.agentlodge.experimental_bearer_token="${runtimeToken || 'unconfigured'}"`,
  ];
}

/**
 * **This process's** address for the gateway, used by the console to read gate status and
 * change the concurrency limit.
 *
 * Kept apart from gatewayBaseUrl(), which is the agent's: that one may point at
 * host.containers.internal or the trace proxy, neither reachable from here. Split across
 * containers, GATEWAY_INTERNAL_URL points at the gateway container, e.g.
 * http://gateway:8788.
 */
export function gatewayInternalUrl(): string {
  return (
    config.gatewayInternalUrl ||
    `http://${config.gatewayHost === '0.0.0.0' ? '127.0.0.1' : config.gatewayHost}:${config.gatewayPort}`
  );
}

/** Query the upstream account balance; null when no key is configured */
export interface BalanceInfo {
  currency: string;
  totalBalance: string;
  grantedBalance: string;
  toppedUpBalance: string;
  /** Dollars already drawn, when the upstream (or this platform) can say so */
  used?: string;
  /** The prepaid / plan ceiling this remaining is held to */
  limit?: string;
  source?: 'deepseek' | 'cursor';
  label?: string;
  planName?: string;
  resetsAt?: string;
  /** True when `used` was counted from our usage table, not the upstream's own meter */
  billedHere?: boolean;
}

export interface BalanceResult {
  available: boolean;
  balances: BalanceInfo[];
  fetchedAt: string;
  error?: string;
}

function dollars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '';
  return n.toFixed(2);
}

/**
 * Dollars this platform has billed through one upstream, in the window that remaining
 * is supposed to cover.
 *
 * Cursor's Enterprise dashboard often answers a hard limit and nothing spent. The pot
 * is still being drawn — by us — so the remaining we show subtracts what we have already
 * priced in USD. A deployment that only priced in another currency has no USD figure to
 * subtract and is left as Cursor reported it.
 */
function billedHereUsd(providerId: string, from: string | null): number {
  const totals = usageRepo.totalsAllInRange(
    { from: from ?? '1970-01-01T00:00:00.000Z', to: new Date().toISOString() },
    providerId,
  );
  return (totals.cost.USD ?? 0) / 1_000_000;
}

function isDeepSeek(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname;
    return host === 'api.deepseek.com' || host.endsWith('.deepseek.com');
  } catch {
    return false;
  }
}

async function fetchDeepSeekBalance(p: providers.Provider, key: string): Promise<BalanceResult> {
  const fetchedAt = new Date().toISOString();
  const root = p.baseUrl.replace(/\/anthropic\/?$/, '').replace(/\/+$/, '');
  try {
    const res = await fetch(`${root}/user/balance`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      return { available: false, balances: [], fetchedAt, error: `HTTP ${res.status}` };
    }
    const body = (await res.json()) as {
      is_available?: boolean;
      balance_infos?: Array<{
        currency?: string;
        total_balance?: string;
        granted_balance?: string;
        topped_up_balance?: string;
      }>;
    };
    return {
      available: Boolean(body.is_available),
      balances: (body.balance_infos ?? []).map((b) => ({
        currency: b.currency ?? '',
        totalBalance: b.total_balance ?? '0',
        grantedBalance: b.granted_balance ?? '0',
        toppedUpBalance: b.topped_up_balance ?? '0',
        source: 'deepseek' as const,
        label: p.name,
      })),
      fetchedAt,
    };
  } catch (err) {
    return {
      available: false,
      balances: [],
      fetchedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function fetchOneCursor(p: providers.Provider, key: string): Promise<BalanceInfo> {
  const raw = await fetchCursorBalance(key, p.baseUrl);
  const ours = billedHereUsd(p.id, raw.cycleStart);
  const billedHere = raw.used === null && ours > 0;
  const used = raw.used ?? (ours > 0 ? ours : null);
  const remaining =
    raw.remaining !== null && !billedHere
      ? raw.remaining
      : raw.limit !== null && used !== null
        ? Math.max(0, raw.limit - used)
        : raw.remaining;
  return {
    currency: 'USD',
    totalBalance: dollars(remaining),
    grantedBalance: dollars(raw.included),
    toppedUpBalance: dollars(raw.prepaid),
    used: used !== null ? dollars(used) : raw.limit !== null ? '0.00' : undefined,
    limit: dollars(raw.limit) || undefined,
    source: 'cursor',
    label: p.name,
    planName: raw.planName ?? undefined,
    resetsAt: raw.resetsAt ?? undefined,
    billedHere: billedHere || undefined,
  };
}

/**
 * The address and credential a balance query uses, taken from **the active provider**
 * rather than a separate piece of configuration.
 *
 * DeepSeek answers `/user/balance`. Cursor answers a prepaid pot — hard limit, grant
 * credit, included spend — from DashboardService. Anything else has no such endpoint
 * and is skipped; the card then disappears if nobody answered.
 *
 * Several Cursor providers are several accounts, so each is asked. DeepSeek still
 * answers once: the card is about an account's remaining, and two DeepSeek keys are
 * two accounts, which this card does not currently ask about.
 *
 * Held for a minute: the dashboard is several RPCs, and the landing page used to wait
 * for all of them on every open. The card still asks this function; the cache is what
 * keeps a tab-switch from paying the same round trip again.
 */
const BALANCE_TTL_MS = 60_000;
let balanceCache: { at: number; value: BalanceResult | null } | undefined;

export async function fetchBalance(): Promise<BalanceResult | null> {
  if (balanceCache && Date.now() - balanceCache.at < BALANCE_TTL_MS) return balanceCache.value;
  const fetchedAt = new Date().toISOString();
  const balances: BalanceInfo[] = [];
  const errors: string[] = [];
  let asked = false;

  for (const p of providers.list()) {
    if (p.kind !== 'cursor') continue;
    const key = await providers.secretOf(p.id);
    if (!key) continue;
    asked = true;
    try {
      balances.push(await fetchOneCursor(p, key));
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }

  for (const p of providers.list()) {
    if (!isDeepSeek(p.baseUrl)) continue;
    const key = await providers.secretOf(p.id);
    if (!key) continue;
    asked = true;
    const ds = await fetchDeepSeekBalance(p, key);
    balances.push(...ds.balances);
    if (ds.error) errors.push(ds.error);
    break;
  }

  const value = !asked
    ? null
    : {
        available: balances.length > 0,
        balances,
        fetchedAt,
        error: balances.length ? undefined : errors[0],
      };
  balanceCache = { at: Date.now(), value };
  return value;
}

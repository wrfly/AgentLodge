import { config } from '../../core/config.js';
import * as models from '../../core/db/models.js';
import * as providers from '../../core/db/providers.js';

/**
 * Pointing an agent's upstream at the metering gateway.
 *
 * The agent does not get the upstream key. It gets a runtime token bound to
 * (user, conversation, turn), and the real key only exists in the gateway process. So:
 *   - the key never appears in a child process's or container's environment
 *   - metering and quota cannot be bypassed, because without the gateway there is no upstream
 *   - a global concurrency gate becomes meaningful
 *
 * Only active when the console has an active upstream provider. Without one the CLI keeps
 * its own configuration, so a development environment that already worked keeps working.
 */

/**
 * The gateway is enabled exactly when the console has an active upstream provider.
 *
 * The mock upstream and the local agent count: they cost nothing, but the path through the
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
  if (!runtimeToken || !gatewayEnabled()) return process.env;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ANTHROPIC_BASE_URL: gatewayBaseUrl(inContainer),
    ANTHROPIC_AUTH_TOKEN: runtimeToken,
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
  return env;
}

/**
 * Codex has no equivalent environment variable, so this overrides its configuration with
 * -c. The fields mirror [model_providers.*] in ~/.codex/config.toml. Confirmed by capture:
 * `responses` is appended straight onto base_url, so /v1/ belongs here.
 */
export function codexProviderArgs(runtimeToken?: string, inContainer = false): string[] {
  if (!runtimeToken || !gatewayEnabled()) return [];
  // Always responses: Codex 0.147 removed `wire_api = "chat"` — its own words are
  // "`wire_api = \"chat\"` is no longer supported". So when the upstream only speaks chat,
  // the translation has to happen in the gateway.
  return [
    '-c', 'model_provider="agentlodge"',
    '-c', 'model_providers.agentlodge.name="AgentLodge gateway"',
    '-c', `model_providers.agentlodge.base_url="${gatewayBaseUrl(inContainer)}/v1/"`,
    '-c', 'model_providers.agentlodge.wire_api="responses"',
    '-c', `model_providers.agentlodge.experimental_bearer_token="${runtimeToken}"`,
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
}

export interface BalanceResult {
  available: boolean;
  balances: BalanceInfo[];
  fetchedAt: string;
  error?: string;
}

/**
 * The address and credential a balance query uses, taken from **the active provider**
 * rather than a separate piece of configuration.
 *
 * Only DeepSeek offers this endpoint (`/user/balance`); every other upstream returns null
 * and the balance card disappears from the interface. With several upstreams configured
 * the first DeepSeek one that has a credential answers — the card is about an account's
 * balance, and a deployment with two DeepSeek keys has two accounts to ask about, which
 * is a question this card does not currently ask.
 *
 * baseUrl backs off to the root: what the provider carries is
 * `https://api.deepseek.com/anthropic`, with `/v1/messages` appended straight onto it,
 * while the balance lives at the root.
 */
async function balanceEndpoint(): Promise<{ url: string; key: string } | null> {
  for (const p of providers.list()) {
    let host: string;
    try {
      host = new URL(p.baseUrl).hostname;
    } catch {
      continue;
    }
    if (!(host === 'api.deepseek.com' || host.endsWith('.deepseek.com'))) continue;
    const key = await providers.secretOf(p.id);
    if (!key) continue;
    const root = p.baseUrl.replace(/\/anthropic\/?$/, '').replace(/\/+$/, '');
    return { url: `${root}/user/balance`, key };
  }
  return null;
}

export async function fetchBalance(): Promise<BalanceResult | null> {
  const target = await balanceEndpoint();
  if (!target) return null;
  const key = target.key;

  const fetchedAt = new Date().toISOString();
  try {
    const res = await fetch(target.url, {
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

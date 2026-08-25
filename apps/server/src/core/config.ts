import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// Both src/ and dist/ sit under apps/server, so the repository root is two levels up.
// config.ts lives in src/core/, which makes it four levels: core → src → server → apps → root.
// The layering refactor got this one short, dataDir landed on apps/data, and the server
// quietly opened an empty database — which presented as "every password is wrong".
// Move this file and you must update this.
const repoRoot = path.resolve(here, '../../../..');

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? '127.0.0.1',

  /** Data root: conversation JSON plus a working directory per conversation */
  dataDir: process.env.DATA_DIR ?? path.join(repoRoot, 'data'),

  /** The Claude Code executable */
  claudeBin: process.env.CLAUDE_BIN ?? 'claude',

  /**
   * Local development uses bypassPermissions. Without it, headless mode declines
   * every tool call automatically and all the interface can say is "I do not have
   * permission". With containers this becomes in-container isolation plus
   * --dangerously-skip-permissions.
   *
   * ⚠️ It lets Claude run any command on your machine. Local development only.
   */
  permissionMode: process.env.PERMISSION_MODE ?? 'bypassPermissions',

  /** Empty leaves the CLI on its own default model */
  model: process.env.MODEL ?? '',

  /* ---------------- agent CLI ---------------- */

  codexBin: process.env.CODEX_BIN ?? 'codex',
  /**
   * Codex has a native sandbox, a step safer than Claude's bypassPermissions, so the
   * default is workspace-write: it can only write the conversation's own working
   * directory. Loosen it with CODEX_SANDBOX.
   */
  codexSandbox: process.env.CODEX_SANDBOX ?? 'workspace-write',

  /** Comma-separated; overrides each agent's model dropdown. Empty falls back to their own discovery. */
  claudeModels: (process.env.CLAUDE_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
  codexModels: (process.env.CODEX_MODELS ?? '').split(',').map((s) => s.trim()).filter(Boolean),

  /** How long a single turn may run */
  turnTimeoutMs: Number(process.env.TURN_TIMEOUT_MS ?? 10 * 60 * 1000),

  /** Events kept in memory per conversation, to replay after an SSE reconnect */
  eventBufferSize: Number(process.env.EVENT_BUFFER_SIZE ?? 4000),

  /* ---------------- Authentication ---------------- */

  /**
   * The signing key, used in three places: access tokens, the gateway's runtime
   * tokens, and deriving the AES key that encrypts system settings (the upstream and
   * mail keys).
   *
   * Unset it is generated at random, which means it changes on every restart and
   * anything already encrypted can no longer be decrypted. In a deployment it has to
   * be fixed and kept secret: whoever has it can forge an administrator identity and
   * billing credentials.
   */
  jwtSecret: process.env.JWT_SECRET ?? randomBytes(48).toString('base64url'),
  jwtSecretFromEnv: Boolean(process.env.JWT_SECRET),

  accessTokenTtlMs: Number(process.env.ACCESS_TOKEN_TTL_MS ?? 15 * 60 * 1000),
  refreshTokenTtlMs: Number(process.env.REFRESH_TOKEN_TTL_MS ?? 30 * 24 * 3600 * 1000),
  streamTicketTtlMs: Number(process.env.STREAM_TICKET_TTL_MS ?? 60 * 1000),

  /** On in production, so cookies carry Secure */
  secureCookies: process.env.SECURE_COOKIES === 'true',

  credentialManagerSocket: (process.env.CREDENTIAL_MANAGER_SOCKET ?? '').trim(),

  /* ---------------- Metering gateway ---------------- */

  /**
   * What this process is. Default `all`: the main service and the gateway share one
   * process on two ports, which is one process fewer in development. A compose
   * deployment splits them into two containers (app / gateway) so the gateway can sit
   * on the internal network by itself.
   */
  role: (process.env.ROLE ?? 'all') as 'all' | 'app' | 'gateway',

  gatewayPort: Number(process.env.GATEWAY_PORT ?? 8788),
  gatewayHost: process.env.GATEWAY_HOST ?? '127.0.0.1',
  /** The address agents use to reach the gateway; in containers this becomes a container-network hostname */
  gatewayUrl: process.env.GATEWAY_URL ?? '',

  /** This process's own address for the gateway (the console reads the gate); points at the gateway container when split */
  gatewayInternalUrl: process.env.GATEWAY_INTERNAL_URL ?? '',

  /**
   * What to tell a user to put in BASE_URL.
   *
   * This is the **third** gateway address and differs from both above. Do not mix them:
   *   GATEWAY_URL           for agents inside containers (host.containers.internal / the trace proxy)
   *   GATEWAY_INTERNAL_URL  for this process (the console reading gate status)
   *   PUBLIC_GATEWAY_URL    the **public** address, for a user's own claude / codex
   *
   * Displayed on the settings page and used for nothing else. Empty makes the frontend
   * fall back to the browser's current origin, which is exactly right for single-machine
   * development and wrong in a real deployment, where the user would copy localhost.
   */
  publicGatewayUrl: process.env.PUBLIC_GATEWAY_URL ?? '',

  /*
   * The "everything outbound must pass the audit proxy" switch is **not here**. It is
   * the `egress.requireAuditProxy` setting, changeable from the console, with
   * `REQUIRE_AUDIT_PROXY` as its initial value only; the test lives in core/egress.ts.
   * It belongs in settings because when something goes wrong in production you have to
   * be able to turn it off on the spot, and changing an environment variable means
   * rebuilding a container.
   */

  /**
   * The shared audit proxy. One instance serves every upstream: the gateway tells it
   * per request where to relay using `x-forwarded-host`, so no upstream needs its own
   * process.
   *
   * An address set on the provider itself wins over this one, for the case where a
   * particular upstream needs a dedicated instance.
   */
  auditProxyUrl: process.env.AUDIT_PROXY_URL ?? '',

  /**
   * Credential for the audit proxy's control API. app and the proxy must agree.
   *
   * Unset means the proxy does not mount its control API at all, and that panel in the
   * console is read-only. That is a deliberate default: an endpoint that can edit the
   * allowlist is an endpoint that can point the audit proxy anywhere.
   */
  auditAdminToken: process.env.AUDIT_ADMIN_TOKEN ?? '',

  /** Ceiling on requests in flight to the upstream at any instant */
  maxUpstreamConcurrency: Number(process.env.MAX_UPSTREAM_CONCURRENCY ?? 3),
  maxQueueDepth: Number(process.env.MAX_QUEUE_DEPTH ?? 200),
  queueTimeoutMs: Number(process.env.QUEUE_TIMEOUT_MS ?? 120_000),
  leaseMaxMs: Number(process.env.LEASE_MAX_MS ?? 600_000),
  /** How many slots one user may hold at once, so nobody monopolises them */
  perUserInflightMax: Number(process.env.PER_USER_INFLIGHT_MAX ?? 2),

  /** How long a runtime token lives — slightly longer than one turn's timeout */
  runtimeTokenTtlMs: Number(process.env.RUNTIME_TOKEN_TTL_MS ?? 20 * 60 * 1000),

  /* ---------------- Container isolation ---------------- */

  /**
   * The data directory's path **on the host**. Defaults to dataDir, because when the
   * main service runs on the host directly the two are the same thing.
   *
   * It only needs a value of its own when the main service is itself in a container.
   * Then it creates agent containers through a mounted podman.sock, and the source path
   * of a `-v` is resolved by **the podman doing the creating**, on the host — not by the
   * app container. Hand it `/data/workspaces/...` and podman cannot find that on the
   * host: `statfs ...: no such file or directory`.
   *
   * This is the classic docker-out-of-docker trap: a path crossing engines has to be
   * the one the other side can see.
   */
  hostDataDir: process.env.HOST_DATA_DIR ?? '',


  /**
   * Off by default: on, it requires a working podman and a built image, and without
   * those a development environment that was fine stops working entirely.
   */
  useContainers: process.env.USE_CONTAINERS === 'true',

  /** Record per-user upstream request traces, so a user can see what they sent. Off writes nothing at all. */
  traceRequests: process.env.TRACE_REQUESTS !== 'false',
  podmanBin: process.env.PODMAN_BIN ?? 'podman',
  agentImage: process.env.AGENT_IMAGE ?? 'agentlodge/agent:1.0',
  /** Name of the internal network. Empty uses the default network, which is not advisable: containers can reach the internet. */
  agentNetwork: process.env.AGENT_NETWORK ?? '',
  containerMemoryMb: Number(process.env.CONTAINER_MEMORY_MB ?? 1024),
  containerCpus: Number(process.env.CONTAINER_CPUS ?? 1),
  /** How long a container may idle before being stopped — kept rather than removed, so the next start is quick */
  containerIdleMs: Number(process.env.CONTAINER_IDLE_MS ?? 30 * 60 * 1000),
};

export const paths = {
  conversations: path.join(config.dataDir, 'conversations'),
  workspaces: path.join(config.dataDir, 'workspaces'),
  /** Per-user request traces, one directory per userId */
  traces: path.join(config.dataDir, 'traces'),
  /** Memory snapshots, kept out of the workspace an agent can write to */
  memory: path.join(config.dataDir, 'memory'),
};

/**
 * The same workspace directory, as seen **from the host**.
 *
 * Only for building the source path of a `podman run -v`: that string is resolved by
 * podman on the host, not by this process. Reading and writing files here always uses
 * `paths.workspaces`. With HOST_DATA_DIR unset the two are identical, which is the case
 * when the main service runs on the host directly.
 */
export function hostWorkspace(...segments: string[]): string {
  return path.join(config.hostDataDir || config.dataDir, 'workspaces', ...segments);
}

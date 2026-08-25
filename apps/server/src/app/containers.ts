import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { config, hostWorkspace, paths } from '../core/config.js';

const run = promisify(execFile);

/**
 * One long-lived container per user, with the CLI run inside it through `podman exec`.
 *
 * No hand-written runner and no WebSocket protocol: exec's stdout *is* the process stdout,
 * so not a line of the existing stream-json / JSONL parsing changes.
 *
 * Isolation rests on three things:
 *   1. non-root, CapDrop ALL, no-new-privileges
 *   2. only that user's own working directory is mounted
 *   3. the real API key never enters the container — inside there is only a short-lived
 *      ticket bound to (user, conversation, turn)
 *
 * Note that the third is not "no network". An agent container has internet access on
 * purpose: it is a Claude Code running in a sandbox and it needs to install packages and
 * look things up. Metering cannot be bypassed because there is no key, not because there is
 * no network.
 */

export interface ContainerInfo {
  name: string;
  running: boolean;
  startedAt?: string;
  lastActiveAt: number;
}

const state = new Map<string, ContainerInfo>();
/** Concurrent creation requests for one user collapse into a single one */
const pending = new Map<string, Promise<string>>();

const containerName = (userId: string): string => `agentlodge-agent-${userId.slice(0, 12)}`;

/**
 * A persistent HOME per user, unaffected by stopping or removing the container.
 *
 * The whole HOME is mounted rather than just the `.claude` and `.codex` subdirectories,
 * because Claude Code's main configuration is `~/.claude.json` — **at the root of HOME,
 * not inside `~/.claude/`**. Mount only the subdirectories and it stays on the container's
 * writable layer, so one `podman rm` takes directory trust and history with it.
 *
 * It lives at `<user directory>/.agent-home/` rather than at the root of `/workspace`
 * because Claude Code reads `.claude/settings.json` from the working directory **and its
 * ancestors** as project settings. At the root it would collide with the one in HOME and
 * the two meanings would mix.
 */
const AGENT_HOME = '.agent-home';

function agentHome(userId: string): string {
  return path.join(paths.workspaces, userId, AGENT_HOME);
}

function writeIfAbsent(file: string, content: string): void {
  try {
    fs.writeFileSync(file, content, { flag: 'wx' });
  } catch {
    /* Leave an existing one alone — the user or the agent may have edited it */
  }
}

/** Lay down a default configuration when the container is first created */
function seedAgentHome(userId: string): void {
  const claude = path.join(agentHome(userId), '.claude');
  const codex = path.join(agentHome(userId), '.codex');
  fs.mkdirSync(claude, { recursive: true });
  fs.mkdirSync(codex, { recursive: true });
  writeIfAbsent(path.join(claude, 'settings.json'), `${JSON.stringify({ includeCoAuthoredBy: false }, null, 2)}\n`);
  // apikey / api: the container only has a gateway ticket, so the CLI must not fall
  // through to an interactive login
  writeIfAbsent(path.join(codex, 'config.toml'), 'preferred_auth_method = "apikey"\nforced_login_method = "api"\n');
}

export function enabled(): boolean {
  return config.useContainers;
}

async function podman(args: string[], timeoutMs = 60_000): Promise<string> {
  const { stdout } = await run(config.podmanBin, args, { timeout: timeoutMs, maxBuffer: 4 << 20 });
  return stdout.trim();
}

async function exists(name: string): Promise<'running' | 'stopped' | 'absent'> {
  try {
    const out = await podman(['inspect', '--format', '{{.State.Status}}', name], 15_000);
    return out === 'running' ? 'running' : 'stopped';
  } catch {
    return 'absent';
  }
}

async function create(userId: string): Promise<void> {
  const name = containerName(userId);
  seedAgentHome(userId);

  // ⚠️ A `-v` source path is resolved by **podman on the host**, not by this process.
  // When the main service is itself in a container (a compose deployment) those are not
  // the same path — hand over the /data/... this process sees and podman cannot find it
  // on the host:
  //   `Error: statfs /data/workspaces/<uid>: no such file or directory`
  // HOST_DATA_DIR is how the host-side path is communicated; see hostWorkspace in
  // core/config.ts.
  const userDir = hostWorkspace(userId);
  const homeDir = hostWorkspace(userId, AGENT_HOME);

  const args = [
    'run', '-d', '--name', name,
    '--hostname', `agent-${userId.slice(0, 8)}`,
    // Only this user's directory; MEMORY.md and every conversation subdirectory are inside
    '-v', `${userDir}:/workspace:rw`,
    // The whole HOME is mounted out: the writable layer goes with an rm, and configuration
    // and session records must not
    '-v', `${homeDir}:/home/agent:rw`,
    '-w', '/workspace',
    '--user', '10001:10001',
    // The security baseline
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', '256',
    '--memory', `${config.containerMemoryMb}m`,
    '--memory-swap', `${config.containerMemoryMb}m`,
    '--cpus', String(config.containerCpus),
    '--restart', 'no',
    '--log-opt', 'max-size=10m',
  ];

  if (config.agentNetwork) {
    // A dedicated network. The gateway is on it too (see docker/compose.yml) and agents
    // reach their upstream through it, while keeping an internet route so an agent can
    // install packages and look things up. app and caddy are not on this network, so an
    // agent cannot reach the internal services.
    //
    // Make sure the network exists before naming it. Compose owns this network, but an
    // agent container is not compose's, so nothing deletes it when `compose down -v` (or
    // a `network prune`) tears the named network away: the container survives and later
    // fails with "network ... not found". Creating here means a fresh container never
    // depends on what an earlier lifecycle left behind.
    await ensureNetwork(config.agentNetwork);
    args.push('--network', config.agentNetwork);
  }
  // Unset means the default network, where a container reaches a gateway on the host
  // through host.containers.internal

  args.push(config.agentImage);
  await podman(args, 120_000);
}

/**
 * Make sure a network exists, creating it if it does not.
 *
 * Idempotent and self-healing: `network create` fails when the network is already there,
 * so probe with `inspect` first and create only on a miss. Doing this in `create()` — not
 * at deploy time — keeps the app the single owner of its agent containers' network and
 * removes the manual `docker network create` step a fresh host would otherwise need.
 */
async function ensureNetwork(name: string): Promise<void> {
  try {
    await podman(['network', 'inspect', name], 15_000);
  } catch {
    await podman(['network', 'create', name], 15_000);
  }
}

/** Make sure this user's container is running, and return its name */
export async function ensure(userId: string): Promise<string> {
  const name = containerName(userId);
  const inflight = pending.get(userId);
  if (inflight) return inflight;

  const task = (async () => {
    const status = await exists(name);
    if (status === 'absent') await create(userId);
    else if (status === 'stopped') {
      // A stopped container still remembers the network it was created on. If that
      // network has since been removed — `compose down -v`, a `network prune`, a daemon
      // reset — `start` fails with "network ... not found" and there is no way to reattach
      // it. The container itself holds no state (workspace and HOME are bind mounts), so
      // the recovery is to drop it and let `create` build a fresh one on the live network.
      try {
        await podman(['start', name], 60_000);
      } catch {
        await podman(['rm', '-f', name], 30_000).catch(() => {});
        await create(userId);
      }
    }

    state.set(userId, { name, running: true, lastActiveAt: Date.now(), startedAt: new Date().toISOString() });
    return name;
  })();

  pending.set(userId, task);
  try {
    return await task;
  } finally {
    pending.delete(userId);
  }
}

export function touch(userId: string): void {
  const info = state.get(userId);
  if (info) info.lastActiveAt = Date.now();
}

/**
 * Wrap a command so it executes inside the container.
 *
 * The argv it returns goes straight to spawn, and the caller need not know a container is
 * involved.
 */
export function wrapExec(
  containerNameOrUser: string,
  cwdInsideWorkspace: string,
  env: Record<string, string>,
  cmd: string,
  cmdArgs: string[],
): { file: string; args: string[] } {
  const args = ['exec', '-i', '--workdir', cwdInsideWorkspace];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  args.push(containerNameOrUser, cmd, ...cmdArgs);
  return { file: config.podmanBin, args };
}

/** An absolute path on the host, as the container sees it */
export function toContainerPath(userId: string, hostPath: string): string {
  const userDir = path.join(paths.workspaces, userId);
  const rel = path.relative(userDir, hostPath);
  return rel && !rel.startsWith('..') ? path.posix.join('/workspace', rel) : '/workspace';
}

export async function stop(userId: string): Promise<void> {
  const name = containerName(userId);
  await podman(['stop', '-t', '5', name], 30_000).catch(() => {});
  state.delete(userId);
}

export async function remove(userId: string): Promise<void> {
  const name = containerName(userId);
  await podman(['rm', '-f', name], 30_000).catch(() => {});
  state.delete(userId);
}

/** Idle reclamation: stopped rather than removed, so the next start takes about half a second */
export async function reapIdle(): Promise<number> {
  if (!enabled()) return 0;
  const now = Date.now();
  let n = 0;
  for (const [userId, info] of state) {
    if (now - info.lastActiveAt < config.containerIdleMs) continue;
    await stop(userId);
    n += 1;
  }
  return n;
}

export function list(): ContainerInfo[] {
  return [...state.values()];
}

/** Probe whether the container engine and image are ready; reported once at startup */
export async function probe(): Promise<{ ok: boolean; detail: string }> {
  if (!enabled()) return { ok: false, detail: 'not enabled (USE_CONTAINERS=false)' };
  try {
    const version = await podman(['version', '--format', '{{.Client.Version}}'], 15_000);
    try {
      // `image exists` is podman-only; docker has no such subcommand and reports
      // "unknown command", which caught here would present as a missing image while the
      // image is plainly there. `image inspect` means the same thing to both engines.
      await podman(['image', 'inspect', '--format', '{{.Id}}', config.agentImage], 15_000);
      return { ok: true, detail: `${config.podmanBin} ${version} · image ${config.agentImage}` };
    } catch {
      return {
        ok: false,
        detail:
          `${config.podmanBin} ${version} works, but image ${config.agentImage} is missing. `
          // Which command to run depends on where the image was meant to come from, and
          // guessing wrong sends somebody down the wrong path entirely. Name both.
          + `Pull it with \`${config.podmanBin} pull ${config.agentImage}\`, or build it `
          + 'locally with `npm run build:agent-image`.',
      };
    }
  } catch (err) {
    return {
      ok: false,
      detail: `${config.podmanBin} is unavailable: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
    };
  }
}

/**
 * Run one command in the agent image and throw the container away.
 *
 * For probing: in container mode the CLI is installed **in the image**, not on the main
 * service's PATH. probeBin used to look at this process's PATH, so a containerised
 * deployment reported "executable claude not found" forever while the image plainly had it.
 *
 * It does not reuse a user's container: listAgents has no user context, and the user may
 * not have a container yet.
 */
export async function runInImage(argv: string[], timeoutMs = 20_000): Promise<string> {
  return podman(
    ['run', '--rm', '--network', 'none', '--entrypoint', argv[0]!, config.agentImage, ...argv.slice(1)],
    timeoutMs,
  );
}

export { spawn };

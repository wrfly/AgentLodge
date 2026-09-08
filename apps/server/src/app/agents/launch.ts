import crypto from 'node:crypto';
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as containers from '../containers.js';
import type { RunOptions } from './types.js';

/** What stdio: ['ignore','pipe','pipe'] actually types as: stdin null, stdout and stderr present */
export type AgentProcess = ChildProcessByStdio<null, Readable, Readable>;

/**
 * The environment variable every process of a turn carries in container mode, so that
 * terminate() can find them from outside. In the environment rather than on the command
 * line: the command line carries the prompt, and matching on that is neither exact nor
 * something to grep for.
 */
export const TURN_ENV = 'AGENTLODGE_TURN';

/** Which container a process was started in, and the marker its turn carries */
const inContainer = new WeakMap<AgentProcess, { containerName: string; marker: string }>();

/**
 * Start a CLI process.
 *
 * With container isolation on it is wrapped in `podman exec`; without it, it runs on the
 * host. stdout is identical either way, so the stream parsing above does not have to care.
 *
 * stdin is always ignored: without a TTY, codex waits to read it as additional input.
 */
export function launch(
  o: RunOptions,
  bin: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  /** Environment variable names to carry into the container. In container mode only these are passed, so the host environment does not leak. */
  passEnv: string[] = [],
): AgentProcess {
  if (o.containerName) {
    const overrides: Record<string, string> = {};
    for (const k of passEnv) {
      const v = env[k];
      if (v !== undefined) overrides[k] = v;
    }
    const marker = crypto.randomUUID();
    overrides[TURN_ENV] = marker;
    const w = containers.wrapExec(
      o.containerName,
      o.containerCwd ?? '/workspace',
      overrides,
      bin,
      args,
    );
    const child = spawn(w.file, w.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    inContainer.set(child, { containerName: o.containerName, marker });
    return child;
  }
  return spawn(bin, args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

/**
 * Signal the CLI a turn is running.
 *
 * On the host that is the child itself. In container mode the child is only the
 * `podman exec` client, and a signal to it ends the attachment and nothing else: an exec
 * without a terminal does not forward signals, so the CLI inside kept running — calling
 * the gateway on a ticket still good for twenty minutes, billed to a user who had pressed
 * stop, with nobody reading the answer. So the signal is delivered inside the container,
 * to every process carrying this turn's marker (the CLI and whatever it spawned), and the
 * client is signalled as well so its pipes close.
 */
export function terminate(child: AgentProcess, signal: 'SIGINT' | 'SIGKILL'): void {
  const where = inContainer.get(child);
  if (where) void containers.signalTurn(where.containerName, where.marker, signal);
  if (child.exitCode === null && child.signalCode === null) child.kill(signal);
}

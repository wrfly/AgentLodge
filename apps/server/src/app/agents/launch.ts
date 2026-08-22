import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import * as containers from '../containers.js';
import type { RunOptions } from './types.js';

/** What stdio: ['ignore','pipe','pipe'] actually types as: stdin null, stdout and stderr present */
export type AgentProcess = ChildProcessByStdio<null, Readable, Readable>;

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
    const w = containers.wrapExec(
      o.containerName,
      o.containerCwd ?? '/workspace',
      overrides,
      bin,
      args,
    );
    return spawn(w.file, w.args, { stdio: ['ignore', 'pipe', 'pipe'] });
  }
  return spawn(bin, args, { cwd: o.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

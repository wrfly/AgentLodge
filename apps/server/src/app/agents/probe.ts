import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as containers from '../containers.js';
import type { AgentAvailability } from './types.js';

const run = promisify(execFile);

/** Image probe results are cached per binary: the image does not change at runtime, and starting a container each time costs a second or two */
const imageCache = new Map<string, AgentAvailability>();

function classify(err: unknown, bin: string): AgentAvailability {
  const message = err instanceof Error ? err.message : String(err);
  const notFound = /ENOENT|not found|command not found|no such file/i.test(message);
  return {
    available: false,
    reason: notFound ? `Executable \`${bin}\` not found` : message.slice(0, 200),
  };
}

const firstLine = (s: string): string | undefined => s.trim().split('\n')[0]?.slice(0, 80);

/**
 * Probe whether a CLI is usable.
 *
 * **In container mode this probes the agent image, not this process's PATH.** The two used
 * to be the same thing: in development the main service and the CLI both sit on the host,
 * and probing the local PATH is right. With containers the CLI only exists in the image,
 * and probing locally would report "executable not found" forever while the image clearly
 * has it — measured: agentlodge/agent:1.0 carries claude 2.1.224 and codex-cli 0.147.0.
 */
export async function probeBin(bin: string, args: string[]): Promise<AgentAvailability> {
  if (containers.enabled()) {
    const key = `${bin} ${args.join(' ')}`;
    const hit = imageCache.get(key);
    if (hit) return hit;
    let result: AgentAvailability;
    try {
      result = { available: true, version: firstLine(await containers.runInImage([bin, ...args])) };
    } catch (err) {
      result = classify(err, bin);
    }
    // Only successes are cached: a failure may just mean the image is still building or
    // podman has only just come up, which is worth retrying
    if (result.available) imageCache.set(key, result);
    return result;
  }

  try {
    const { stdout, stderr } = await run(bin, args, { timeout: 8000 });
    return { available: true, version: firstLine(stdout || stderr) };
  } catch (err) {
    return classify(err, bin);
  }
}

/** Call after swapping or rebuilding the image; only the tests need it so far */
export function clearProbeCache(): void {
  imageCache.clear();
}

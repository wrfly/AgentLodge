/** The guard and gateway forwarding shared by the console's routes */
import { requireAdmin } from '../../../core/auth/guard.js';
import { inspect, listCandidates } from '../../../core/secret-file.js';
import type { SecretFile, SecretFileProblem } from '../../../core/secret-file.js';
import { gatewayInternalUrl } from '../../agents/provider.js';

export const guard = { preHandler: requireAdmin };

/**
 * Gate status is always asked over HTTP, even in the same process.
 *
 * It used to read the gate object directly when in-process and forward only when split.
 * After the ROLE split, the app side read a gate that had never been used and the interface
 * showed zeroes everywhere — that bug actually happened. Going over HTTP uniformly makes
 * reading the wrong object impossible, at the cost of one loopback request from an admin
 * page, which is nothing. It also keeps the app layer from depending on the gateway layer.
 */
export async function gateStats(authorization?: string): Promise<Record<string, unknown>> {
  return callGateway('GET', '/gate', authorization);
}

export async function callGateway(
  method: 'GET' | 'PATCH',
  path: string,
  authorization?: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const url = `${gatewayInternalUrl()}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        ...(authorization ? { authorization } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return { error: `the gateway returned ${res.status}`, unreachable: false };
    return (await res.json()) as Record<string, unknown>;
  } catch {
    // The gateway container is not up, or the network is down. Say so, rather than letting
    // the interface read as "concurrency 0"
    return { unreachable: true, error: `cannot reach the gateway (${url})` };
  }
}

/**
 * The status of a key file, **asked of the gateway**.
 *
 * The gateway decides, because it is what reads the key at the moment of a request. The app
 * container usually does not mount that volume at all — mounting it only into the gateway is
 * the recommended shape, since one fewer process able to see a secret is better — so a
 * "no such file" from app's own stat says nothing; the file may be perfectly fine. The
 * converse is not true: if the gateway cannot read it, it genuinely cannot, and that key
 * cannot be sent right now.
 *
 * It also catches a misconfiguration that used to surface only as a 401: SECRET_FILE_ROOTS
 * set on the app side alone, where app considers the path legal and the gateway does not
 * have it on the allowlist at all.
 *
 * When the gateway is unreachable this falls back to the local view, but **labels the
 * source honestly** rather than passing off an unrelated process's answer as authoritative.
 */
export interface SecretFilesView {
  roots: Array<{ path: string; exists: boolean; note?: string }>;
  files: Array<SecretFile | SecretFileProblem>;
  checked?: SecretFile | SecretFileProblem;
  /** Who saw this — the gateway is the authority */
  source: 'gateway' | 'app';
  /** Why source fell back to app */
  sourceNote?: string;
}

export async function secretFilesView(
  path?: string,
  authorization?: string,
): Promise<SecretFilesView> {
  const qs = path ? `?path=${encodeURIComponent(path)}` : '';
  const r = await callGateway('GET', `/secret-files${qs}`, authorization);

  if (!r.error && Array.isArray(r.roots)) {
    return { ...(r as unknown as Omit<SecretFilesView, 'source'>), source: 'gateway' };
  }

  const local = listCandidates();
  return {
    ...local,
    ...(path ? { checked: inspect(path) } : {}),
    source: 'app',
    sourceNote: typeof r.error === 'string' ? r.error : 'cannot reach the gateway',
  };
}

/**
 * The status of several paths, for the provider list.
 *
 * One request to the gateway each — usually only one or two providers hold a key file — sent
 * concurrently.
 */
export async function keyFileStatuses(
  paths: string[],
  authorization?: string,
): Promise<Map<string, SecretFile | SecretFileProblem | undefined>> {
  const uniq = [...new Set(paths.filter(Boolean))];
  const out = new Map<string, SecretFile | SecretFileProblem | undefined>();
  await Promise.all(
    uniq.map(async (p) => {
      out.set(p, (await secretFilesView(p, authorization)).checked);
    }),
  );
  return out;
}

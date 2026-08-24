/** The guard and gateway forwarding shared by the console's routes */
import { requireAdmin } from '../../../core/auth/guard.js';
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
  method: 'GET' | 'PATCH' | 'POST' | 'DELETE',
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
 * The ids the credential manager holds, or undefined when it cannot be asked.
 *
 * The distinction matters: "this provider names a credential that no longer exists" is
 * worth showing in red, and "the credential manager is not running" is not the same
 * claim about that provider at all — drawing the second as the first would put a red
 * line under every provider the moment a socket hiccups.
 */
export async function credentialIds(authorization?: string): Promise<Set<string> | undefined> {
  const res = await callGateway('GET', '/credentials', authorization);
  if (res['unreachable'] || res['error'] || res['configured'] !== true) return undefined;
  const list = res['credentials'];
  if (!Array.isArray(list)) return undefined;
  return new Set(list.map((c) => (c as { id?: string }).id).filter((id): id is string => Boolean(id)));
}

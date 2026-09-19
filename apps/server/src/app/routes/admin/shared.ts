/** The guard, the console's period control, and gateway forwarding — shared by its routes */
import { requireAdmin } from '../../../core/auth/guard.js';
import * as usageRepo from '../../../core/db/usage.js';
import * as quota from '../../../core/quota.js';
import { gatewayInternalUrl } from '../../agents/provider.js';

export const guard = { preHandler: requireAdmin };

export type PlatformPreset = 'window' | 'weekWindow' | 'today' | 'last7' | 'last30' | 'month' | 'all';

const PRESETS: readonly PlatformPreset[] =
  ['window', 'weekWindow', 'today', 'last7', 'last30', 'month', 'all'];

/**
 * What the caller asked for, or the route's own default.
 *
 * Without this a typo is not an error, it is a different period: the query string is cast to
 * `PlatformPreset` and `platformRange`'s `default:` branch answers 'Today', so `?preset=moth`
 * reports today under a label that looks as authoritative as any other — and differs from
 * what omitting the parameter entirely would have returned. Each route names its own
 * fallback, so the two answers agree.
 */
export function presetOr(asked: string | undefined, fallback: PlatformPreset): PlatformPreset {
  return PRESETS.includes(asked as PlatformPreset) ? (asked as PlatformPreset) : fallback;
}

/**
 * The periods the console offers, in one place because two cards now offer them.
 *
 * Everybody's usage and one account's usage are the same question at two scopes, and an
 * operator moving between them is comparing. Two lists of presets would drift — one card
 * gaining a period the other lacks, or the same words cut at different instants — and a
 * comparison between two differently-cut periods is worse than no comparison.
 *
 * Reporting ranges, not quota ranges: they say what was spent between two instants. The
 * gate's own counting can start later for one account, and the quota bar is where that is
 * shown; a period control that silently moved its own start per user would make two accounts'
 * "This 7-day window" mean different stretches of time.
 */
export function platformRange(preset: PlatformPreset): { from: string; to: string; label: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const endOfToday = iso(new Date(today.getTime() + 86400_000));

  switch (preset) {
    /*
     * The same bounds the live card reports, from the same function, so the two cannot
     * disagree about where the window starts — and the period control can answer for the
     * window that refuses first, which was the one period it could not.
     */
    case 'window': {
      const w = quota.boundsOf('window', now);
      return { from: iso(w.start), to: iso(w.end), label: 'This window' };
    }
    /*
     * The seven days the quota is counting, which are not the calendar's.
     *
     * From `boundsOf` rather than recomputed, for the same reason the five-hour window above
     * is: once an upstream states its own weekly cadence the window phase-locks to it, so a
     * week that opened at 20:00 on a Monday reopens at 20:00 on a Monday — and a console
     * cutting it on the administrator's calendar would report a period the gate is not
     * enforcing.
     */
    case 'weekWindow': {
      const w = quota.boundsOf('week', now);
      return { from: iso(w.start), to: iso(w.end), label: 'This 7-day window' };
    }
    case 'last7':
      return { from: iso(new Date(today.getTime() - 6 * 86400_000)), to: endOfToday, label: 'Last 7 days' };
    // The old landing page always drew thirty days, and one preset short of it is a
    // regression on the first of a month, when "This month" is a single bar
    case 'last30':
      return { from: iso(new Date(today.getTime() - 29 * 86400_000)), to: endOfToday, label: 'Last 30 days' };
    case 'month':
      return { from: usageRepo.periodStart('monthly'), to: endOfToday, label: 'This month' };
    case 'all':
      return { from: '1970-01-01T00:00:00.000Z', to: endOfToday, label: 'All time' };
    case 'today':
    default:
      return { from: iso(today), to: endOfToday, label: 'Today' };
  }
}

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
  timeoutMs = 5_000,
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
      signal: AbortSignal.timeout(timeoutMs),
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

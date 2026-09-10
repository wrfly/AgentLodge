/** Overview: the figures on the landing page */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as usageRepo from '../../../core/db/usage.js';
import * as quota from '../../../core/quota.js';
import { getString } from '../../../core/db/settings.js';
import { fetchBalance } from '../../agents/provider.js';
import { listAgents } from '../../agents/registry.js';
import { gateStats, guard } from './shared.js';

/** A number between 0 and 1, or null when the two instants are the same */
function fractionElapsed(start: Date, end: Date, now: Date): number | null {
  const span = end.getTime() - start.getTime();
  if (span <= 0) return null;
  return Math.min(Math.max((now.getTime() - start.getTime()) / span, 0), 1);
}

export function register(app: FastifyInstance): void {

  /**
   * What is true right now.
   *
   * Split from the period report below because the two are asked at different rates: this one
   * is a dashboard somebody leaves open, and the other is a question somebody asks.
   */
  app.get('/api/admin/overview', guard, async (req) => {
    const now = new Date();
    const w = quota.boundsOf('window', now);
    const range = { from: w.start.toISOString(), to: w.end.toISOString() };
    const [balance, agents, gate] = await Promise.all([
      fetchBalance(),
      listAgents(),
      gateStats(req.headers.authorization),
    ]);
    return {
      users: {
        total: usersRepo.count(),
        active: usersRepo.list().filter((u) => u.status === 'active').length,
      },
      /*
       * The five-hour window, platform-wide. It is the one that refuses first, and the only
       * one of the three where "how far through are we" is a live question rather than a
       * retrospective one — which is why `elapsed` is here and not a period preset.
       *
       * The bar to compare it against is the upstream's own utilisation, reported separately
       * by the allowance card: consumption running ahead of the clock is the shape of hitting
       * the wall before the window resets.
       */
      window: {
        startsAt: range.from,
        endsAt: range.to,
        elapsed: fractionElapsed(w.start, w.end, now),
        totals: usageRepo.totalsAllInRange(range),
        statuses: usageRepo.statusCountsAll(range),
      },
      currency: getString('billing.currency', 'USD'),
      allTime: usageRepo.totalsAll(),
      gate,
      balance,
      agents,
    };
  });

  /**
   * Everybody's consumption over one period: the total, the shape of it, and who spent it.
   *
   * Deliberately one endpoint answering for whichever period is asked, rather than a card per
   * period. An operator comparing "who is burning it today" against "who burned it this
   * month" wants one control, not four lists to read side by side.
   */
  app.get('/api/admin/usage', guard, async (req) => {
    const q = req.query as { preset?: PlatformPreset };
    const range = platformRange(q.preset ?? 'today');
    const spanMs = new Date(range.to).getTime() - new Date(range.from).getTime();
    // Two days or less is shown hourly, longer spans daily — the same rule as /api/me/usage
    const byHour = spanMs <= 2 * 86400_000;
    return {
      range,
      currency: getString('billing.currency', 'USD'),
      totals: usageRepo.totalsAllInRange(range),
      series: byHour
        ? usageRepo.hourlyAllInRange(range).map((p) => ({ t: p.hour, ...p }))
        : usageRepo.dailyAllInRange(range).map((p) => ({ t: p.day, ...p })),
      seriesUnit: byHour ? ('hour' as const) : ('day' as const),
      topUsers: usageRepo.topUsers(range, 10),
    };
  });
}

export type PlatformPreset = 'window' | 'today' | 'last7' | 'month' | 'all';

function platformRange(preset: PlatformPreset): { from: string; to: string; label: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const endOfToday = iso(new Date(today.getTime() + 86400_000));

  switch (preset) {
    /*
     * From the quota's own bounds, not a rolling five hours: these are the platform's
     * boundaries, the same instants for everybody, and a span measured backwards from now
     * would not be the window anything is enforced against.
     */
    case 'window': {
      const w = quota.boundsOf('window', now);
      return { from: iso(w.start), to: iso(w.end), label: 'This 5-hour window' };
    }
    case 'last7':
      return { from: iso(new Date(today.getTime() - 6 * 86400_000)), to: endOfToday, label: 'Last 7 days' };
    case 'month':
      return { from: usageRepo.periodStart('monthly'), to: endOfToday, label: 'This month' };
    case 'all':
      return { from: '1970-01-01T00:00:00.000Z', to: endOfToday, label: 'All time' };
    case 'today':
    default:
      return { from: iso(today), to: endOfToday, label: 'Today' };
  }
}

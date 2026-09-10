/** Overview: the figures on the landing page */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as usageRepo from '../../../core/db/usage.js';
import * as quota from '../../../core/quota.js';
import { getString } from '../../../core/db/settings.js';
import { fetchBalance } from '../../agents/provider.js';
import { listAgents } from '../../agents/registry.js';
import { guard } from './shared.js';

export function register(app: FastifyInstance): void {

  /**
   * What is true right now.
   *
   * Split from the period report below because the two are asked at different rates: this one
   * is a dashboard somebody leaves open, and the other is a question somebody asks.
   */
  app.get('/api/admin/overview', guard, async () => {
    const now = new Date();
    const w = quota.boundsOf('window', now);
    const range = { from: w.start.toISOString(), to: w.end.toISOString() };
    const [balance, agents] = await Promise.all([fetchBalance(), listAgents()]);
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
       *
       * How far through it is is not sent. It is a function of the two boundaries and the
       * clock, and computing it once at fetch left a card that counted down correctly beside
       * a bar frozen at whatever it read when the tab was opened.
       */
      window: {
        startsAt: range.from,
        endsAt: range.to,
        totals: usageRepo.totalsAllInRange(range),
        statuses: usageRepo.statusCountsAll(range),
        /** People the gate turned away in this window, not attempts */
        refused: usageRepo.refusedCount(range),
      },
      currency: getString('billing.currency', 'USD'),
      allTime: usageRepo.totalsAll(),
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
      // Padded here: the bucket keys are the server's local time, and a client rebuilding
      // them from its own clock matches nothing
      series: usageRepo.seriesAllInRange(range, byHour ? 'hour' : 'day'),
      seriesUnit: byHour ? ('hour' as const) : ('day' as const),
      topUsers: usageRepo.topUsers(range, 10),
    };
  });
}

export type PlatformPreset = 'window' | 'today' | 'last7' | 'last30' | 'month' | 'all';

function platformRange(preset: PlatformPreset): { from: string; to: string; label: string } {
  const now = new Date();
  const iso = (d: Date) => d.toISOString();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const endOfToday = iso(new Date(today.getTime() + 86400_000));

  switch (preset) {
    /*
     * The same bounds the live card above reports, from the same function, so the two cannot
     * disagree about where the window starts — and the period control can answer "who spent
     * it" for the window that refuses first, which was the one period it could not.
     */
    case 'window': {
      const w = quota.boundsOf('window', now);
      return { from: iso(w.start), to: iso(w.end), label: 'This window' };
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

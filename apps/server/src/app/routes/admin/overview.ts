/** Overview: the figures on the landing page */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as usageRepo from '../../../core/db/usage.js';
import * as quota from '../../../core/quota.js';
import { getString } from '../../../core/db/settings.js';
import { listAgents } from '../../agents/registry.js';
import { guard, platformRange, presetOr } from './shared.js';

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
    /*
     * Balance is not fetched here. Cursor's dashboard is several RPCs including GetTeamSpend,
     * and asking it on this route froze the landing page behind that round trip — the same
     * class of wait `/api/admin/gate` used to cause. The card loads it from `/api/admin/balance`.
     */
    const agents = await listAgents();
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
      agents,
    };
  });

  /**
   * Everybody's consumption over one period: the total, the shape of it, and what carried it.
   *
   * Deliberately one endpoint answering for whichever period is asked, rather than a card per
   * period. An operator comparing "what is burning it today" against "what burned it this
   * month" wants one control, not four lists to read side by side.
   *
   * The breakdown goes upstream → model, and it is an expansion rather than a filter. Clicking
   * an upstream used to narrow the whole card to it, which answered "who used this credential"
   * — a question about people, and people are the users tab's subject, not this card's. What
   * an operator is actually asking here is where a credential's money went, and money goes to
   * models: two of them differ by a factor of ten per token, so an upstream's total says very
   * little on its own.
   *
   * Both breakdowns come from the same period and the same table, so an upstream's models add
   * up to its row and the rows add up to the total above them — in tokens and in money. Not in
   * turns: `turns` is `count(distinct turn_id)`, and one turn that called two models on an
   * upstream is one turn there and one under each model. The console does not print a turns
   * column on this table for that reason.
   */
  app.get('/api/admin/usage', guard, async (req) => {
    const q = req.query as { preset?: string };
    const range = platformRange(presetOr(q.preset, 'today'));
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
      byUpstream: usageRepo.byUpstreamAll(range),
      /** Every (upstream, model) pair, for the page to reveal under the upstream it belongs to */
      byUpstreamModel: usageRepo.byUpstreamModelAll(range),
    };
  });

  /**
   * The same period, asked about people instead of upstreams.
   *
   * Its own route and its own tab because it is its own question. The card above used to end
   * in a top-ten list, which put "where is the money going" and "who is spending it" in one
   * scroll and answered neither properly: ten rows is a leaderboard, not an account of a
   * period, and an operator looking for one person's spend had to hope they were in the top
   * ten.
   *
   * Every account that spent anything, then — not a top N. The list is one row per user, and
   * the models under each are fetched when a row is opened, from the per-user route that
   * already exists. Sending every (user, model) pair inline is what the upstream card does,
   * and it can: upstreams are a handful. Users are not bounded that way.
   */
  app.get('/api/admin/usage-by-user', guard, async (req) => {
    const q = req.query as { preset?: string };
    // The same default as the card above, so an operator moving between the two tabs to
    // compare is not silently handed two different periods
    const range = platformRange(presetOr(q.preset, 'today'));
    return {
      range,
      currency: getString('billing.currency', 'USD'),
      totals: usageRepo.totalsAllInRange(range),
      /*
       * Every account with activity, not a top N: the rows have to add up to the total above
       * them, which a truncated list cannot do. A turn belongs to exactly one account, so
       * unlike the upstream breakdown these rows add up in every column, turns included.
       */
      rows: usageRepo.allUsersInRange(range),
    };
  });
}

/** User administration: listing, detail, usage over a period, quota, role and status, signing out, top-ups */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as sessionsRepo from '../../../core/db/sessions.js';
import * as usageRepo from '../../../core/db/usage.js';
import * as convRepo from '../../../core/db/conversations.js';
import * as audit from '../../../core/db/audit.js';
import * as quota from '../../../core/quota.js';
import * as memory from '../../memory.js';
import * as pricing from '../../../core/db/pricing.js';
import { guard, platformRange, presetOr } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/users', guard, async () => {
    const monthStart = usageRepo.periodStart('monthly');
    // One clock for the whole list. Cut per row, a request that straddles a boundary would
    // count a top-up against a window the row above it has already ended
    const now = new Date();
    const windowBounds = quota.boundsOf('window', now);
    const firstId = usersRepo.firstId();
    return usersRepo.list().map((u) => {
      const q = usersRepo.getQuota(u.id);
      // The 5-hour window is the one that bites first, so it is the one the list shows —
      // counted from wherever the gate counts it from, or an operator who has just reset
      // somebody reads a percentage the reset already forgave
      const windowStart = quota.countStartOf(q, windowBounds.start);
      return {
        ...usersRepo.toPublic(u),
        // Always an active administrator, so the list offers no way to demote or disable it
        first: u.id === firstId,
        quota: {
          // The configured ceilings, and only those: the edit form is seeded from them, so
          // folding a top-up in here would bake a temporary allowance into a permanent limit
          // the moment somebody pressed save
          window: q.window,
          week: q.week,
          month: q.month,
          /*
           * What the gate will actually enforce on the 5-hour window right now, top-up
           * included. The list draws its bar against this. It used to divide by the raw
           * ceiling, so a user who had just been topped up read past 100% while the gate
           * was still letting them through.
           */
          windowCeiling: quota.effectiveCeiling(q, 'window', now),
          limitKind: q.limitKind,
          // So a cost-limited row is labelled in the money it is actually counted in
          currency: q.currency,
          hardStop: q.hardStop,
        },
        usage: {
          period: usageRepo.totalsForUser(u.id, windowStart),
          month: usageRepo.totalsForUser(u.id, monthStart),
          allTime: usageRepo.totalsForUser(u.id),
        },
        conversations: convRepo.idsForUser(u.id).length,
      };
    });
  });

  app.get('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = usersRepo.findById(id);
    if (!user) return reply.code(404).send({ error: tr(req, 'No such user') });
    const q = usersRepo.getQuota(id);
    return {
      ...usersRepo.toPublic(user),
      quota: q,
      quotaStatus: quota.status(id),
      usage: {
        daily: usageRepo.dailyForUser(id, 30),
        byAgent: usageRepo.byAgentForUser(id, quota.boundsOf('month').start.toISOString()),
        byConversation: usageRepo.byConversationForUser(id, 10),
        allTime: usageRepo.totalsForUser(id),
      },
      sessions: sessionsRepo.listActive(id).length,
      memory: await memory.stats(id),
    };
  });

  /**
   * What one account spent over a chosen period, per agent and per model.
   *
   * Its own route rather than a field on the detail above, because the console opens this one
   * row at a time and the detail response is expensive in a way this question is not: a
   * 30-day series, the heaviest conversations, the live sessions, three scopes of quota
   * status, and `memory.stats`, which reads every one of that user's memory files off disk to
   * count their bytes. None of it is on screen here.
   *
   * The periods are `platformRange`'s, the same ones the console's all-users card offers, so
   * that one account and everybody can be read against each other — an operator moving between
   * the two cards is comparing, and two lists of presets would drift.
   *
   * They are **reporting** ranges: what was spent between two instants. The gate's own
   * counting can begin later for one account, and the quota bar in the manage panel is where
   * that is shown. The range comes back with the rows, label included, because a label picked
   * on one side of the wire from a range computed on the other is how the two drift apart.
   */
  app.get('/api/admin/users/:id/usage-by-agent', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!usersRepo.findById(id)) return reply.code(404).send({ error: tr(req, 'No such user') });
    const { preset } = req.query as { preset?: string };
    const q = usersRepo.getQuota(id);
    // One range object for the rows and for their total: read twice, a request that straddled
    // a boundary would put one period's rows under another period's total
    const range = platformRange(presetOr(preset, 'today'));
    return {
      currency: q.currency,
      range,
      rows: usageRepo.byAgentForUser(id, range),
      /**
       * Deliberately not the rows' sum: a turn that called two models is one turn and belongs
       * to both rows, so the column adds up to more than this. The console says so out loud
       * when they differ, which it can only do if this is counted rather than added up.
       */
      total: usageRepo.totalsForUser(id, range),
    };
  });

  app.patch('/api/admin/users/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      status?: usersRepo.UserStatus;
      role?: usersRepo.Role;
      /** The three ceilings, in the unit limitKind names. null clears one. */
      window?: number | null;
      week?: number | null;
      month?: number | null;
      hardStop?: boolean;
      limitKind?: 'tokens' | 'cost';
    };
    const user = usersRepo.findById(id);
    if (!user) return reply.code(404).send({ error: tr(req, 'No such user') });

    if (body.role !== undefined && body.role !== 'user' && body.role !== 'admin')
      return reply.code(400).send({ error: tr(req, 'Unknown role') });
    if (body.status !== undefined && body.status !== 'active' && body.status !== 'suspended')
      return reply.code(400).send({ error: tr(req, 'Unknown status') });
    // The first account is always an active administrator
    if ((body.role === 'user' || body.status === 'suspended') && id === usersRepo.firstId())
      return reply.code(400).send({ error: tr(req, 'The first account cannot be disabled or demoted') });

    // Never demote or disable the last administrator, or nobody can reach the console
    const admins = usersRepo.list().filter((u) => u.role === 'admin' && u.status === 'active');
    const demoting = (body.role && body.role !== 'admin') || body.status === 'suspended';
    if (user.role === 'admin' && demoting && admins.length <= 1)
      return reply.code(400).send({ error: tr(req, 'The last administrator cannot be disabled or demoted') });

    if (body.status) usersRepo.setStatus(id, body.status);
    if (body.role) usersRepo.setRole(id, body.role);
    const quotaKeys = ['window', 'week', 'month', 'hardStop', 'limitKind'] as const;
    if (quotaKeys.some((k) => body[k] !== undefined)) {
      const patch: usersRepo.QuotaPatch = {};
      for (const k of quotaKeys) {
        if (body[k] !== undefined) (patch as Record<string, unknown>)[k] = body[k];
      }
      usersRepo.setQuota(id, patch, req.user!.id);
    }
    if (body.status === 'suspended') sessionsRepo.revokeAll(id);

    audit.log({
      actorId: req.user!.id,
      action: 'admin.user.update',
      targetType: 'user',
      targetId: id,
      detail: body,
      ip: req.ip,
    });

    const updated = usersRepo.findById(id)!;
    return { ...usersRepo.toPublic(updated), quota: usersRepo.getQuota(id) };
  });

  app.post('/api/admin/users/:id/logout-all', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!usersRepo.findById(id)) return reply.code(404).send({ error: tr(req, 'No such user') });
    const n = sessionsRepo.revokeAll(id);
    audit.log({
      actorId: req.user!.id,
      action: 'admin.user.logout_all',
      targetType: 'user',
      targetId: id,
      detail: { revoked: n },
      ip: req.ip,
    });
    return { ok: true, revoked: n };
  });

  /**
   * A top-up: extra allowance on one window, gone when that window resets.
   *
   * It used to start a rolling period with its own clock, which is exactly the per-user
   * window the quota model exists to remove — a user topped up at four had boundaries
   * nobody else had. Attached to a window instead, it keeps what it was for (letting one
   * person through for now) and expires on a boundary everybody shares.
   */
  app.post('/api/admin/users/:id/topup', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!usersRepo.findById(id)) return reply.code(404).send({ error: tr(req, 'No such user') });

    const body = (req.body ?? {}) as {
      /** An amount in whole units of money; either this or tokens */
      amount?: number;
      tokens?: number;
      /** Which window it lifts. Defaults to the 5-hour one, the one that bites first. */
      scope?: usersRepo.QuotaScope;
      note?: string;
    };

    const scope: usersRepo.QuotaScope =
      body.scope === 'week' || body.scope === 'month' ? body.scope : 'window';
    const byCost = body.amount !== undefined;
    const amount = byCost ? Math.round(Number(body.amount) * pricing.MICRO) : Number(body.tokens);
    if (!Number.isFinite(amount) || amount <= 0)
      return reply.code(400).send({ error: tr(req, 'Give either an amount or a token limit') });

    const current = usersRepo.getQuota(id);
    if ((byCost ? 'cost' : 'tokens') !== current.limitKind)
      return reply
        .code(400)
        .send({ error: tr(req, 'This user is billed the other way; change the quota first') });

    /*
     * A top-up on a window with no ceiling is discarded: `limit` is `ceiling + boost` only
     * where there is a ceiling. It used to be accepted, written to the row, and then never
     * applied or mentioned anywhere — the operator saw "ok" and the user got nothing. Say so
     * instead, and name the window, since the three are set independently.
     */
    if (quota.effectiveCeiling(current, scope) === null)
      return reply.code(400).send({
        error: tr(req, 'That window has no ceiling, so a top-up would do nothing — set a limit first'),
      });

    usersRepo.grantBoost(id, scope, amount, quota.boundsOf(scope).end.toISOString(), req.user!.id);
    /*
     * The boost is the intervention; a previous manual reset should not compound it.
     *
     * Zeroing usage is gone from the console, but `reset_at` rows written before it was
     * removed are still honoured by the gate — and with the reset route gone this is the only
     * thing left that can clear one. Dropping it would leave those accounts counting from an
     * old reset **and** holding the extra ceiling, with nothing able to put them back.
     */
    usersRepo.undoResetUsage(id);

    audit.log({
      actorId: req.user!.id,
      action: 'admin.user.topup',
      targetType: 'user',
      targetId: id,
      detail: { scope, amount, byCost, note: body.note },
      ip: req.ip,
    });
    return { ok: true, quota: quota.status(id) };
  });
}

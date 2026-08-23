/** User administration: listing, detail, quota, role and status, resetting usage, signing out, top-ups */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as sessionsRepo from '../../../core/db/sessions.js';
import * as usageRepo from '../../../core/db/usage.js';
import * as convRepo from '../../../core/db/conversations.js';
import * as audit from '../../../core/db/audit.js';
import * as quota from '../../../core/quota.js';
import * as memory from '../../memory.js';
import * as pricing from '../../../core/db/pricing.js';
import { guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/users', guard, async () => {
    const monthStart = usageRepo.periodStart('monthly');
    return usersRepo.list().map((u) => {
      const q = usersRepo.getQuota(u.id);
      // The 5-hour window is the one that bites first, so it is the one the list shows
      const windowStart = quota.boundsOf('window').start.toISOString();
      return {
        ...usersRepo.toPublic(u),
        quota: { window: q.window, week: q.week, month: q.month, limitKind: q.limitKind, hardStop: q.hardStop },
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

  app.post('/api/admin/users/:id/reset-usage', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!usersRepo.findById(id)) return reply.code(404).send({ error: tr(req, 'No such user') });
    const body = (req.body ?? {}) as { undo?: boolean };
    const before = quota.status(id);

    // Undoable if clicked by mistake: clearing reset_at returns to the natural period
    if (body.undo) {
      usersRepo.undoResetUsage(id);
      audit.log({
        actorId: req.user!.id,
        action: 'admin.user.undo_reset_usage',
        targetType: 'user',
        targetId: id,
        ip: req.ip,
      });
      return { ok: true, undone: true, quota: quota.status(id) };
    }

    usersRepo.resetUsage(id);
    audit.log({
      actorId: req.user!.id,
      action: 'admin.user.reset_usage',
      targetType: 'user',
      targetId: id,
      // Record the figure before zeroing — the books keep a trace
      detail: { cleared: before.windows.month.used, scope: 'all windows' },
      ip: req.ip,
    });
    return { ok: true, clearedTokens: before.windows.month.used, quota: quota.status(id) };
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

    usersRepo.grantBoost(id, scope, amount, quota.boundsOf(scope).end.toISOString(), req.user!.id);
    // The boost is the intervention; a previous manual reset should not compound it
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

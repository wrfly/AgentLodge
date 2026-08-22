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
      const used = usageRepo.totalsForUser(u.id, usageRepo.periodStart(q.period));
      return {
        ...usersRepo.toPublic(u),
        quota: { tokenLimit: q.tokenLimit, period: q.period, hardStop: q.hardStop },
        usage: {
          period: used,
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
        byAgent: usageRepo.byAgentForUser(id, usageRepo.periodStart(q.period)),
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
      tokenLimit?: number | null;
      period?: usersRepo.QuotaPeriod;
      hardStop?: boolean;
      periodHours?: number | null;
      /** 'now' starts the clock at this moment */
      cycleStart?: string | null;
      autoRenew?: boolean;
      limitKind?: 'tokens' | 'cost';
      costLimitMicro?: number | null;
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
    const quotaKeys = [
      'tokenLimit', 'period', 'hardStop', 'periodHours',
      'cycleStart', 'autoRenew', 'limitKind', 'costLimitMicro',
    ] as const;
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
      detail: { clearedTokens: before.used, period: before.period },
      ip: req.ip,
    });
    return { ok: true, clearedTokens: before.used, quota: quota.status(id) };
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
   * A top-up: grant an allowance and start the clock now.
   *
   * This is the entry point for "ten units, to be used within three hours" — one call sets
   * the allowance, the window length, the start point and whether it renews, and clears any
   * previous manual reset.
   */
  app.post('/api/admin/users/:id/topup', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!usersRepo.findById(id)) return reply.code(404).send({ error: tr(req, 'No such user') });

    const body = (req.body ?? {}) as {
      /** An amount in whole units; either this or tokenLimit */
      amount?: number;
      tokenLimit?: number;
      /** How many hours it is valid for, e.g. 3 */
      hours?: number;
      /** true renews every N hours; false makes it a one-off */
      autoRenew?: boolean;
      note?: string;
    };

    const hours = Number(body.hours);
    if (!Number.isFinite(hours) || hours <= 0)
      return reply.code(400).send({ error: tr(req, 'The number of hours has to be greater than 0') });

    const byCost = body.amount !== undefined;
    if (!byCost && !body.tokenLimit)
      return reply.code(400).send({ error: tr(req, 'Give either an amount or a token limit') });

    usersRepo.setQuota(
      id,
      {
        period: 'rolling',
        periodHours: hours,
        cycleStart: 'now',
        autoRenew: body.autoRenew ?? false,
        hardStop: true,
        limitKind: byCost ? 'cost' : 'tokens',
        costLimitMicro: byCost ? Math.round(Number(body.amount) * pricing.MICRO) : null,
        tokenLimit: byCost ? null : Number(body.tokenLimit),
      },
      req.user!.id,
    );
    // A top-up starts a new period, so any previous manual reset is cleared
    usersRepo.undoResetUsage(id);

    audit.log({
      actorId: req.user!.id,
      action: 'admin.user.topup',
      targetType: 'user',
      targetId: id,
      detail: { amount: body.amount, tokenLimit: body.tokenLimit, hours, autoRenew: body.autoRenew, note: body.note },
      ip: req.ip,
    });
    return { ok: true, quota: quota.status(id) };
  });
}

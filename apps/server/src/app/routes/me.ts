import type { FastifyInstance } from 'fastify';
import * as apiKeysRepo from '../../core/db/api-keys.js';
import * as audit from '../../core/db/audit.js';
import * as usageRepo from '../../core/db/usage.js';
import * as memory from '../memory.js';
import * as quota from '../../core/quota.js';
import * as trace from '../../core/trace.js';
import { requireUser } from '../../core/auth/guard.js';
import { config } from '../../core/config.js';
import { tr } from '../../core/i18n/locale.js';

const guard = { preHandler: requireUser };

/* ---------------- Parsing a window ---------------- */

export type RangePreset =
  | 'today'
  | 'yesterday'
  | 'week'
  | 'month'
  | 'last7'
  | 'last30'
  | 'quota'
  | 'all'
  | 'custom';

const startOfDay = (d: Date): Date => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/**
 * Resolve a preset or a custom range into [from, to).
 *
 * Always in the server's local timezone, so it agrees with daily totals and quota periods.
 */
function resolveRange(
  preset: RangePreset,
  fromRaw?: string,
  toRaw?: string,
  quotaStart?: string,
): { from: string; to: string; label: string } {
  const now = new Date();
  const today = startOfDay(now);
  const day = 86400_000;
  const iso = (d: Date) => d.toISOString();
  const endOfToday = iso(new Date(today.getTime() + day));

  switch (preset) {
    case 'today':
      return { from: iso(today), to: endOfToday, label: 'Today' };
    case 'yesterday':
      return {
        from: iso(new Date(today.getTime() - day)),
        to: iso(today),
        label: 'Yesterday',
      };
    case 'week':
      return { from: usageRepo.periodStart('weekly'), to: endOfToday, label: 'This week' };
    case 'month':
      return { from: usageRepo.periodStart('monthly'), to: endOfToday, label: 'This month' };
    case 'last7':
      return { from: iso(new Date(today.getTime() - 6 * day)), to: endOfToday, label: 'Last 7 days' };
    case 'last30':
      return { from: iso(new Date(today.getTime() - 29 * day)), to: endOfToday, label: 'Last 30 days' };
    case 'all':
      return { from: '1970-01-01T00:00:00.000Z', to: endOfToday, label: 'All time' };
    case 'custom': {
      // A bare date (YYYY-MM-DD) means whole local days, with `to` inclusive
      const from = fromRaw ? new Date(fromRaw.length === 10 ? `${fromRaw}T00:00:00` : fromRaw) : today;
      const to = toRaw
        ? new Date(toRaw.length === 10 ? `${toRaw}T00:00:00` : toRaw)
        : new Date(today.getTime() + day);
      const toExclusive = toRaw && toRaw.length === 10 ? new Date(to.getTime() + day) : to;
      return {
        from: iso(from),
        to: iso(toExclusive),
        label: `${fromRaw ?? ''} ~ ${toRaw ?? 'now'}`,
      };
    }
    case 'quota':
    default:
      return {
        from: quotaStart ?? usageRepo.periodStart('monthly'),
        to: endOfToday,
        label: 'This quota period',
      };
  }
}

export function registerMeRoutes(app: FastifyInstance): void {
  /* ---------------- Usage ---------------- */

  /**
   * Three ways to ask:
   *   ?preset=today|yesterday|week|month|last7|last30|quota|all
   *   ?preset=custom&from=2026-08-01&to=2026-08-15
   *   no parameters → the current quota period
   */
  app.get('/api/me/usage', guard, async (req) => {
    const userId = req.user!.id;
    const q = req.query as { preset?: RangePreset; from?: string; to?: string };
    const quotaStatus = quota.status(userId);

    const range = resolveRange(
      q.preset ?? 'quota',
      q.from,
      q.to,
      quotaStatus.periodStart,
    );
    const window = { from: range.from, to: range.to };

    // Two days or less is shown hourly, longer spans daily — grouping "today" by day is one bar
    const spanMs = new Date(range.to).getTime() - new Date(range.from).getTime();
    const byHour = spanMs <= 2 * 86400_000;

    return {
      quota: quotaStatus,
      range: { ...range, preset: q.preset ?? 'quota' },
      totals: usageRepo.totalsForUser(userId, window),
      /** Chart data: hourly over a short span, daily over a long one */
      series: byHour
        ? usageRepo.hourlyForUserRange(userId, window).map((p) => ({ t: p.hour, ...p }))
        : usageRepo.dailyForUserRange(userId, window).map((p) => ({ t: p.day, ...p })),
      seriesUnit: byHour ? ('hour' as const) : ('day' as const),
      byAgent: usageRepo.byAgentForUser(userId, window),
      byConversation: usageRepo.byConversationForUser(userId, 10, window),
      /** A few figures people look at often, so the frontend does not fire several requests */
      quick: {
        today: usageRepo.totalsForUser(userId, resolveRange('today')),
        month: usageRepo.totalsForUser(userId, resolveRange('month')),
        allTime: usageRepo.totalsForUser(userId),
      },
    };
  });

  /** All the sidebar's usage bar needs, on an endpoint of its own */
  app.get('/api/me/quota', guard, async (req) => quota.status(req.user!.id));

  /* ---------------- Memory ---------------- */

  app.get('/api/me/memory', guard, async (req) => {
    const userId = req.user!.id;
    return {
      content: await memory.ensureInitialized(userId),
      stats: await memory.stats(userId),
      maxBytes: memory.MAX_BYTES,
    };
  });

  app.put('/api/me/memory', guard, async (req, reply) => {
    const body = (req.body ?? {}) as { content?: string };
    if (typeof body.content !== 'string')
      return reply.code(400).send({ error: tr(req, 'Missing content') });
    if (Buffer.byteLength(body.content, 'utf8') > memory.MAX_BYTES)
      return reply
        .code(413)
        .send({ error: tr(req, 'Memory cannot exceed {kb} KB', { kb: memory.MAX_BYTES / 1024 }) });

    await memory.write(req.user!.id, body.content);
    return { ok: true, stats: await memory.stats(req.user!.id) };
  });

  app.delete('/api/me/memory', guard, async (req) => {
    await memory.clear(req.user!.id);
    return { ok: true, content: await memory.ensureInitialized(req.user!.id) };
  });

  /* ---------------- Request traces ---------------- */

  // The directory name is always built from req.user.id and the client cannot supply it, so
  // reading someone else's traces does not exist as a possibility at the path level.
  app.get('/api/me/traces', guard, async (req) => {
    const q = (req.query ?? {}) as { limit?: string };
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    return { traces: trace.list(req.user!.id, limit), enabled: config.traceRequests };
  });

  app.get('/api/me/traces/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const detail = trace.get(req.user!.id, id);
    if (!detail) return reply.code(404).send({ error: tr(req, 'No such trace') });
    return detail;
  });

  app.delete('/api/me/traces', guard, async (req) => ({
    ok: true,
    removed: trace.clear(req.user!.id),
  }));

  /* ---------------- API keys, for pointing your own CLI here ---------------- */

  app.get('/api/me/api-keys', guard, async (req) => {
    const usage = new Map(
      usageRepo.byApiKeyForUser(req.user!.id).map((u) => [u.apiKeyId, u]),
    );
    return {
      keys: apiKeysRepo.list(req.user!.id).map((k) => ({
        ...k,
        usage: usage.get(k.id) ?? null,
      })),
      /** What to put in BASE_URL. Unset, the frontend falls back to the current origin. */
      baseUrl: config.publicGatewayUrl,
    };
  });

  app.post('/api/me/api-keys', guard, async (req, reply) => {
    const { name } = (req.body ?? {}) as { name?: string };
    const trimmed = (name ?? '').trim();
    if (!trimmed) return reply.code(400).send({ error: tr(req, 'Give this key a name') });
    if (trimmed.length > 64) return reply.code(400).send({ error: tr(req, 'A name can be at most 64 characters') });

    // A ceiling against creating them by accident, not a security boundary
    const live = apiKeysRepo.list(req.user!.id).filter((k) => !k.revokedAt);
    if (live.length >= 20) {
      return reply.code(400).send({ error: tr(req, 'At most 20 active keys; revoke some before creating more') });
    }

    const { key, plaintext } = apiKeysRepo.create(req.user!.id, trimmed);
    audit.log({
      actorId: req.user!.id,
      action: 'apikey.create',
      targetType: 'api_key',
      targetId: key.id,
      detail: { name: trimmed },
      ip: req.ip,
    });
    // The plaintext exists this once; the database keeps only a sha256
    reply.code(201);
    return { key, plaintext };
  });

  app.delete('/api/me/api-keys/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!apiKeysRepo.revoke(id, req.user!.id)) {
      return reply.code(404).send({ error: tr(req, 'No such key, or it has already been revoked') });
    }
    audit.log({
      actorId: req.user!.id,
      action: 'apikey.revoke',
      targetType: 'api_key',
      targetId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}

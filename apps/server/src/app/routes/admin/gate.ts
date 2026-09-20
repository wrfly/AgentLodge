/** The metering gateway's concurrency gate: status and tuning. Forwarded to the gateway when split across processes. */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import { gatewayEnabled } from '../../agents/provider.js';
import { config } from '../../../core/config.js';
import { setSetting } from '../../../core/db/settings.js';
import * as containers from '../../containers.js';
import { guard } from './shared.js';
import { gateStats, callGateway } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/gate', guard, async (req) => ({
    enabled: gatewayEnabled(),
    ...(await gateStats(req.headers.authorization)),
    containers: {
      enabled: containers.enabled(),
      ...(await containers.probe()),
      running: containers.list().length,
    },
  }));

  /**
   * Everything "how many at once" means, written here and read by the gate.
   *
   * Stored before it is forwarded, and that order is the point. This used to be a forward
   * and nothing else, which made the limit a property of the gateway container's uptime
   * rather than a setting: every restart put it back to `MAX_UPSTREAM_CONCURRENCY` with
   * nothing in the console to say it had. Writing the row first also means the gateway reads
   * the new value on the very pass the forward triggers.
   *
   * Three fields rather than two, because `gateway.perUserInflightMax` arrives here now
   * instead of through the generic settings page. They are one gate's settings and were
   * edited in two places under two different save models — a batched draft on one page, a
   * button of its own on the other — which is a poor way to configure a pair of numbers
   * whose whole difficulty is how they interact.
   */
  app.patch('/api/admin/gate', guard, async (req, reply) => {
    const body = (req.body ?? {}) as {
      maxConcurrency?: number;
      perUserInflightMax?: number;
      pinned?: boolean;
    };
    const detail: { maxConcurrency?: number; perUserInflightMax?: number; pinned?: boolean } = {};

    /*
     * The one range both limits take.
     *
     * `isInteger` rather than `isFinite`: the old check let 2.5 through to `setSetting`,
     * whose own validate refused it by throwing — so a fractional limit came back as a 500
     * with a stack trace instead of the 400 the same value gets from the settings page.
     *
     * And the type is checked rather than coerced. `Number(true)` is 1, which passed every
     * test below, so `{"maxConcurrency": true}` quietly took the whole deployment down to one
     * request in flight per upstream and filed an audit entry saying it had been asked for.
     */
    const limit = (v: unknown): number | null => {
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > 64) return null;
      return v;
    };

    /*
     * Both limits are read and checked before either is written.
     *
     * They arrive in one body now — the card saves whichever moved — and validating each one
     * as it was stored meant a body with a good ceiling and a bad per-user cap persisted the
     * ceiling and then answered 400. Nothing downstream ran for it: no audit entry naming who
     * had changed it, no forward, and a console that had just been told the write failed. The
     * half that landed was invisible from every direction.
     */
    const asked: Array<[key: string, value: number]> = [];
    if (body.maxConcurrency !== undefined) {
      const n = limit(body.maxConcurrency);
      if (n === null)
        return reply.code(400).send({ error: tr(req, 'The concurrency limit has to be between 1 and 64') });
      asked.push(['gateway.maxUpstreamConcurrency', n]);
      detail.maxConcurrency = n;
    }
    if (body.perUserInflightMax !== undefined) {
      const n = limit(body.perUserInflightMax);
      // Its own message: this one is rendered above both boxes, and "the concurrency limit"
      // reads as a complaint about the other one, which the administrator did not touch
      if (n === null)
        return reply.code(400).send({ error: tr(req, 'The per-user slot limit has to be between 1 and 64') });
      asked.push(['gateway.perUserInflightMax', n]);
      detail.perUserInflightMax = n;
    }
    if (!asked.length && typeof body.pinned !== 'boolean')
      return reply.code(400).send({ error: tr(req, 'The concurrency limit has to be between 1 and 64') });

    for (const [key, value] of asked) setSetting(key, String(value), req.user!.id);
    // Stored as the switch it is — adapting — rather than as the pin, so the setting reads
    // the same way round as the behaviour it names
    if (typeof body.pinned === 'boolean') {
      setSetting('gateway.adaptiveConcurrency', String(!body.pinned), req.user!.id);
      detail.pinned = body.pinned;
    }

    /*
     * Only the ceiling travels — it is the one value the gateway process keeps a fallback
     * copy of. The other two are read fresh on every admission pass, so what the forward is
     * for there is the `reschedule` at the far end: raising the per-user cap, like lifting
     * the pin, makes queued requests eligible with no slot released behind them, and nothing
     * in the gate looks at its queues on its own. On a gate held by long streaming turns
     * that eligibility would sit unused until the waiters timed out.
     */
    const stats = await callGateway('PATCH', '/gate', req.headers.authorization, {
      ...(detail.maxConcurrency !== undefined ? { maxConcurrency: detail.maxConcurrency } : {}),
    });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.gate.update',
      detail,
      ip: req.ip,
    });
    return { enabled: gatewayEnabled(), ...stats };
  });
}

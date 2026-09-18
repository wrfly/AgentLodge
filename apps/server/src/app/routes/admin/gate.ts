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
   * The two halves of "how many at once", written here and read by the gate.
   *
   * Stored before it is forwarded, and that order is the point. This used to be a forward
   * and nothing else, which made the limit a property of the gateway container's uptime
   * rather than a setting: every restart put it back to `MAX_UPSTREAM_CONCURRENCY` with
   * nothing in the console to say it had. Writing the row first also means the gateway reads
   * the new value on the very pass the forward triggers.
   */
  app.patch('/api/admin/gate', guard, async (req, reply) => {
    const body = (req.body ?? {}) as { maxConcurrency?: number; pinned?: boolean };
    const detail: { maxConcurrency?: number; pinned?: boolean } = {};

    if (body.maxConcurrency !== undefined) {
      const n = Number(body.maxConcurrency);
      if (!Number.isFinite(n) || n < 1 || n > 64)
        return reply.code(400).send({ error: tr(req, 'The concurrency limit has to be between 1 and 64') });
      setSetting('gateway.maxUpstreamConcurrency', String(n), req.user!.id);
      detail.maxConcurrency = n;
    }
    // Stored as the switch it is — adapting — rather than as the pin, so the setting reads
    // the same way round as the behaviour it names
    if (typeof body.pinned === 'boolean') {
      setSetting('gateway.adaptiveConcurrency', String(!body.pinned), req.user!.id);
      detail.pinned = body.pinned;
    }
    if (detail.maxConcurrency === undefined && detail.pinned === undefined)
      return reply.code(400).send({ error: tr(req, 'The concurrency limit has to be between 1 and 64') });

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

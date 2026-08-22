/** The metering gateway's concurrency gate: status and tuning. Forwarded to the gateway when split across processes. */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import { gatewayEnabled } from '../../agents/provider.js';
import { config } from '../../../core/config.js';
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

  app.patch('/api/admin/gate', guard, async (req, reply) => {
    const body = (req.body ?? {}) as { maxConcurrency?: number };
    const n = Number(body.maxConcurrency);
    if (!Number.isFinite(n) || n < 1 || n > 64)
      return reply.code(400).send({ error: tr(req, 'The concurrency limit has to be between 1 and 64') });
    const stats = await callGateway('PATCH', '/gate', req.headers.authorization, {
      maxConcurrency: n,
    });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.gate.update',
      detail: { maxConcurrency: n },
      ip: req.ip,
    });
    return { enabled: gatewayEnabled(), ...stats };
  });
}

/**
 * The shared plan's own allowance.
 *
 * Every user is shown their own quota instead of this — one subscription serves all of them,
 * so the pool's figures are nobody's allowance in particular (gateway/quota-report.ts). The
 * administrator is the exception: they are the one who has to know how much of the plan is
 * left, and the figures exist only on responses passing through the gateway process, which
 * is why this forwards rather than reads.
 */
import type { FastifyInstance } from 'fastify';
import { gatewayEnabled } from '../../agents/provider.js';
import { callGateway, guard } from './shared.js';

export function register(app: FastifyInstance): void {
  app.get('/api/admin/upstream-allowance', guard, async (req) => ({
    enabled: gatewayEnabled(),
    ...(await callGateway('GET', '/upstream-allowance', req.headers.authorization)),
  }));
}

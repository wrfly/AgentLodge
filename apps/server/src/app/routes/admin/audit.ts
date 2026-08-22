/** The audit log */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import { guard } from './shared.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/audit-logs', guard, async (req) => {
    const { limit } = req.query as { limit?: string };
    return audit.list(Math.min(Number(limit) || 200, 1000));
  });
}

/** The price table: four unit prices per model */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import * as pricing from '../../../core/db/pricing.js';
import { guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/pricing', guard, async () => pricing.list());

  app.post('/api/admin/pricing', guard, async (req, reply) => {
    const body = (req.body ?? {}) as {
      model?: string;
      currency?: string;
      /** The interface takes a price per million tokens; this converts to micro-units */
      priceInput?: number;
      priceCacheRead?: number;
      priceCacheWrite?: number;
      priceOutput?: number;
      note?: string;
    };
    if (!body.model?.trim()) return reply.code(400).send({ error: tr(req, 'Missing model name') });
    const yuan = (v: unknown) => Math.round(Number(v ?? 0) * pricing.MICRO);
    const row = pricing.add({
      model: body.model,
      currency: body.currency,
      priceInput: yuan(body.priceInput),
      priceCacheRead: yuan(body.priceCacheRead),
      priceCacheWrite: yuan(body.priceCacheWrite),
      priceOutput: yuan(body.priceOutput),
      note: body.note,
    });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.pricing.add',
      detail: { model: body.model },
      ip: req.ip,
    });
    return row;
  });

  app.delete('/api/admin/pricing/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!pricing.remove(Number(id))) return reply.code(404).send({ error: tr(req, 'No such price') });
    return { ok: true };
  });
}

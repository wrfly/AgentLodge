/**
 * The model catalogue: what users can pick, and which upstream serves each.
 *
 * This is the routing table. A row here is what makes a name usable — the picker offers
 * it, a request carrying it is forwarded to that row's provider, and the bill is written
 * under it. An upstream with no model pointed at it receives nothing.
 */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import * as modelsRepo from '../../../core/db/models.js';
import * as providersRepo from '../../../core/db/providers.js';
import { callGateway, guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/models', guard, async () => {
    const providers = providersRepo.list();
    return {
      models: modelsRepo.list(),
      /** So the console can name the upstream behind each row without a second request */
      providers: providers.map((p) => ({ id: p.id, name: p.name, kind: p.kind })),
    };
  });

  app.post('/api/admin/models', guard, async (req, reply) => {
    const b = (req.body ?? {}) as modelsRepo.UpsertInput;
    if (!b.name?.trim()) return reply.code(400).send({ error: tr(req, 'Missing name') });
    if (!b.providerId || !providersRepo.findById(b.providerId)) {
      return reply.code(400).send({ error: tr(req, 'No such provider') });
    }
    const m = modelsRepo.create(b);
    audit.log({ actorId: req.user!.id, action: 'admin.model.create', targetType: 'model', targetId: m.id, detail: { name: m.name, provider: m.providerId }, ip: req.ip });
    return m;
  });

  app.patch('/api/admin/models/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const b = (req.body ?? {}) as Partial<modelsRepo.UpsertInput>;
    if (b.providerId && !providersRepo.findById(b.providerId)) {
      return reply.code(400).send({ error: tr(req, 'No such provider') });
    }
    const m = modelsRepo.update(id, b);
    if (!m) return reply.code(404).send({ error: tr(req, 'No such model') });
    audit.log({ actorId: req.user!.id, action: 'admin.model.update', targetType: 'model', targetId: id, ip: req.ip });
    return m;
  });

  app.delete('/api/admin/models/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!modelsRepo.remove(id)) return reply.code(404).send({ error: tr(req, 'No such model') });
    audit.log({ actorId: req.user!.id, action: 'admin.model.delete', targetType: 'model', targetId: id, ip: req.ip });
    return { ok: true };
  });

  /**
   * Ask an upstream what it offers and add whatever is missing.
   *
   * The asking is forwarded to the gateway, which is where the credential can be used;
   * what comes back is written here. Only additions: a model turned off stays off, and an
   * order somebody set stays as it is.
   */
  app.post('/api/admin/models/pull', guard, async (req, reply) => {
    const { providerId } = (req.body ?? {}) as { providerId?: string };
    const provider = providerId ? providersRepo.findById(providerId) : undefined;
    if (!provider) return reply.code(400).send({ error: tr(req, 'No such provider') });

    const res = await callGateway('GET', `/models?provider=${encodeURIComponent(provider.id)}`, req.headers.authorization);
    if (typeof res['error'] === 'string') return reply.code(400).send({ error: res['error'] });

    const names = Array.isArray(res['models']) ? (res['models'] as string[]) : [];
    const added = modelsRepo.addMissing(provider.id, names);
    if (added > 0) {
      audit.log({ actorId: req.user!.id, action: 'admin.model.pull', targetType: 'provider', targetId: provider.id, detail: { added, offered: names.length }, ip: req.ip });
    }
    return { added, offered: names, models: modelsRepo.list() };
  });
}

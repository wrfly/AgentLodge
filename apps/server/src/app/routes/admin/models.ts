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
      models: modelsRepo.listVisible(),
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
   * Ask one upstream, or every upstream that can answer a list, and add whatever is missing.
   *
   * No `providerId` means all of them, in parallel: the console's one button, rather than
   * a button per row. Mock and local-agent have no list and are skipped. A failure on one
   * does not stop the others — the body names which, and the list is whatever did land.
   *
   * The asking is forwarded to the gateway, which is where the credential can be used.
   * Only additions: a model turned off stays off, and an order somebody set stays as it is.
   */
  app.post('/api/admin/models/pull', guard, async (req, reply) => {
    const { providerId } = (req.body ?? {}) as { providerId?: string };
    const skip = new Set<providersRepo.ProviderKind>(['mock', 'local-agent']);
    const targets = providerId
      ? [providersRepo.findById(providerId)].filter((p): p is providersRepo.Provider => Boolean(p))
      : providersRepo.list().filter((p) => !skip.has(p.kind));
    if (providerId && targets.length === 0) {
      return reply.code(400).send({ error: tr(req, 'No such provider') });
    }
    if (targets.length === 0) {
      return reply.code(400).send({ error: tr(req, 'No upstream that answers a model list') });
    }

    const pulled = await Promise.all(targets.map((provider) => pullProvider(provider, req)));
    const added = pulled.reduce((n, p) => n + p.added, 0);
    /*
     * A named provider that failed used to 400 the whole call. Keep that when the
     * administrator asked for one: they are staring at that upstream. Asking for all
     * of them must not.
     */
    if (providerId && pulled[0]?.error) {
      return reply.code(400).send({ error: pulled[0].error });
    }
    return {
      added,
      models: modelsRepo.listVisible(),
      providers: pulled,
      ...(providerId ? { offered: pulled[0]?.offered ?? [] } : {}),
    };
  });
}

/** Cursor's catalogue can take longer than the gate's five-second bound */
const PULL_TIMEOUT_MS = 20_000;

async function pullProvider(
  provider: providersRepo.Provider,
  req: { user?: { id: string }; ip: string; headers: { authorization?: string } },
): Promise<{ id: string; name: string; added: number; offered: string[]; error?: string }> {
  const res = await callGateway(
    'GET',
    `/models?provider=${encodeURIComponent(provider.id)}`,
    req.headers.authorization,
    undefined,
    PULL_TIMEOUT_MS,
  );
  if (typeof res['error'] === 'string') {
    return { id: provider.id, name: provider.name, added: 0, offered: [], error: res['error'] };
  }
  const names = Array.isArray(res['models']) ? (res['models'] as string[]) : [];
  const added = modelsRepo.addMissing(provider.id, names);
  const collapsed = modelsRepo.collapseVariantRows(provider.id);
  if (added > 0 || collapsed > 0) {
    audit.log({
      actorId: req.user!.id,
      action: 'admin.model.pull',
      targetType: 'provider',
      targetId: provider.id,
      detail: { added, collapsed, offered: names.length },
      ip: req.ip,
    });
  }
  return { id: provider.id, name: provider.name, added, offered: names };
}

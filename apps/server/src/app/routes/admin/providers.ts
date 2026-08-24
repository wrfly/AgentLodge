/** The upstream provider registry: create, edit, remove, switch */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import * as providersRepo from '../../../core/db/providers.js';
import { allowlistProblem, auditProxyProblem } from '../../../core/egress.js';
import { getBool } from '../../../core/db/settings.js';
import { callGateway, credentialIds, guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/providers', guard, async (req) => {
    const rows = providersRepo.list();
    // Which credentials the credential manager still has. A provider naming one that was
    // deleted is configured and unusable at the same time, and without this the console
    // shows the name and nothing else — the failure surfaces only as a refused request.
    // undefined means the question could not be asked, which is not the same as "it is
    // gone" and must not be drawn as one.
    const known = await credentialIds(req.headers.authorization);
    return {
      providers: rows.map((p) => ({
        ...p,
        credentialMissing: p.credentialId && known ? !known.has(p.credentialId) : undefined,
      })),
      kinds: providersRepo.KIND_LABEL,
      /**
       * The hourly refresh switch, which the console draws at the foot of this card.
       * It rides along here because listSettings() leaves hidden settings out, and because
       * the card is already asking — one request instead of two for one boolean.
       */
      autoRefreshModels: getBool('agents.autoRefreshModels'),
    };
  });

  app.post('/api/admin/providers', guard, async (req, reply) => {
    const b = (req.body ?? {}) as providersRepo.UpsertInput;
    if (!b.name?.trim()) return reply.code(400).send({ error: tr(req, 'Missing name') });
    if (!providersRepo.KIND_LABEL[b.kind]) return reply.code(400).send({ error: tr(req, 'Unknown kind') });
    const p = providersRepo.create(b);
    audit.log({ actorId: req.user!.id, action: 'admin.provider.create', targetType: 'provider', targetId: p.id, detail: { name: p.name, kind: p.kind }, ip: req.ip });
    return p;
  });

  app.patch('/api/admin/providers/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = providersRepo.findById(id);
    if (!cur) return reply.code(404).send({ error: tr(req, 'No such provider') });

    const b = (req.body ?? {}) as providersRepo.UpsertInput;

    // An upstream that would reach the network with no audit proxy is refused here,
    // because there is no later moment to refuse it: every provider with a model pointed
    // at it is live, so saving one is the same act that puts it in the path.
    const problem = auditProxyProblem({ kind: b.kind ?? cur.kind, baseUrl: b.baseUrl ?? cur.baseUrl });
    if (problem) return reply.code(400).send({ error: problem });

    const denied = await allowlistProblem(b.baseUrl ?? cur.baseUrl);
    if (denied) return reply.code(400).send({ error: denied });

    const p = providersRepo.update(id, b);
    if (!p) return reply.code(404).send({ error: tr(req, 'No such provider') });
    audit.log({ actorId: req.user!.id, action: 'admin.provider.update', targetType: 'provider', targetId: id, ip: req.ip });
    return p;
  });

  app.delete('/api/admin/providers/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    // Deleting takes its models with it (on delete cascade), which is what the console
    // warns about — an upstream nothing points at is safe to remove, one with models is
    // not the same act
    if (!providersRepo.remove(id)) return reply.code(404).send({ error: tr(req, 'No such provider') });
    audit.log({ actorId: req.user!.id, action: 'admin.provider.delete', targetType: 'provider', targetId: id, ip: req.ip });
    return { ok: true };
  });

  /**
   * Ask this upstream what models it has.
   *
   * Forwarded rather than fetched here: the real key only exists in the gateway process, so
   * app cannot make this call itself — the same reason gate status is forwarded.
   */
  app.get('/api/admin/providers/:id/models', guard, async (req) => {
    const { id } = req.params as { id: string };
    return callGateway('GET', `/models?provider=${encodeURIComponent(id)}`, req.headers.authorization);
  });
}

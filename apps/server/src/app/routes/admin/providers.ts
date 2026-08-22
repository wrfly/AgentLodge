/** The upstream provider registry: create, edit, remove, switch */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import * as providersRepo from '../../../core/db/providers.js';
import { allowlistProblem, auditProxyProblem } from '../../../core/egress.js';
import { inspect } from '../../../core/secret-file.js';
import { guard, keyFileStatuses } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

/**
 * When a key is a file reference, look at the path before saving.
 *
 * Only `code === 'path'` is refused — not absolute, not in the allowlist — because that is
 * wrong on any machine. "Missing" and "no permission" are not refused: the gateway is what
 * reads the key, app is free not to mount that volume, and one fewer process able to see a
 * secret is better. Those show as red text in the list, which is enough for a person to act
 * on.
 *
 * A path typed into apiKey goes through the same check, using the very looksLikePath that
 * decides where it is stored. It has to be the same function, or one side would validate it
 * as a key while the other stored it as a path.
 */
function keyFileProblem(input: { apiKey?: string; apiKeyFile?: string }): string | undefined {
  const explicit = (input.apiKeyFile ?? '').trim();
  const combined = input.apiKey ?? '';
  const p = explicit || (providersRepo.looksLikePath(combined) ? combined.trim() : '');
  if (!p) return undefined;
  const r = inspect(p);
  return 'error' in r && r.code === 'path' ? `key file: ${r.error}` : undefined;
}

export function register(app: FastifyInstance): void {

  app.get('/api/admin/providers', guard, async (req) => {
    // For providers holding a key file, fetch its current status too: "a path is configured"
    // and "that path yields a key right now" are different things and the interface shows them
    // separately. The status comes from the gateway, since the gateway is what reads it (see
    // secretFilesView in shared.ts)
    const rows = providersRepo.list();
    const status = await keyFileStatuses(rows.map((p) => p.keyFile), req.headers.authorization);
    return {
      providers: rows.map((p) => ({ ...p, keyFileStatus: p.keyFile ? status.get(p.keyFile) : undefined })),
      kinds: providersRepo.KIND_LABEL,
    };
  });

  app.post('/api/admin/providers', guard, async (req, reply) => {
    const b = (req.body ?? {}) as providersRepo.UpsertInput;
    if (!b.name?.trim()) return reply.code(400).send({ error: tr(req, 'Missing name') });
    if (!providersRepo.KIND_LABEL[b.kind]) return reply.code(400).send({ error: tr(req, 'Unknown kind') });
    const bad = keyFileProblem(b);
    if (bad) return reply.code(400).send({ error: bad });
    const p = providersRepo.create(b);
    audit.log({ actorId: req.user!.id, action: 'admin.provider.create', targetType: 'provider', targetId: p.id, detail: { name: p.name, kind: p.kind }, ip: req.ip });
    return p;
  });

  app.patch('/api/admin/providers/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const cur = providersRepo.findById(id);
    if (!cur) return reply.code(404).send({ error: tr(req, 'No such provider') });

    const b = (req.body ?? {}) as providersRepo.UpsertInput;
    const bad = keyFileProblem(b);
    if (bad) return reply.code(400).send({ error: bad });

    // The active provider cannot be edited into "reaches the network with no audit proxy" —
    // otherwise activating first and clearing the proxy afterwards walks around the check in
    // activate
    if (cur.active) {
      const problem = auditProxyProblem({
        kind: b.kind ?? cur.kind,
        baseUrl: b.baseUrl ?? cur.baseUrl,
      });
      if (problem) return reply.code(400).send({ error: problem });

      const denied = await allowlistProblem(b.baseUrl ?? cur.baseUrl);
      if (denied) return reply.code(400).send({ error: denied });
    }

    const p = providersRepo.update(id, b);
    if (!p) return reply.code(404).send({ error: tr(req, 'No such provider') });
    audit.log({ actorId: req.user!.id, action: 'admin.provider.update', targetType: 'provider', targetId: id, ip: req.ip });
    return p;
  });

  app.post('/api/admin/providers/:id/activate', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = providersRepo.findById(id);
    if (!target) return reply.code(404).send({ error: tr(req, 'No such provider') });

    // Blocked before switching, or the refusal only surfaces when a user sends a message
    const problem = auditProxyProblem(target);
    if (problem) return reply.code(400).send({ error: problem });

    // Ask again whether the proxy accepts this host: having a proxy is not the same as the
    // proxy being willing to relay
    const denied = await allowlistProblem(target.baseUrl);
    if (denied) return reply.code(400).send({ error: denied });

    const p = providersRepo.activate(id);
    if (!p) return reply.code(404).send({ error: tr(req, 'No such provider') });
    audit.log({ actorId: req.user!.id, action: 'admin.provider.activate', targetType: 'provider', targetId: id, detail: { name: p.name, kind: p.kind }, ip: req.ip });
    return p;
  });

  app.delete('/api/admin/providers/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const p = providersRepo.findById(id);
    if (p?.active) return reply.code(400).send({ error: tr(req, 'The active upstream cannot be deleted; switch to another first') });
    if (!providersRepo.remove(id)) return reply.code(404).send({ error: tr(req, 'No such provider') });
    audit.log({ actorId: req.user!.id, action: 'admin.provider.delete', targetType: 'provider', targetId: id, ip: req.ip });
    return { ok: true };
  });
}

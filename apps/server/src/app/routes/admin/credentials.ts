/**
 * Upstream credentials, as the console manages them.
 *
 * Every route here is a **forward to the gateway**, which is where the credential
 * manager's socket is mounted — the same arrangement as key files and for the same
 * reason: the process that has to send the value is the only one that needs to be able
 * to ask for it, and one fewer process able to do so is better. What crosses this file
 * is a credential's id, a label, and — once — a key somebody pasted.
 *
 * Signing a subscription in is two steps because the authorisation happens in a browser
 * that is not ours: start hands back a URL, the administrator approves there, and the
 * page shows a code to paste into finish. The refresh token that comes out of that
 * exchange never leaves the credential manager.
 */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import { callGateway, guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

/** A gateway answer carrying `error` is the operation failing, not a 200 with bad news in it */
function failed(res: Record<string, unknown>): string | undefined {
  return typeof res['error'] === 'string' ? res['error'] : undefined;
}

export function register(app: FastifyInstance): void {

  app.get('/api/admin/credentials', guard, async (req) =>
    callGateway('GET', '/credentials', req.headers.authorization),
  );

  /** What is in the directories a key file may be read from, for the picker */
  app.get('/api/admin/credentials/files', guard, async (req) => {
    const { path } = (req.query ?? {}) as { path?: string };
    return callGateway(
      'GET',
      `/credentials/files${path ? `?path=${encodeURIComponent(path)}` : ''}`,
      req.headers.authorization,
    );
  });

  app.post('/api/admin/credentials', guard, async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; label?: string; apiKey?: string };
    const res = await callGateway('POST', '/credentials', req.headers.authorization, b);
    const bad = failed(res);
    if (bad) return reply.code(400).send({ error: bad });
    // No key, and no hint of one: what is worth recording is that an administrator
    // replaced this credential, and when
    audit.log({
      actorId: req.user!.id,
      action: 'admin.credential.store',
      targetType: 'credential',
      targetId: b.id ?? '',
      detail: { kind: 'api-key' },
      ip: req.ip,
    });
    return res;
  });

  app.post('/api/admin/credentials/import', guard, async (req, reply) => {
    const b = (req.body ?? {}) as { id?: string; kind?: string; label?: string };
    const res = await callGateway('POST', '/credentials/import', req.headers.authorization, b);
    const bad = failed(res);
    if (bad) return reply.code(400).send({ error: bad });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.credential.import',
      targetType: 'credential',
      targetId: b.id ?? b.kind ?? '',
      detail: { kind: b.kind ?? 'claude' },
      ip: req.ip,
    });
    return res;
  });

  app.delete('/api/admin/credentials/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const res = await callGateway('DELETE', `/credentials?id=${encodeURIComponent(id)}`, req.headers.authorization);
    const bad = failed(res);
    if (bad) return reply.code(400).send({ error: bad });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.credential.delete',
      targetType: 'credential',
      targetId: id,
      ip: req.ip,
    });
    return res;
  });

  /**
   * Step one: where to authorise. Nothing is stored yet — an abandoned sign-in leaves
   * the credential that is there untouched.
   */
  app.post('/api/admin/credentials/login/start', guard, async (req, reply) => {
    const b = (req.body ?? {}) as { kind?: string; id?: string; label?: string };
    const res = await callGateway('POST', '/credentials/login/start', req.headers.authorization, b);
    const bad = failed(res);
    if (bad) return reply.code(400).send({ error: bad });
    return res;
  });

  /**
   * Step two: the code from the page that the redirect landed on. It is spent here — a
   * second attempt with the same one is refused, which is what an authorization code is
   * supposed to be.
   */
  app.post('/api/admin/credentials/login/finish', guard, async (req, reply) => {
    const b = (req.body ?? {}) as { loginId?: string; code?: string };
    if (!b.loginId || !b.code?.trim()) {
      return reply.code(400).send({ error: tr(req, 'Paste the code the page showed you') });
    }
    const res = await callGateway('POST', '/credentials/login/finish', req.headers.authorization, b);
    const bad = failed(res);
    if (bad) return reply.code(400).send({ error: bad });
    const credential = res['credential'] as { id?: string; kind?: string } | undefined;
    audit.log({
      actorId: req.user!.id,
      action: 'admin.credential.login',
      targetType: 'credential',
      targetId: credential?.id ?? b.loginId,
      detail: { kind: credential?.kind },
      ip: req.ip,
    });
    return res;
  });
}

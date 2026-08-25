/** System settings, and the upstream balance */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as audit from '../../../core/db/audit.js';
import { listSettings, setSetting } from '../../../core/db/settings.js';
import { fetchBalance } from '../../agents/provider.js';
import * as mail from '../../mail.js';
import { guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/settings', guard, async () => listSettings());

  app.patch('/api/admin/settings', guard, async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const changed: string[] = [];
    try {
      for (const [key, value] of Object.entries(body)) {
        if (typeof value !== 'string') continue;
        setSetting(key, value, req.user!.id);
        changed.push(key);
      }
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
    audit.log({
      actorId: req.user!.id,
      action: 'admin.settings.update',
      // Key names only, never values — some of them are secrets
      detail: { keys: changed },
      ip: req.ip,
    });
    return listSettings();
  });

  /** Clicked after saving the mail configuration, to confirm mail actually goes out */
  app.post('/api/admin/settings/test-mail', guard, async (req, reply) => {
    const body = (req.body ?? {}) as { to?: string };
    const user = usersRepo.findById(req.user!.id)!;
    const to = (body.to ?? user.email).trim();
    const result = await mail.send({
      to,
      subject: 'AgentLodge mail configuration test',
      text: 'This is a test email. Receiving it means the mail provider is configured correctly.',
      html: '<p style="font-size:14px;">This is a test email. Receiving it means the mail provider is configured correctly.</p>',
    });
    if (!result.sent) return reply.code(400).send({ error: result.error ?? tr(req, 'Sending failed') });
    return { ok: true, to };
  });

  app.get('/api/admin/balance', guard, async () => (await fetchBalance()) ?? { configured: false });
}

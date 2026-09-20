/** System settings, and the upstream balance */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as audit from '../../../core/db/audit.js';
import { listSettings, setSetting } from '../../../core/db/settings.js';
import * as mail from '../../mail.js';
import { callGateway, guard } from './shared.js';
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
    /*
     * A gateway setting is read in the gateway process, and one of them decides who waits.
     * Raising the per-user cap makes queued requests eligible without freeing a slot, and
     * the gate only looks at its queues when one is released — so without this, a raise on a
     * busy gate does nothing until the people already waiting time out.
     *
     * Best effort on purpose: the setting is saved either way, and every later admission
     * reads it fresh. This only decides whether the ones already in the queue wait for the
     * next release or go now.
     */
    if (changed.some((k) => k.startsWith('gateway.'))) {
      void callGateway('POST', '/gate/reschedule', req.headers.authorization).catch(() => {});
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

  /**
   * Prepaid remaining on Cursor / DeepSeek. Forwarded: only the gateway mounts the
   * credential manager, and asking from this process comes back empty.
   *
   * Cursor's dashboard is several RPCs, so this wait is longer than the other forwards.
   * The card loads it itself rather than blocking overview.
   */
  app.get('/api/admin/balance', guard, async (req) =>
    callGateway('GET', '/balance', req.headers.authorization, undefined, 30_000),
  );
}

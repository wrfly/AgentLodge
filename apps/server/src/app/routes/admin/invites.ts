/** Invite codes: creating, emailing, disabling */
import type { FastifyInstance } from 'fastify';
import * as usersRepo from '../../../core/db/users.js';
import * as invitesRepo from '../../../core/db/invites.js';
import * as audit from '../../../core/db/audit.js';
import { getString } from '../../../core/db/settings.js';
import * as mail from '../../mail.js';
import { guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

export function register(app: FastifyInstance): void {

  app.get('/api/admin/invites', guard, async () => invitesRepo.list());

  app.post('/api/admin/invites', guard, async (req) => {
    const body = (req.body ?? {}) as {
      count?: number;
      note?: string;
      maxUses?: number;
      expiresInDays?: number;
      presetRole?: usersRepo.Role;
      presetTokenLimit?: number | null;
    };
    const count = Math.min(Math.max(body.count ?? 1, 1), 50);
    const expiresAt = body.expiresInDays
      ? new Date(Date.now() + body.expiresInDays * 86400_000).toISOString()
      : undefined;

    const created = Array.from({ length: count }, () =>
      invitesRepo.create({
        createdBy: req.user!.id,
        note: body.note,
        maxUses: body.maxUses,
        expiresAt,
        presetRole: body.presetRole,
        presetTokenLimit: body.presetTokenLimit,
      }),
    );

    audit.log({
      actorId: req.user!.id,
      action: 'admin.invite.create',
      detail: { count, note: body.note },
      ip: req.ip,
    });
    return created;
  });

  /** An emailed invite: create a targeted code and send it */
  app.post('/api/admin/invites/email', guard, async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string;
      note?: string;
      expiresInDays?: number;
      presetRole?: usersRepo.Role;
      presetTokenLimit?: number | null;
    };
    const email = (body.email ?? '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      return reply.code(400).send({ error: tr(req, 'That is not a valid email address') });
    if (usersRepo.emailTaken(email))
      return reply.code(409).send({ error: tr(req, 'That address is already registered') });

    const expiresAt = new Date(
      Date.now() + (body.expiresInDays ?? 7) * 86400_000,
    ).toISOString();

    const invite = invitesRepo.create({
      email,
      createdBy: req.user!.id,
      note: body.note,
      maxUses: 1,
      expiresAt,
      presetRole: body.presetRole,
      presetTokenLimit: body.presetTokenLimit,
    });

    const base = getString('app.baseUrl', 'http://localhost:5173');
    const link = `${base}/register?code=${invite.code}&email=${encodeURIComponent(email)}`;
    const inviter = usersRepo.findById(req.user!.id);
    const tpl = mail.inviteMail({
      to: email,
      code: invite.code,
      link,
      inviterName: inviter?.username,
      expiresAt,
      tokenLimit: invite.presetTokenLimit,
    });
    const result = await mail.send({ to: email, ...tpl, link });
    if (result.sent) invitesRepo.markSent(invite.id);

    audit.log({
      actorId: req.user!.id,
      action: 'admin.invite.email',
      targetType: 'invite',
      targetId: invite.id,
      detail: { email, sent: result.sent, error: result.error },
      ip: req.ip,
    });

    return {
      invite,
      mail: { sent: result.sent, error: result.error },
      // When the email did not go out, hand the link to the administrator to forward
      link: result.sent ? undefined : link,
    };
  });

  app.delete('/api/admin/invites/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!invitesRepo.setDisabled(id, true))
      return reply.code(404).send({ error: tr(req, 'No such invite code') });
    audit.log({
      actorId: req.user!.id,
      action: 'admin.invite.disable',
      targetType: 'invite',
      targetId: id,
      ip: req.ip,
    });
    return { ok: true };
  });
}

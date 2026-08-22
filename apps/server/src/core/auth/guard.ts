import type { FastifyReply, FastifyRequest } from 'fastify';
import { verifyAccessToken } from './tokens.js';
import * as usersRepo from '../db/users.js';
import * as sessionsRepo from '../db/sessions.js';
import type { Role } from '../db/users.js';
import { tr } from '../i18n/locale.js';

declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string; role: Role; sessionId: string };
  }
}

function bearer(req: FastifyRequest): string | null {
  const raw = req.headers.authorization;
  if (!raw || !raw.startsWith('Bearer ')) return null;
  return raw.slice(7).trim() || null;
}

/**
 * Parse the access token onto req.user.
 *
 * Parses without blocking; blocking is requireUser/requireAdmin's job, which is what
 * lets endpoints like /api/health stay anonymous.
 */
export async function attachUser(req: FastifyRequest): Promise<void> {
  const token = bearer(req);
  if (!token) return;
  const claims = await verifyAccessToken(token);
  if (!claims) return;

  const user = usersRepo.findById(claims.sub);
  if (!user || user.status !== 'active') return;

  // An unexpired access token whose session has been revoked — logout, deactivation,
  // replay cleanup — stops working immediately
  if (!sessionsRepo.isActive(claims.sid)) return;

  sessionsRepo.touch(claims.sid);
  req.user = { id: user.id, role: user.role, sessionId: claims.sid };
}

export async function requireUser(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: tr(req, 'Not signed in') });
  }
}

export async function requireAdmin(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (!req.user) {
    await reply.code(401).send({ error: tr(req, 'Not signed in') });
    return;
  }
  if (req.user.role !== 'admin') {
    await reply.code(403).send({ error: tr(req, 'Administrator access required') });
  }
}

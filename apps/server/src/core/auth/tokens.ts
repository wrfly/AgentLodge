import crypto from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { config } from '../config.js';
import type { Role } from '../db/users.js';

const secret = new TextEncoder().encode(config.jwtSecret);
const ISSUER = 'AgentLodge';

export interface AccessClaims {
  sub: string;
  role: Role;
  sid: string;
}

export async function signAccessToken(claims: AccessClaims): Promise<string> {
  return new SignJWT({ role: claims.role, sid: claims.sid })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.sub)
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime(`${Math.floor(config.accessTokenTtlMs / 1000)}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret, { issuer: ISSUER });
    if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') return null;
    return { sub: payload.sub, role: payload.role as Role, sid: payload.sid };
  } catch {
    return null;
  }
}

/**
 * A single-use ticket for SSE.
 *
 * EventSource cannot send an Authorization header, so the access token is exchanged for
 * a short-lived ticket that travels in the query string. It is spent on use and bound to
 * the user, so a leaked one cannot be replayed.
 */
interface Ticket {
  userId: string;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();

export function issueStreamTicket(userId: string): string {
  const token = crypto.randomBytes(24).toString('base64url');
  tickets.set(token, { userId, expiresAt: Date.now() + config.streamTicketTtlMs });
  return token;
}

export function consumeStreamTicket(token: string): string | null {
  const t = tickets.get(token);
  if (!t) return null;
  tickets.delete(token);
  if (t.expiresAt < Date.now()) return null;
  return t.userId;
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of tickets) if (v.expiresAt < now) tickets.delete(k);
}, 60_000).unref();

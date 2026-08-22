import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';

function eq(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** A caller may carry the token in any of three headers, covering Claude Code, Codex, and general clients */
export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers;
  const gw = h['x-gateway-token'];
  if (typeof gw === 'string' && gw) return gw;
  const key = h['x-api-key'];
  if (typeof key === 'string' && key) return key;
  const auth = h.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

export async function requireGatewayToken(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  if (config.tokens.length === 0) return;
  const provided = extractToken(req);
  if (!provided || !config.tokens.some((t) => eq(t, provided))) {
    await reply.code(401).send({ error: { message: 'Missing or invalid gateway token' } });
  }
}

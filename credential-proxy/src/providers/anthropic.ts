import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forward } from '../proxy.js';
import type { AutherClient } from '../auther.js';

/**
 * Anthropic: inject the host's Claude subscription OAuth, and forward everything else as-is.
 *
 * The access token comes from the auther sidecar over a Unix socket — the
 * gateway itself holds no refresh token and cannot leak one. A 401 forces a
 * single refresh via the auther and retries once.
 */
export async function forwardAnthropic(
  req: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | null,
  auther: AutherClient,
): Promise<void> {
  let token: string;
  try {
    token = (await auther.token('claude')).accessToken;
  } catch (e) {
    await reply.code(503).send({ error: { message: (e as Error).message } });
    return;
  }

  const url = new URL(req.url, config.anthropicUpstream);
  await forward(req, reply, {
    provider: 'anthropic',
    upstreamUrl: new URL(url.pathname + url.search, config.anthropicUpstream).toString(),
    authHeaders: {
      authorization: `Bearer ${token}`,
      // Supply a default when the caller omits anthropic-version, rather than take a 400 upstream
      'anthropic-version': (req.headers['anthropic-version'] as string) ?? '2023-06-01',
    },
    onUnauthorized: async () => ({
      authorization: `Bearer ${(await auther.refresh('claude')).accessToken}`,
    }),
    body,
  });
}

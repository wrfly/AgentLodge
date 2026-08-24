import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forward } from '../proxy.js';
import type { CredentialManagerClient } from '../credential-manager.js';

/**
 * Anthropic: inject the host's Claude subscription OAuth, and forward everything else as-is.
 *
 * The access token comes from the credential manager over a Unix socket — the
 * gateway itself holds no refresh token and cannot leak one. A 401 forces a
 * single refresh via the credential manager and retries once.
 */
export async function forwardAnthropic(
  req: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | null,
  credentialManager: CredentialManagerClient,
): Promise<void> {
  let token: string;
  try {
    token = (await credentialManager.token('claude')).accessToken;
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
      authorization: `Bearer ${(await credentialManager.refresh('claude')).accessToken}`,
    }),
    body,
  });
}

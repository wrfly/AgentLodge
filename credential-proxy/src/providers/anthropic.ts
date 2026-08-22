import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forward } from '../proxy.js';
import type { ClaudeCredentialStore } from '../credentials/claude.js';

/**
 * Anthropic: inject the host's Claude subscription OAuth, and forward everything else as-is.
 *
 *
 * Deliberately not done: rewriting the caller's system prompt, injecting a "You are Claude
 * Code" preamble, forging x-anthropic-billing-header, or overriding identity headers like
 * anthropic-beta and x-app. When real Claude Code runs in the container it sends those
 * itself and passing them through is the whole job. Dressing third-party traffic up as the
 * official CLI to change how it is billed is not this gateway's business.
 */
export async function forwardAnthropic(
  req: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | null,
  store: ClaudeCredentialStore,
): Promise<void> {
  let token: string;
  try {
    token = await store.getAccessToken();
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
      authorization: `Bearer ${await store.getAccessToken(true)}`,
    }),
    body,
  });
}

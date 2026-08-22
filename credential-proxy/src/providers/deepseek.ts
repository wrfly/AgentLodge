import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forward } from '../proxy.js';

/**
 * DeepSeek: passed straight through with your own API key.
 *
 * The point is that the key exists only in the gateway. Callers — including codex inside a
 * container — need nothing but GATEWAY_TOKEN, and no sk-... ever reaches
 * ~/.codex/config.toml.
 */
export async function forwardDeepseek(
  req: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | null,
): Promise<void> {
  if (!config.deepseekApiKey) {
    await reply.code(503).send({
      error: { message: 'DEEPSEEK_API_KEY is not configured, so the gateway cannot authenticate for you' },
    });
    return;
  }
  const url = new URL(req.url, config.deepseekUpstream);
  await forward(req, reply, {
    provider: 'deepseek',
    upstreamUrl: new URL(url.pathname + url.search, config.deepseekUpstream).toString(),
    authHeaders: {
      authorization: `Bearer ${config.deepseekApiKey}`,
      'content-type': 'application/json',
    },
    body,
  });
}

import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forward } from '../proxy.js';
import type { CodexCredentialStore } from '../credentials/codex.js';

/**
 * Codex Responses: inject the host's ChatGPT subscription OAuth.
 *
 * Authentication injection and nothing else, same as the others: callers go upstream as
 * whoever they already were.
 */
export async function forwardCodex(
  req: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | null,
  store: CodexCredentialStore,
): Promise<void> {
  let creds;
  try {
    creds = await store.get();
  } catch (e) {
    await reply.code(503).send({ error: { message: (e as Error).message } });
    return;
  }

  const url = new URL(req.url, config.codexUpstream);
  const base = config.codexUpstream.replace(/\/$/, '');
  // /v1/responses → <upstream>/responses
  const suffix = url.pathname.replace(/^\/v1/, '');

  const auth = (c: { accessToken: string; accountId: string | null }): Record<string, string> => {
    const h: Record<string, string> = {
      authorization: `Bearer ${c.accessToken}`,
      'content-type': 'application/json',
    };
    if (c.accountId) h['chatgpt-account-id'] = c.accountId;
    return h;
  };

  await forward(req, reply, {
    provider: 'codex',
    upstreamUrl: base + suffix + url.search,
    authHeaders: auth(creds),
    onUnauthorized: async () => auth(await store.get(true)),
    body,
  });
}

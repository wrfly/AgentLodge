import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { forward } from '../proxy.js';
import type { CredentialManagerClient, InjectedToken } from '../credential-manager.js';

/**
 * Codex Responses: inject the host's ChatGPT subscription OAuth.
 *
 * The access token comes from the credential manager; the gateway holds no
 * refresh token. A 401 forces a single refresh and retries once.
 */
export async function forwardCodex(
  req: FastifyRequest,
  reply: FastifyReply,
  body: Buffer | null,
  credentialManager: CredentialManagerClient,
): Promise<void> {
  let creds: InjectedToken;
  try {
    creds = await credentialManager.token('codex');
  } catch (e) {
    await reply.code(503).send({ error: { message: (e as Error).message } });
    return;
  }

  const url = new URL(req.url, config.codexUpstream);
  const base = config.codexUpstream.replace(/\/$/, '');
  // /v1/responses → <upstream>/responses
  const suffix = url.pathname.replace(/^\/v1/, '');

  const auth = (c: InjectedToken): Record<string, string> => {
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
    onUnauthorized: async () => auth(await credentialManager.refresh('codex')),
    body,
  });
}

import http from 'node:http';
import { config } from './config.js';

/**
 * Client for the auther service, which is the only process that holds
 * upstream subscription refresh tokens. The gateway calls it over a Unix
 * domain socket and receives back only a short-lived access token — it never
 * sees (or can leak) a refresh token.
 *
 * Endpoints (see the auther in authkey-sync/):
 *   GET  /token?provider=claude|codex   -> { provider, accessToken, expiresAt, accountId? }
 *   POST /token/refresh { provider }    -> same shape, forces a refresh
 */

export interface InjectedToken {
  accessToken: string;
  expiresAt?: number;
  accountId?: string;
}

function request(path: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        socketPath: config.autherSocket,
        path,
        method,
        headers: {
          ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}),
        },
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error((parsed['error'] as string) ?? `auther returned ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`auther returned invalid JSON: ${(e as Error).message}`));
          }
        });
      },
    );
    req.on('error', (e) => reject(new Error(`auther unreachable at ${config.autherSocket}: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export class AutherClient {
  /** Fetch a (cached) access token; the auther refreshes lazily if expired. */
  async token(provider: 'claude' | 'codex'): Promise<InjectedToken> {
    const body = await request(`/token?provider=${provider}`, 'GET');
    return {
      accessToken: body['accessToken'] as string,
      expiresAt: body['expiresAt'] as number | undefined,
      accountId: body['accountId'] as string | undefined,
    };
  }

  /** Force a refresh and return the fresh token (used on a 401). */
  async refresh(provider: 'claude' | 'codex'): Promise<InjectedToken> {
    const body = await request('/token/refresh', 'POST', { provider });
    return {
      accessToken: body['accessToken'] as string,
      expiresAt: body['expiresAt'] as number | undefined,
      accountId: body['accountId'] as string | undefined,
    };
  }

  /** Per-provider health snapshot for the gateway's own /ready endpoint. */
  async status(provider: 'claude' | 'codex'): Promise<Record<string, unknown>> {
    try {
      const body = await request('/health', 'GET');
      const providers = (body['providers'] ?? {}) as Record<string, Record<string, unknown>>;
      const entry = providers[provider];
      if (!entry) return { provider, ok: false, error: 'no status from auther' };
      return {
        provider,
        ok: entry['ok'] === true,
        ...(entry['expiresAt'] !== undefined && entry['expiresAt'] !== 0 ? { expiresAt: entry['expiresAt'] } : {}),
      };
    } catch (e) {
      return { provider, ok: false, error: (e as Error).message };
    }
  }
}

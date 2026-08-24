import http from 'node:http';
import { config } from './config.js';

/**
 * Client for the credential-manager service, which is the only process that holds
 * upstream subscription refresh tokens. The gateway calls it over a Unix
 * domain socket and receives back only a short-lived access token — it never
 * sees (or can leak) a refresh token.
 *
 * Endpoints (see the service in credential-manager/):
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
        socketPath: config.credentialManagerSocket,
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
              reject(new Error((parsed['error'] as string) ?? `credential-manager returned ${res.statusCode}`));
              return;
            }
            resolve(parsed);
          } catch (e) {
            reject(new Error(`credential-manager returned invalid JSON: ${(e as Error).message}`));
          }
        });
      },
    );
    req.on('error', (e) => reject(new Error(`credential-manager unreachable at ${config.credentialManagerSocket}: ${e.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

export class CredentialManagerClient {
  /** Fetch a (cached) access token; the credential manager refreshes lazily if expired. */
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

  /**
   * Per-credential health snapshot for the gateway's own /ready endpoint.
   *
   * The credential holding a subscription is named after it — `claude`, `codex` — so the
   * provider this gateway is asking about is also the id to look up.
   */
  async status(provider: 'claude' | 'codex'): Promise<Record<string, unknown>> {
    try {
      const body = await request('/health', 'GET');
      const credentials = (body['credentials'] ?? {}) as Record<string, Record<string, unknown>>;
      const entry = credentials[provider];
      if (!entry) return { provider, ok: false, error: 'no status from the credential manager' };
      return {
        provider,
        ok: entry['ready'] === true,
        ...(entry['expiresAt'] !== undefined && entry['expiresAt'] !== 0 ? { expiresAt: entry['expiresAt'] } : {}),
      };
    } catch (e) {
      return { provider, ok: false, error: (e as Error).message };
    }
  }
}

import http from 'node:http';
import { config } from './config.js';

/**
 * Talking to the credential manager.
 *
 * It is the one process holding upstream credentials — pasted API keys, and the refresh
 * tokens behind Claude / Codex subscriptions. What crosses this socket in the outbound
 * direction is a credential **id**; what comes back is either metadata for the console or
 * an access token with hours to live. A refresh token never does, which is the reason the
 * service exists: this database, and any browser session that can read it back, are then
 * not places a subscription can leak from.
 *
 * Reached over a Unix socket rather than a port. There is no authentication on it and none
 * is needed — it is not on any network, and only the containers it is mounted into can
 * open it (see docker/compose.yml, where it is 0600 owned by the uid app and gateway run
 * as).
 */

export interface CredentialSummary {
  id: string;
  kind: 'api-key' | 'claude' | 'codex' | string;
  label?: string;
  /** host-file | typed | login | import — where the value came from */
  source: string;
  /** Enough of the value to recognise it by; never enough to use */
  hint: string;
  /** Whether it currently holds something usable */
  ready: boolean;
  expiresAt?: number;
  refreshTokenExpiresAt?: number;
  /** False for a subscription that can serve its current token and nothing after it */
  renewable?: boolean;
  scopes?: string[];
  accountId?: string;
}

/**
 * Whether the manager's own store is durable right now.
 *
 * `ok: false` means the last change reached memory but not disk: the credential
 * works, is listed, mints tokens — and a restart comes back without it. That is
 * a property of the store rather than of any one operation, which is why it
 * rides along with the list instead of turning a delete or a sign-in into a
 * failure. Those are irreversible the moment they happen; refusing them after
 * the fact only asks for a retry that cannot help.
 */
export interface StoreState {
  ok: boolean;
  /** Why the store cannot be written. Shown verbatim. */
  error?: string;
}

export interface StartedLogin {
  loginId: string;
  /** Where the administrator authorises. The code shown afterwards completes it. */
  authorizeUrl: string;
  credentialId: string;
  kind: string;
  expiresAt: number;
}

/** Whether a credential manager is configured at all. */
export function isConfigured(): boolean {
  return config.credentialManagerSocket !== '';
}

class CredentialManagerError extends Error {}

/**
 * One request over the socket.
 *
 * The timeout is short on purpose: everything here is either local or a single call to a
 * token endpoint, and a gateway request waiting on it has a user's request waiting behind
 * that.
 */
function request<T>(path: string, method: 'GET' | 'POST' | 'DELETE', body?: unknown): Promise<T> {
  const socketPath = config.credentialManagerSocket;
  if (!socketPath) {
    return Promise.reject(new CredentialManagerError('No credential manager is configured'));
  }
  const payload = body === undefined ? null : JSON.stringify(body);

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path,
        method,
        timeout: 15_000,
        headers: payload
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) }
          : {},
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (data += chunk));
        res.on('end', () => {
          let parsed: Record<string, unknown> = {};
          try {
            parsed = JSON.parse(data) as Record<string, unknown>;
          } catch {
            reject(new CredentialManagerError(`Unreadable answer from the credential manager: ${data.slice(0, 200)}`));
            return;
          }
          if ((res.statusCode ?? 500) >= 400) {
            reject(new CredentialManagerError(String(parsed['error'] ?? `credential manager returned ${res.statusCode}`)));
            return;
          }
          resolve(parsed as T);
        });
      },
    );
    req.on('timeout', () => req.destroy(new CredentialManagerError('The credential manager did not answer in time')));
    req.on('error', (e) =>
      reject(
        e instanceof CredentialManagerError
          ? e
          : new CredentialManagerError(`The credential manager is unreachable at ${socketPath}: ${e.message}`),
      ),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

export async function list(): Promise<{ credentials: CredentialSummary[]; store?: StoreState }> {
  const body = await request<{ credentials?: CredentialSummary[]; store?: StoreState }>('/credentials', 'GET');
  return { credentials: body.credentials ?? [], store: body.store };
}

/** Store a key somebody pasted. The only kind that can be given as a value. */
export async function storeApiKey(input: { id: string; label?: string; apiKey: string }): Promise<CredentialSummary> {
  const body = await request<{ credential: CredentialSummary }>('/credentials', 'POST', {
    id: input.id,
    kind: 'api-key',
    label: input.label ?? '',
    apiKey: input.apiKey,
  });
  return body.credential;
}

/** Copy a credentials file the manager has mounted (the host's `claude login` output). */
export async function importFromHost(input: { id: string; kind: string; label?: string }): Promise<CredentialSummary> {
  const body = await request<{ credential: CredentialSummary }>('/credentials/import', 'POST', {
    id: input.id,
    kind: input.kind,
    label: input.label ?? '',
  });
  return body.credential;
}

/**
 * Store a path to a file another process writes.
 *
 * The value never crosses this socket in either direction: the credential manager reads
 * that file itself, each time it is asked for a token, so a rotation by whatever writes
 * it takes effect on the next request.
 */
export async function storeKeyFile(input: { id: string; label?: string; path: string }): Promise<CredentialSummary> {
  const body = await request<{ credential: CredentialSummary }>('/credentials', 'POST', {
    id: input.id,
    kind: 'key-file',
    label: input.label ?? '',
    path: input.path,
  });
  return body.credential;
}

export interface KeyFileListing {
  roots: Array<{ path: string; exists: boolean; note?: string }>;
  files: Array<{ path: string; usable: boolean; error?: string; hint?: string; fingerprint?: string; size?: number; mtime?: string }>;
  /** Present when a path was named: what that one path yields right now */
  checked?: { path: string; usable: boolean; error?: string; hint?: string; fingerprint?: string; size?: number; mtime?: string };
}

/** What is in the directories the credential manager may read a key from */
export async function files(path?: string): Promise<KeyFileListing> {
  return request<KeyFileListing>(`/files${path ? `?path=${encodeURIComponent(path)}` : ''}`, 'GET');
}

export async function remove(id: string): Promise<void> {
  await request<{ removed: string }>(`/credentials?id=${encodeURIComponent(id)}`, 'DELETE');
}

export async function startLogin(input: { kind: string; id: string; label?: string }): Promise<StartedLogin> {
  return request<StartedLogin>('/login/start', 'POST', {
    kind: input.kind,
    id: input.id,
    label: input.label ?? '',
  });
}

export async function finishLogin(input: { loginId: string; code: string }): Promise<CredentialSummary> {
  const body = await request<{ credential: CredentialSummary }>('/login/finish', 'POST', input);
  return body.credential;
}

/**
 * The value to send upstream for a credential, minted if the current one is close to
 * expiry. undefined when there is nothing usable — the caller then behaves exactly as it
 * does for a provider with no key at all.
 */
export async function tokenFor(id: string, opts: { force?: boolean } = {}): Promise<string | undefined> {
  try {
    const body = opts.force
      ? await request<{ accessToken?: string }>('/token/refresh', 'POST', { credential: id })
      : await request<{ accessToken?: string }>(`/token?credential=${encodeURIComponent(id)}`, 'GET');
    return body.accessToken || undefined;
  } catch (e) {
    // All the caller sees is "no key", which is not enough to debug from, so say why here
    console.error(`[credentials] ${id}: ${(e as Error).message}`);
    return undefined;
  }
}

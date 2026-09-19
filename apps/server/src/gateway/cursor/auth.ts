/**
 * Turning the credential an administrator pasted into the token Cursor's RPCs want.
 *
 * Cursor has two kinds of secret and they are not interchangeable:
 *
 *   an API key       `Authorization: Bearer <key>` against /auth/exchange_user_api_key,
 *                    which answers with an access token — this is what a person can
 *                    create, revoke and paste
 *   an access token  a JWT with hours on it, which is what every RPC actually accepts
 *
 * So the key is exchanged here and the result is held until it expires. Either can be
 * configured: a value that already looks like a JWT is used as it stands, for a deployment
 * that would rather mint tokens its own way.
 */

interface Exchanged {
  token: string;
  /** Epoch ms, from the token's own `exp` where it has one */
  expiresAt: number;
}

/** Keyed by the credential, so two providers on two accounts do not share one token */
const cache = new Map<string, Exchanged>();

/** Re-exchange this long before the token expires, so a long turn does not start on a dying one */
const EARLY_MS = 5 * 60_000;

/** What to assume when the token says nothing about its own lifetime */
const DEFAULT_TTL_MS = 30 * 60_000;

/** A JWT, near enough: three dot-separated base64url segments */
function looksLikeToken(secret: string): boolean {
  return /^ey[\w-]*\.[\w-]+\.[\w-]*$/.test(secret);
}

/** When this token expires, from its own claim; undefined when it does not carry one */
function expiryOf(token: string): number | undefined {
  const payload = token.split('.')[1];
  if (!payload) return undefined;
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { exp?: unknown };
    return typeof json.exp === 'number' ? json.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

export class CursorAuthError extends Error {}

/**
 * The access token for this credential.
 *
 * `force` throws away what is cached first, which is what a 401 means: the token we just
 * used was refused, and asking again with the same one would only be refused again.
 */
export async function accessToken(
  secret: string,
  baseUrl: string,
  opts: { force?: boolean; signal?: AbortSignal } = {},
): Promise<string> {
  if (!secret) throw new CursorAuthError('This upstream has no Cursor credential configured');
  if (looksLikeToken(secret)) return secret;

  const hit = cache.get(secret);
  if (!opts.force && hit && hit.expiresAt - EARLY_MS > Date.now()) return hit.token;
  cache.delete(secret);

  const url = `${baseUrl.replace(/\/+$/, '')}/auth/exchange_user_api_key`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: '{}',
      signal: opts.signal ?? AbortSignal.timeout(15_000),
    });
  } catch (e) {
    throw new CursorAuthError(`Cursor would not answer the key exchange (${(e as Error).message})`);
  }

  if (!res.ok) {
    // The status is the useful half: 401 and 403 are "this key is not valid any more",
    // which is an administrator's problem and not a transient upstream fault
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new CursorAuthError(
      `Cursor refused the API key (HTTP ${res.status}${detail ? `: ${detail}` : ''})`,
    );
  }

  const body = (await res.json().catch(() => ({}))) as { accessToken?: unknown };
  if (typeof body.accessToken !== 'string' || !body.accessToken) {
    throw new CursorAuthError('The key exchange answered without an access token');
  }

  cache.set(secret, {
    token: body.accessToken,
    expiresAt: expiryOf(body.accessToken) ?? Date.now() + DEFAULT_TTL_MS,
  });
  return body.accessToken;
}

/** For tests, and for a console that has just had its credential changed under it */
export function forget(secret?: string): void {
  if (secret) cache.delete(secret);
  else cache.clear();
}

import * as apiKeys from './db/api-keys.js';
import { PREFIX as API_KEY_PREFIX } from './db/api-keys.js';
import { verifyRuntimeToken } from './runtime-token.js';
import type { AgentId } from './protocol.js';

/**
 * The metering gateway accepts two kinds of credential; this resolves both into one
 * Principal.
 *
 * | | who uses it | lifetime | bound to | where tools run |
 * |---|---|---|---|---|
 * | **runtime token** | our agent containers | 20 minutes | (user, conversation, turn) | in the container |
 * | **api key** | a user's own claude / codex | long-lived, revocable | the user only | **on the user's machine** |
 *
 * Past this point the gateway treats them identically: quota, the concurrency gate,
 * accounting and traces are all the same code. The only difference is that `cid`/`tid`
 * are empty, and without a conversation there is nowhere to push SSE events (see settle
 * in gateway/index.ts).
 *
 * It lives in core because issuing happens in app — a ticket when a turn starts, a key
 * the user creates on the settings page — and verification happens in the gateway. It is
 * a contract between the two layers, the same reason runtime-token is here.
 */

export type CredentialKind = 'runtime' | 'api-key';

export interface Principal {
  /** userId */
  sub: string;
  /** Conversation id. Empty on the api-key path. */
  cid: string;
  /** Turn id. Empty on the api-key path. */
  tid: string;
  agent: AgentId;
  kind: CredentialKind;
  /** Whether this caller wants the agent's thinking; see RuntimeClaims. */
  thinking: boolean;
  /** api-key only: attributes usage to a key and refreshes last_used */
  apiKeyId?: string;
}

/**
 * Pull the credential out of the request headers.
 *
 * The two CLIs use different headers, so both are accepted:
 *   `ANTHROPIC_AUTH_TOKEN` / `OPENAI_API_KEY` → `Authorization: Bearer xxx`
 *   `ANTHROPIC_API_KEY`                       → `x-api-key: xxx`
 */
export function tokenFromHeaders(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  const auth = headers.authorization;
  const bearer = typeof auth === 'string' && auth.startsWith('Bearer ')
    ? auth.slice(7).trim()
    : undefined;
  if (bearer) return bearer;

  const xApiKey = headers['x-api-key'];
  const raw = Array.isArray(xApiKey) ? xApiKey[0] : xApiKey;
  return raw?.trim() || undefined;
}

/**
 * A credential can also ride in the URL path: `/u/<credential>/v1/messages`.
 *
 * Why this exists: the moment Claude Code sees `ANTHROPIC_AUTH_TOKEN` or
 * `ANTHROPIC_API_KEY` it decides there is another auth source and stops using the
 * claude.ai login, which takes the account's connectors and `/usage` with it. (Measured:
 * `claude auth status` reports authMethod flipping from `claude.ai` to `oauth_token`.)
 * Setting **only `ANTHROPIC_BASE_URL` is not an auth source** and leaves the login alone.
 *
 * So the credential moves into the base URL's path and the user sets one variable:
 *
 *   export ANTHROPIC_BASE_URL=https://<gateway>/u/al_xxxx
 *
 * The CLI **concatenates** the base URL with `/v1/messages?beta=true`, so a path prefix
 * survives intact — measured. The query position cannot be used: the CLI appends
 * `?beta=true` there itself, and a query in the base URL pushes the path into it as a
 * value and encodes the lot. Userinfo (`https://key@host`) does not work either; the CLI
 * issues no request at all.
 *
 * The cost is plain: **the credential is in a URL**, which leaks more readily than a
 * header — reverse-proxy access logs, shell history, error messages, `--verbose` output
 * can all carry it. That is why the prefix is stripped **before** routing (the gateway's
 * rewriteUrl), so the framework's own request logging only ever sees a clean URL.
 *
 * What goes in the path is the segment **with the `al_` prefix removed**, leaving a run
 * of base64url that reads as a random slug rather than a key. This is **obfuscation, not
 * protection**: whoever has the URL can use it. It buys exactly one thing — a URL
 * glanced at or landing in a log does not announce itself as a credential, and a generic
 * secret scanner does not match on `al_`.
 *
 * And that property is exactly what is given up: the `al_` prefix exists **on purpose**
 * so a leaked key is recognisable to scanners and to people (see db/api-keys.ts). On the
 * URL path we trade that away deliberately. Everywhere else the key appears — headers,
 * the interface, the string a user copies — it still carries the prefix.
 */
export const PATH_CREDENTIAL_PREFIX = '/u/';

/** Restore a path segment to a full credential: put `al_` back, but leave an already-complete one and anything JWT-shaped alone */
function restoreKey(segment: string): string {
  if (segment.startsWith(API_KEY_PREFIX)) return segment; // somebody pasted the whole key
  if (segment.includes('.')) return segment; // JWT-shaped: hand it on untouched to be verified
  return API_KEY_PREFIX + segment;
}

export function splitPathCredential(url: string): { token?: string; rest: string } {
  if (!url.startsWith(PATH_CREDENTIAL_PREFIX)) return { rest: url };
  const after = url.slice(PATH_CREDENTIAL_PREFIX.length);
  const slash = after.indexOf('/');
  // `/u/xxx` has to be followed by a real path. A request with a credential and no path
  // is not accepted: stripping it to the empty string would land it on the root route,
  // and that error is harder to trace than a 404
  if (slash <= 0) return { rest: url };

  let token: string;
  try {
    token = decodeURIComponent(after.slice(0, slash));
  } catch {
    return { rest: url }; // broken encoding: leave it as an ordinary path and let routing 404
  }
  return token ? { token: restoreKey(token), rest: after.slice(slash) } : { rest: url };
}

/**
 * Plaintext to Principal, or null when it is neither.
 *
 * The order matters: an api key has a fixed prefix, so branching on it first sends each
 * kind down one path only — no database lookup for a runtime token, no wasted JWT
 * verification for an api key.
 *
 * `wire` infers the agent on the api-key path: a request to /v1/messages is claude, one
 * to /v1/responses or /chat/completions is codex. It only affects how usage is
 * categorised.
 */
export async function resolve(
  token: string | undefined,
  wire: 'anthropic' | 'chat' | 'responses',
): Promise<Principal | null> {
  if (!token) return null;

  const key = apiKeys.verify(token);
  if (key) {
    apiKeys.touch(key.id);
    return {
      sub: key.userId,
      cid: '',
      tid: '',
      agent: wire === 'anthropic' ? 'claude' : 'codex',
      kind: 'api-key',
      // Somebody's own CLI has no conversation and so no switch to read. It asked for
      // thinking in the request it sent, and that is answer enough.
      thinking: true,
      apiKeyId: key.id,
    };
  }

  const claims = await verifyRuntimeToken(token);
  if (!claims) return null;
  return { ...claims, kind: 'runtime' };
}

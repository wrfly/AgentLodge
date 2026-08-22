import crypto from 'node:crypto';
import { all, get, nowIso, run } from './index.js';

/**
 * Long-lived API keys — the credential for pointing your own `claude` / `codex` at this
 * service.
 *
 * The schema trade-offs are in the `api_keys` comment in schema.sql. One thing to add
 * here: `verify()` runs on every request, so it has to be **one indexed equality lookup**
 * rather than a scan-and-compare.
 */

/** The `al_` prefix is chosen so that a key leaked to GitHub or similar is recognisable as a credential, to scanners and to people */
export const PREFIX = 'al_';
/** 32 bytes, 256 bits of entropy — 43 characters once base64url-encoded */
const KEY_BYTES = 32;

export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  /** For display, e.g. `al_3f9c2a1b` — not enough to reconstruct the key */
  prefix: string;
  createdAt: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface Row {
  id: string;
  user_id: string;
  name: string;
  key_hash: string;
  prefix: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

const toKey = (r: Row): ApiKey => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  prefix: r.prefix,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at ?? undefined,
  revokedAt: r.revoked_at ?? undefined,
});

const hash = (plain: string): string =>
  crypto.createHash('sha256').update(plain).digest('hex');

export interface Created {
  key: ApiKey;
  /** The plaintext, **returned this once only**; after this the database holds a hash */
  plaintext: string;
}

export function create(userId: string, name: string): Created {
  const plaintext = PREFIX + crypto.randomBytes(KEY_BYTES).toString('base64url');
  const id = crypto.randomUUID();
  const at = nowIso();
  // The prefix is the first 11 characters (al_ plus 8): enough to tell keys apart in a
  // list, not enough to work backwards from
  const prefix = plaintext.slice(0, PREFIX.length + 8);

  run(
    `insert into api_keys (id, user_id, name, key_hash, prefix, created_at)
     values (?, ?, ?, ?, ?, ?)`,
    id,
    userId,
    name,
    hash(plaintext),
    prefix,
    at,
  );
  return { key: { id, userId, name, prefix, createdAt: at }, plaintext };
}

export function list(userId: string): ApiKey[] {
  return all<Row>(
    `select * from api_keys where user_id = ? order by created_at desc`,
    userId,
  ).map(toKey);
}

/** Revocation is a soft delete: the row has to stay for historical usage records to still point at a key */
export function revoke(id: string, userId: string): boolean {
  return (
    run(
      `update api_keys set revoked_at = ? where id = ? and user_id = ? and revoked_at is null`,
      nowIso(),
      id,
      userId,
    ).changes > 0
  );
}

export interface Verified {
  id: string;
  userId: string;
}

/**
 * Plaintext to (keyId, userId); undefined once revoked.
 *
 * The shape is checked before the database is: anything without the `al_` prefix is a
 * runtime token or junk, and neither deserves a hash computation and a SQL round trip.
 */
export function verify(plaintext: string): Verified | undefined {
  if (!plaintext.startsWith(PREFIX)) return undefined;
  const row = get<Row>(
    `select * from api_keys where key_hash = ? and revoked_at is null`,
    hash(plaintext),
  );
  return row ? { id: row.id, userId: row.user_id } : undefined;
}

/**
 * Record a use.
 *
 * To the minute only. One conversation is dozens of requests, and a row per request
 * would turn this table into a write hotspot — while "last used in that minute" is all
 * the interface needs.
 */
export function touch(id: string): void {
  const at = nowIso();
  run(
    `update api_keys set last_used_at = ?
      where id = ?
        and (last_used_at is null or substr(last_used_at, 1, 16) <> substr(?, 1, 16))`,
    at,
    id,
    at,
  );
}

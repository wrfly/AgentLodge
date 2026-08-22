import crypto from 'node:crypto';
import { all, get, nowIso, run } from './index.js';
import { sha256 } from '../auth/crypto.js';

export interface AuthSession {
  id: string;
  userId: string;
  deviceName?: string;
  platform?: string;
  ip?: string;
  userAgent?: string;
  rotatedFrom?: string;
  expiresAt: string;
  revokedAt?: string;
  createdAt: string;
  lastSeenAt: string;
}

interface Row {
  id: string;
  user_id: string;
  refresh_token_hash: string;
  device_name: string | null;
  platform: string | null;
  ip: string | null;
  user_agent: string | null;
  rotated_from: string | null;
  expires_at: string;
  revoked_at: string | null;
  created_at: string;
  last_seen_at: string;
}

const toSession = (r: Row): AuthSession => ({
  id: r.id,
  userId: r.user_id,
  deviceName: r.device_name ?? undefined,
  platform: r.platform ?? undefined,
  ip: r.ip ?? undefined,
  userAgent: r.user_agent ?? undefined,
  rotatedFrom: r.rotated_from ?? undefined,
  expiresAt: r.expires_at,
  revokedAt: r.revoked_at ?? undefined,
  createdAt: r.created_at,
  lastSeenAt: r.last_seen_at,
});

export interface CreateSessionInput {
  userId: string;
  refreshToken: string;
  platform?: string;
  ip?: string;
  userAgent?: string;
  rotatedFrom?: string;
  ttlMs: number;
}

export function create(input: CreateSessionInput): AuthSession {
  const now = new Date();
  const id = crypto.randomUUID();
  run(
    `insert into auth_sessions
       (id, user_id, refresh_token_hash, platform, ip, user_agent, rotated_from,
        expires_at, created_at, last_seen_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.userId,
    sha256(input.refreshToken),
    input.platform ?? null,
    input.ip ?? null,
    input.userAgent?.slice(0, 300) ?? null,
    input.rotatedFrom ?? null,
    new Date(now.getTime() + input.ttlMs).toISOString(),
    now.toISOString(),
    now.toISOString(),
  );
  return findById(id)!;
}

export function findById(id: string): AuthSession | undefined {
  const r = get<Row>('select * from auth_sessions where id = ?', id);
  return r && toSession(r);
}

export function findByToken(token: string): AuthSession | undefined {
  const r = get<Row>('select * from auth_sessions where refresh_token_hash = ?', sha256(token));
  return r && toSession(r);
}

/** Whether this session's token has already been exchanged — the basis of replay detection */
export function hasDescendant(sessionId: string): boolean {
  return Boolean(get('select 1 as x from auth_sessions where rotated_from = ?', sessionId));
}

/**
 * The newest still-valid session this one rotated into.
 *
 * It separates a concurrent refresh from a real replay: the same token exchanged twice
 * within moments, where the resulting session is still alive, is one client making two
 * requests at once.
 */
export function latestActiveDescendant(sessionId: string): AuthSession | undefined {
  const r = get<Row>(
    `select * from auth_sessions
      where rotated_from = ? and revoked_at is null and expires_at > ?
      order by created_at desc limit 1`,
    sessionId,
    nowIso(),
  );
  return r && toSession(r);
}

export function listActive(userId: string): AuthSession[] {
  return all<Row>(
    'select * from auth_sessions where user_id = ? and revoked_at is null order by last_seen_at desc',
    userId,
  ).map(toSession);
}

export function isActive(sessionId: string): boolean {
  return Boolean(
    get(
      "select 1 as x from auth_sessions where id = ? and revoked_at is null and expires_at > ?",
      sessionId,
      nowIso(),
    ),
  );
}

export function revoke(id: string): void {
  run('update auth_sessions set revoked_at = ? where id = ? and revoked_at is null', nowIso(), id);
}

/** On detecting a replayed refresh token, invalidate every session that user has */
export function revokeAll(userId: string): number {
  return run(
    'update auth_sessions set revoked_at = ? where user_id = ? and revoked_at is null',
    nowIso(),
    userId,
  ).changes;
}

export function touch(id: string): void {
  run('update auth_sessions set last_seen_at = ? where id = ?', nowIso(), id);
}

export function pruneExpired(): number {
  const cutoff = new Date(Date.now() - 7 * 86400_000).toISOString();
  return run(
    'delete from auth_sessions where expires_at < ? or (revoked_at is not null and revoked_at < ?)',
    nowIso(),
    cutoff,
  ).changes;
}

/* ---------------- Password reset ---------------- */

export interface PasswordReset {
  id: string;
  userId: string;
  expiresAt: string;
  usedAt?: string;
  createdAt: string;
}

interface ResetRow {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

export function createReset(userId: string, token: string, ttlMs: number): PasswordReset {
  const now = new Date();
  const id = crypto.randomUUID();
  // One valid link per user; the newest wins
  run('update password_resets set used_at = ? where user_id = ? and used_at is null', now.toISOString(), userId);
  run(
    'insert into password_resets (id, user_id, token_hash, expires_at, created_at) values (?, ?, ?, ?, ?)',
    id,
    userId,
    sha256(token),
    new Date(now.getTime() + ttlMs).toISOString(),
    now.toISOString(),
  );
  return { id, userId, expiresAt: new Date(now.getTime() + ttlMs).toISOString(), createdAt: now.toISOString() };
}

export function findReset(token: string): PasswordReset | undefined {
  const r = get<ResetRow>('select * from password_resets where token_hash = ?', sha256(token));
  if (!r) return undefined;
  return {
    id: r.id,
    userId: r.user_id,
    expiresAt: r.expires_at,
    usedAt: r.used_at ?? undefined,
    createdAt: r.created_at,
  };
}

export function useReset(id: string): void {
  run('update password_resets set used_at = ? where id = ?', nowIso(), id);
}

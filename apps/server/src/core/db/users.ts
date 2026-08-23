import crypto from 'node:crypto';
import { all, bool, flag, get, nowIso, run } from './index.js';
import { getNumber } from './settings.js';

export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type { LimitKind, QuotaScope } from '../protocol.js';
import type { LimitKind, QuotaScope } from '../protocol.js';

export interface User {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  role: Role;
  status: UserStatus;
  inviteCodeId?: string;
  createdAt: string;
  lastLoginAt?: string;
  passwordChangedAt?: string;
}

export interface Quota {
  userId: string;
  /** Limit by billable tokens, or by money in micro-units */
  limitKind: LimitKind;
  currency: string;
  /**
   * The three ceilings, in the unit `limitKind` names. null means that window is unlimited.
   *
   * The windows are the platform's — one 5-hour window, one week, one month, the same
   * instants for everybody. See core/db/period.ts for why they cannot be per-user.
   */
  window: number | null;
  week: number | null;
  month: number | null;
  hardStop: boolean;
  /** A top-up: extra allowance on one window, expiring when that window resets */
  boost?: { scope: QuotaScope; amount: number; until: string };
  /**
   * When an administrator zeroed it by hand.
   *
   * Counting takes max(window start, resetAt), so it only affects windows already running;
   * the next one begins at its own boundary as usual.
   */
  resetAt?: string;
  /** The window a quota warning email has already gone out for */
  warnedPeriod?: string;
  updatedAt: string;
  updatedBy?: string;
}


interface UserRow {
  id: string;
  email: string;
  username: string;
  password_hash: string;
  role: string;
  status: string;
  invite_code_id: string | null;
  created_at: string;
  last_login_at: string | null;
  password_changed_at: string | null;
}

interface QuotaRow {
  user_id: string;
  limit_kind?: string | null;
  window_limit?: number | null;
  week_limit?: number | null;
  month_limit?: number | null;
  hard_stop: number;
  boost_scope?: string | null;
  boost_amount?: number | null;
  boost_until?: string | null;
  reset_at?: string | null;
  warned_period?: string | null;
  updated_at: string;
  updated_by: string | null;
}


const toUser = (r: UserRow): User => ({
  id: r.id,
  email: r.email,
  username: r.username,
  passwordHash: r.password_hash,
  role: r.role as Role,
  status: r.status as UserStatus,
  inviteCodeId: r.invite_code_id ?? undefined,
  createdAt: r.created_at,
  lastLoginAt: r.last_login_at ?? undefined,
  passwordChangedAt: r.password_changed_at ?? undefined,
});

/** The one currency quotas are priced in. Kept where it was, next to the only reader. */
const CURRENCY = 'CNY';

const toQuota = (r: QuotaRow): Quota => ({
  userId: r.user_id,
  limitKind: r.limit_kind === 'cost' ? 'cost' : 'tokens',
  currency: CURRENCY,
  window: r.window_limit ?? null,
  week: r.week_limit ?? null,
  month: r.month_limit ?? null,
  hardStop: r.hard_stop === 1,
  // A boost with no scope or no expiry is not a boost; treat it as absent rather than
  // half-applying it
  boost:
    r.boost_scope && r.boost_amount != null && r.boost_until
      ? { scope: r.boost_scope as QuotaScope, amount: r.boost_amount, until: r.boost_until }
      : undefined,
  resetAt: r.reset_at ?? undefined,
  warnedPeriod: r.warned_period ?? undefined,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by ?? undefined,
});


/* ---------------- Reads ---------------- */

export function findById(id: string): User | undefined {
  const r = get<UserRow>('select * from users where id = ?', id);
  return r && toUser(r);
}

export function findByEmail(email: string): User | undefined {
  const r = get<UserRow>('select * from users where email = ?', email.trim().toLowerCase());
  return r && toUser(r);
}

export function emailTaken(email: string): boolean {
  return Boolean(get('select 1 as x from users where email = ?', email.trim().toLowerCase()));
}

export function usernameTaken(username: string): boolean {
  return Boolean(
    get('select 1 as x from users where lower(username) = ?', username.trim().toLowerCase()),
  );
}

export function count(): number {
  return get<{ n: number }>('select count(*) as n from users')?.n ?? 0;
}

export function list(): User[] {
  return all<UserRow>('select * from users order by created_at').map(toUser);
}

/* ---------------- Writes ---------------- */

export interface CreateUserInput {
  email: string;
  username: string;
  passwordHash: string;
  role: Role;
  inviteCodeId?: string;
  tokenLimit?: number | null;
}

export function create(input: CreateUserInput): User {
  const now = nowIso();
  const id = crypto.randomUUID();
  run(
    `insert into users (id, email, username, password_hash, role, status, invite_code_id, created_at)
     values (?, ?, ?, ?, ?, 'active', ?, ?)`,
    id,
    input.email.trim().toLowerCase(),
    input.username.trim(),
    input.passwordHash,
    input.role,
    input.inviteCodeId ?? null,
    now,
  );

  // A monthly ceiling carried by the invite code wins; otherwise the global default. The
  // other two windows start unlimited: a deployment that only cares about the month should
  // not have the other two invented for it.
  const month =
    input.tokenLimit !== undefined ? input.tokenLimit : (getNumber('quota.defaultTokenLimit') ?? null);
  run(
    `insert into user_quotas (user_id, limit_kind, month_limit, hard_stop, updated_at)
     values (?, 'tokens', ?, 1, ?)`,
    id,
    month,
    now,
  );

  return findById(id)!;
}

export function touchLogin(id: string): void {
  run('update users set last_login_at = ? where id = ?', nowIso(), id);
}

export function setPassword(id: string, passwordHash: string): void {
  const now = nowIso();
  run('update users set password_hash = ?, password_changed_at = ? where id = ?', passwordHash, now, id);
}

export function setStatus(id: string, status: UserStatus): void {
  run('update users set status = ? where id = ?', status, id);
}

export function setRole(id: string, role: Role): void {
  run('update users set role = ? where id = ?', role, id);
}

export function remove(id: string): void {
  run('delete from users where id = ?', id);
}

/* ---------------- Quota ---------------- */

export function getQuota(userId: string): Quota {
  const r = get<QuotaRow>('select * from user_quotas where user_id = ?', userId);
  if (r) return toQuota(r);

  // A user created before this table had a row for them
  const now = nowIso();
  const month = getNumber('quota.defaultTokenLimit') ?? null;
  run(
    `insert into user_quotas (user_id, limit_kind, month_limit, hard_stop, updated_at)
     values (?, 'tokens', ?, 1, ?)`,
    userId,
    month,
    now,
  );
  return {
    userId,
    limitKind: 'tokens',
    currency: CURRENCY,
    window: null,
    week: null,
    month,
    hardStop: true,
    updatedAt: now,
  };
}

export interface QuotaPatch {
  limitKind?: LimitKind;
  /** null clears a ceiling, which means that window stops being limited */
  window?: number | null;
  week?: number | null;
  month?: number | null;
  hardStop?: boolean;
}

export function markWarned(userId: string, period: string): void {
  run('update user_quotas set warned_period = ? where user_id = ?', period, userId);
}

/**
 * Zero this user's usage in the windows currently running.
 *
 * Counting takes max(window start, reset_at), so a reset only affects windows that have
 * already begun; the next one starts at its own boundary, which is what keeps the
 * boundaries the same for everybody even after an administrator intervenes.
 */
export function resetUsage(userId: string, at: string | null = nowIso()): void {
  run('update user_quotas set reset_at = ?, warned_period = null where user_id = ?', at, userId);
}

/** Undo a manual reset and count from the window's own start again */
export function undoResetUsage(userId: string): void {
  resetUsage(userId, null);
}

/**
 * A top-up: extra allowance on one window, gone when that window resets.
 *
 * @param until the end of the window it applies to, taken at the moment of granting. There
 * is no renewal and no separate clock — the window's own boundary is the expiry, so a
 * top-up cannot give one user a schedule of their own.
 */
export function grantBoost(
  userId: string,
  scope: QuotaScope,
  amount: number,
  until: string,
  updatedBy?: string,
): Quota {
  getQuota(userId); // makes sure the row exists
  run(
    `update user_quotas set boost_scope = ?, boost_amount = ?, boost_until = ?,
       warned_period = null, updated_at = ?, updated_by = ?
     where user_id = ?`,
    scope,
    Math.max(0, Math.round(amount)),
    until,
    nowIso(),
    updatedBy ?? null,
    userId,
  );
  return getQuota(userId);
}

export function clearBoost(userId: string): void {
  run(
    'update user_quotas set boost_scope = null, boost_amount = null, boost_until = null where user_id = ?',
    userId,
  );
}

export function setQuota(userId: string, patch: QuotaPatch, updatedBy?: string): Quota {
  const current = getQuota(userId);
  const next: Quota = {
    ...current,
    limitKind: patch.limitKind ?? current.limitKind,
    // undefined leaves a ceiling alone; null clears it
    window: patch.window === undefined ? current.window : patch.window,
    week: patch.week === undefined ? current.week : patch.week,
    month: patch.month === undefined ? current.month : patch.month,
    hardStop: patch.hardStop ?? current.hardStop,
    updatedAt: nowIso(),
    updatedBy: updatedBy ?? current.updatedBy,
  };
  run(
    `update user_quotas set
       limit_kind = ?, window_limit = ?, week_limit = ?, month_limit = ?,
       hard_stop = ?, updated_at = ?, updated_by = ?
     where user_id = ?`,
    next.limitKind,
    next.window,
    next.week,
    next.month,
    flag(next.hardStop),
    next.updatedAt,
    next.updatedBy ?? null,
    userId,
  );
  return next;
}

/* ---------------- Outward-facing view ---------------- */

export interface PublicUser {
  id: string;
  email: string;
  username: string;
  role: Role;
  status: UserStatus;
  createdAt: string;
  lastLoginAt?: string;
}

export function toPublic(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    username: u.username,
    role: u.role,
    status: u.status,
    createdAt: u.createdAt,
    lastLoginAt: u.lastLoginAt,
  };
}

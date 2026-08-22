import crypto from 'node:crypto';
import { all, bool, flag, get, nowIso, run } from './index.js';
import { getNumber } from './settings.js';

export type Role = 'user' | 'admin';
export type UserStatus = 'active' | 'suspended';
export type { QuotaPeriod } from './period.js';
import type { QuotaPeriod } from './period.js';

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
  tokenLimit: number | null;
  period: QuotaPeriod;
  hardStop: boolean;
  updatedAt: string;
  updatedBy?: string;
  /** The period a quota warning email has already been sent for */
  warnedPeriod?: string;
  /**
   * When an administrator zeroed it by hand.
   *
   * Counting takes max(period start, resetAt), so a manual reset only affects the current
   * period; the next one follows its natural boundary as usual.
   */
  resetAt?: string;

  /* --- rolling periods: "usable for N hours after the top-up" --- */
  /** Window length, in hours */
  periodHours?: number;
  /** Where this user's window starts, usually the moment of the top-up */
  cycleStart?: string;
  /** true renews the window on expiry; false makes it a one-off that stops when used up or expired */
  autoRenew: boolean;

  /* --- What the limit is measured in --- */
  /** tokens: billable tokens. cost: money. */
  limitKind: 'tokens' | 'cost';
  /** Money ceiling, in micro-units */
  costLimitMicro: number | null;
  currency: string;
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
  token_limit: number | null;
  period: string;
  hard_stop: number;
  updated_at: string;
  updated_by: string | null;
  warned_period?: string | null;
  reset_at?: string | null;
  period_hours?: number | null;
  cycle_start?: string | null;
  auto_renew?: number | null;
  limit_kind?: string | null;
  cost_limit_micro?: number | null;
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

const toQuota = (r: QuotaRow): Quota => ({
  userId: r.user_id,
  tokenLimit: r.token_limit,
  period: r.period as QuotaPeriod,
  hardStop: bool(r.hard_stop),
  updatedAt: r.updated_at,
  updatedBy: r.updated_by ?? undefined,
  warnedPeriod: r.warned_period ?? undefined,
  resetAt: r.reset_at ?? undefined,
  periodHours: r.period_hours ?? undefined,
  cycleStart: r.cycle_start ?? undefined,
  autoRenew: r.auto_renew === null || r.auto_renew === undefined ? true : bool(r.auto_renew),
  limitKind: (r.limit_kind as 'tokens' | 'cost') ?? 'tokens',
  costLimitMicro: r.cost_limit_micro ?? null,
  currency: 'CNY',
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

  // A quota carried by the invite code wins; otherwise the global default
  const limit =
    input.tokenLimit !== undefined ? input.tokenLimit : (getNumber('quota.defaultTokenLimit') ?? null);
  run(
    `insert into user_quotas (user_id, token_limit, period, hard_stop, updated_at)
     values (?, ?, 'monthly', 1, ?)`,
    id,
    limit,
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
  // Fallback for older rows that have no quota
  const now = nowIso();
  run(
    `insert into user_quotas (user_id, token_limit, period, hard_stop, updated_at) values (?, ?, 'monthly', 1, ?)`,
    userId,
    getNumber('quota.defaultTokenLimit') ?? null,
    now,
  );
  return {
    userId,
    tokenLimit: getNumber('quota.defaultTokenLimit') ?? null,
    period: 'monthly',
    hardStop: true,
    updatedAt: now,
    autoRenew: true,
    limitKind: 'tokens',
    costLimitMicro: null,
    currency: 'CNY',
  };
}

export interface QuotaPatch {
  tokenLimit?: number | null;
  period?: QuotaPeriod;
  hardStop?: boolean;
  periodHours?: number | null;
  /** 'now' starts the clock at this moment — what a top-up does */
  cycleStart?: string | null;
  autoRenew?: boolean;
  limitKind?: 'tokens' | 'cost';
  costLimitMicro?: number | null;
}

export function markWarned(userId: string, period: string): void {
  run('update user_quotas set warned_period = ? where user_id = ?', period, userId);
}

/**
 * Zero the current period's usage by hand.
 *
 * usage_records are not deleted — those are the books and do not get edited. The counting
 * start simply moves forward. The warning flag is cleared too, so the new period can send
 * its reminder again.
 */
export function resetUsage(userId: string, at: string | null = nowIso()): void {
  run('update user_quotas set reset_at = ?, warned_period = null where user_id = ?', at, userId);
}

/** Undo a manual reset and go back to the natural period */
export function undoResetUsage(userId: string): void {
  resetUsage(userId, null);
}

export function setQuota(userId: string, patch: QuotaPatch, updatedBy?: string): Quota {
  const current = getQuota(userId);
  const next: Quota = {
    ...current,
    ...patch,
    // null in the patch means "clear it", which has to become undefined to satisfy Quota's type
    periodHours: patch.periodHours === null ? undefined : (patch.periodHours ?? current.periodHours),
    cycleStart:
      patch.cycleStart === 'now'
        ? nowIso()
        : patch.cycleStart === null
          ? undefined
          : (patch.cycleStart ?? current.cycleStart),
    autoRenew: patch.autoRenew ?? current.autoRenew,
    limitKind: patch.limitKind ?? current.limitKind,
    costLimitMicro:
      patch.costLimitMicro === undefined ? current.costLimitMicro : patch.costLimitMicro,
    updatedAt: nowIso(),
    updatedBy: updatedBy ?? current.updatedBy,
  };
  run(
    `update user_quotas set
       token_limit = ?, period = ?, hard_stop = ?, updated_at = ?, updated_by = ?,
       period_hours = ?, cycle_start = ?, auto_renew = ?, limit_kind = ?, cost_limit_micro = ?
     where user_id = ?`,
    next.tokenLimit,
    next.period,
    flag(next.hardStop),
    next.updatedAt,
    next.updatedBy ?? null,
    next.periodHours ?? null,
    next.cycleStart ?? null,
    flag(next.autoRenew),
    next.limitKind,
    next.costLimitMicro,
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

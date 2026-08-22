import crypto from 'node:crypto';
import { all, bool, flag, get, nowIso, run } from './index.js';
import type { Role } from './users.js';

export interface InviteCode {
  id: string;
  code: string;
  /** A targeted invite: only this address can use it */
  email?: string;
  createdBy?: string;
  note?: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  presetRole: Role;
  presetTokenLimit: number | null;
  disabled: boolean;
  createdAt: string;
  sentAt?: string;
}

interface Row {
  id: string;
  code: string;
  email: string | null;
  created_by: string | null;
  note: string | null;
  max_uses: number;
  used_count: number;
  expires_at: string | null;
  preset_role: string;
  preset_token_limit: number | null;
  disabled: number;
  created_at: string;
  sent_at: string | null;
}

const toInvite = (r: Row): InviteCode => ({
  id: r.id,
  code: r.code,
  email: r.email ?? undefined,
  createdBy: r.created_by ?? undefined,
  note: r.note ?? undefined,
  maxUses: r.max_uses,
  usedCount: r.used_count,
  expiresAt: r.expires_at ?? undefined,
  presetRole: r.preset_role as Role,
  presetTokenLimit: r.preset_token_limit,
  disabled: bool(r.disabled),
  createdAt: r.created_at,
  sentAt: r.sent_at ?? undefined,
});

/** Invite codes: confusable characters (0/O, 1/I) removed, grouped so they can be read aloud */
export function generateCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}-${pick()}`;
}

export interface CreateInviteInput {
  email?: string;
  createdBy?: string;
  note?: string;
  maxUses?: number;
  expiresAt?: string;
  presetRole?: Role;
  presetTokenLimit?: number | null;
}

export function create(input: CreateInviteInput): InviteCode {
  let code = generateCode();
  while (findByCode(code)) code = generateCode();

  const id = crypto.randomUUID();
  run(
    `insert into invite_codes
       (id, code, email, created_by, note, max_uses, used_count, expires_at,
        preset_role, preset_token_limit, disabled, created_at)
     values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 0, ?)`,
    id,
    code,
    input.email?.trim().toLowerCase() ?? null,
    input.createdBy ?? null,
    input.note ?? null,
    input.maxUses ?? 1,
    input.expiresAt ?? null,
    input.presetRole ?? 'user',
    input.presetTokenLimit ?? null,
    nowIso(),
  );
  return findById(id)!;
}

export function findById(id: string): InviteCode | undefined {
  const r = get<Row>('select * from invite_codes where id = ?', id);
  return r && toInvite(r);
}

export function findByCode(code: string): InviteCode | undefined {
  const r = get<Row>('select * from invite_codes where code = ?', code.trim().toUpperCase());
  return r && toInvite(r);
}

export function list(): InviteCode[] {
  return all<Row>('select * from invite_codes order by created_at desc').map(toInvite);
}

export type Usability = { ok: true } | { ok: false; reason: string };

export function checkUsable(invite: InviteCode, email?: string): Usability {
  if (invite.disabled) return { ok: false, reason: 'This invite code has been disabled' };
  if (invite.usedCount >= invite.maxUses) return { ok: false, reason: 'This invite code has been used up' };
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date())
    return { ok: false, reason: 'This invite code has expired' };
  // A targeted invite has to be redeemed with the address it names
  if (invite.email && email && invite.email !== email.trim().toLowerCase())
    return { ok: false, reason: 'This invite code only works for the address it was sent to' };
  return { ok: true };
}

export function consume(id: string): void {
  run('update invite_codes set used_count = used_count + 1 where id = ?', id);
}

export function setDisabled(id: string, disabled: boolean): boolean {
  return run('update invite_codes set disabled = ? where id = ?', flag(disabled), id).changes > 0;
}

export function markSent(id: string): void {
  run('update invite_codes set sent_at = ? where id = ?', nowIso(), id);
}

export function remove(id: string): boolean {
  return run('delete from invite_codes where id = ?', id).changes > 0;
}

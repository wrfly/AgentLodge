import { all, nowIso, parseJson, run } from './index.js';

export interface AuditEntry {
  id: number;
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
  createdAt: string;
}

interface Row {
  id: number;
  actor_id: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  detail: string | null;
  ip: string | null;
  created_at: string;
}

export interface LogInput {
  actorId?: string;
  action: string;
  targetType?: string;
  targetId?: string;
  detail?: unknown;
  ip?: string;
}

export function log(input: LogInput): void {
  run(
    `insert into audit_logs (actor_id, action, target_type, target_id, detail, ip, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
    input.actorId ?? null,
    input.action,
    input.targetType ?? null,
    input.targetId ?? null,
    input.detail === undefined ? null : JSON.stringify(input.detail),
    input.ip ?? null,
    nowIso(),
  );
}

export function list(limit = 200): AuditEntry[] {
  return all<Row>('select * from audit_logs order by created_at desc limit ?', limit).map((r) => ({
    id: r.id,
    actorId: r.actor_id ?? undefined,
    action: r.action,
    targetType: r.target_type ?? undefined,
    targetId: r.target_id ?? undefined,
    detail: r.detail ? parseJson<unknown>(r.detail, null) : undefined,
    ip: r.ip ?? undefined,
    createdAt: r.created_at,
  }));
}

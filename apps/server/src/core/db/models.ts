import crypto from 'node:crypto';
import { all, flag, get, nowIso, run } from './index.js';

/**
 * The models a user can pick, and which upstream serves each.
 *
 * This is the table requests are routed by. A request names a model; that name selects a
 * row; the row names the provider to forward to. The provider registry answers "how do we
 * connect", and nothing more — which one is used is a property of the model, not a global
 * switch.
 *
 * **One name may have several rows.** The same model offered by two upstreams is two rows
 * with the same name and different providers, and they can carry different prices (see
 * model_pricing.provider_id). `priority` orders them, lowest first; the rest are what a
 * failover reaches for.
 */

export interface Model {
  id: string;
  /** What a user picks and what a request carries. Also the key pricing and usage rows use. */
  name: string;
  providerId: string;
  /** The name to send upstream, when it differs from `name`. Empty means they match. */
  upstreamName: string;
  enabled: boolean;
  /** Lowest first among rows sharing a name */
  priority: number;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  provider_id: string;
  upstream_name: string;
  enabled: number;
  priority: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const toModel = (r: Row): Model => ({
  id: r.id,
  name: r.name,
  providerId: r.provider_id,
  upstreamName: r.upstream_name ?? '',
  enabled: r.enabled === 1,
  priority: r.priority,
  note: r.note ?? undefined,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function list(): Model[] {
  return all<Row>('select * from models order by name, priority, created_at').map(toModel);
}

export function findById(id: string): Model | undefined {
  const r = get<Row>('select * from models where id = ?', id);
  return r && toModel(r);
}

/**
 * The rows that can serve this name, best first.
 *
 * Disabled rows are left out entirely: an administrator turning one off means "do not send
 * anything here", including as a fallback.
 */
export function candidates(name: string): Model[] {
  return all<Row>(
    'select * from models where name = ? and enabled = 1 order by priority, created_at',
    name,
  ).map(toModel);
}

/** The names on offer, in the order the picker should show them */
export function names(): string[] {
  return all<{ name: string }>(
    'select name from models where enabled = 1 group by name order by min(priority), name',
  ).map((r) => r.name);
}

/** Whether anything at all is configured, which is what "the deployment is not set up" means */
export function any(): boolean {
  return Boolean(get('select 1 as x from models where enabled = 1 limit 1'));
}

export interface UpsertInput {
  name: string;
  providerId: string;
  upstreamName?: string;
  enabled?: boolean;
  priority?: number;
  note?: string;
}

export function create(input: UpsertInput): Model {
  const id = crypto.randomUUID();
  const now = nowIso();
  run(
    `insert into models (id, name, provider_id, upstream_name, enabled, priority, note, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.providerId,
    (input.upstreamName ?? '').trim(),
    flag(input.enabled ?? true),
    input.priority ?? nextPriority(input.name.trim()),
    input.note ?? null,
    now,
    now,
  );
  return findById(id)!;
}

/** New rows for a name that already exists go behind the ones already there */
function nextPriority(name: string): number {
  const r = get<{ n: number | null }>('select max(priority) as n from models where name = ?', name);
  return (r?.n ?? -1) + 1;
}

export function update(id: string, patch: Partial<UpsertInput>): Model | undefined {
  const cur = findById(id);
  if (!cur) return undefined;
  run(
    `update models set name = ?, provider_id = ?, upstream_name = ?, enabled = ?, priority = ?, note = ?, updated_at = ?
      where id = ?`,
    (patch.name ?? cur.name).trim(),
    patch.providerId ?? cur.providerId,
    (patch.upstreamName ?? cur.upstreamName).trim(),
    flag(patch.enabled ?? cur.enabled),
    patch.priority ?? cur.priority,
    patch.note ?? cur.note ?? null,
    nowIso(),
    id,
  );
  return findById(id);
}

export function remove(id: string): boolean {
  return run('delete from models where id = ?', id).changes > 0;
}

/**
 * Add the names an upstream reports, keeping what is already configured.
 *
 * Used by the console's "pull from the upstream" button and by the hourly refresh. It only
 * ever adds: a name that has been turned off stays off, a priority somebody set stays put,
 * and a name that has disappeared upstream is left in place rather than deleted — an
 * endpoint answering an incomplete list for a minute should not silently empty the picker.
 */
export function addMissing(providerId: string, names: string[]): number {
  const have = new Set(
    all<{ name: string }>('select name from models where provider_id = ?', providerId).map((r) => r.name),
  );
  let added = 0;
  for (const name of names) {
    const clean = name.trim();
    if (!clean || have.has(clean)) continue;
    create({ name: clean, providerId });
    have.add(clean);
    added++;
  }
  return added;
}

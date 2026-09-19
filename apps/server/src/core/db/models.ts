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
  const listed = all<{ name: string }>(
    'select name from models where enabled = 1 group by name order by min(priority), name',
  ).map((r) => r.name);
  return listed.filter((n) => canonicalOf(n, listed) === n);
}

/** The picker and the console: identities only, not Cursor's effort/thinking slugs */
export function listVisible(): Model[] {
  const rows = list();
  const pool = rows.map((m) => m.name);
  return rows.filter((m) => canonicalOf(m.name, pool) === m.name);
}

/**
 * The stem Claude Code meant, with parameters taken off.
 *
 * `claude-opus-5[1m]` is the model `claude-opus-5` running at a 1M window — a parameter, not
 * a different row. `claude-haiku-4-5-20251001` is the same model as `claude-haiku-4-5` with
 * Anthropic's snapshot date stamped on. The table is keyed by the stem; the suffix has to
 * travel with the request so the upstream can still read it.
 */
export function stemOf(name: string): string {
  return name.replace(/\[[^\]]*\]$/, '').replace(/-\d{8}$/, '').trim();
}

/**
 * Effort, thinking, max-mode and `-latest` are not models.
 *
 * Cursor lists `claude-sonnet-5-high` beside `-low` and `composer-latest` beside
 * `composer-2.5`. The picker is keyed by the model; those suffixes go out on the request
 * after the catalogue resolves them. Fast is different: `composer-2.5-fast` costs more, so
 * it stays on the name.
 *
 * Hyphenated versions (`composer-2-5`, `gpt-5-6-luna`) are the same model as the dotted
 * form. Anthropic ids (`claude-opus-4-5`) keep their hyphens — that is how those names
 * are published. Cursor's word order (`claude-4.5-sonnet`) is the same id.
 */
const VARIANT_SUFFIXES = [
  '-thinking-xhigh',
  '-thinking-high',
  '-thinking-medium',
  '-thinking-low',
  '-thinking',
  '-xhigh',
  '-high',
  '-medium',
  '-low',
  '-minimal',
  '-max',
  '-latest',
];

export function identityOf(name: string): string {
  let id = stemOf(name);
  if (!id) return id;
  const fast = id.endsWith('-fast') && id.length > '-fast'.length;
  if (fast) id = id.slice(0, -'-fast'.length);
  for (let again = true; again; ) {
    again = false;
    for (const suffix of VARIANT_SUFFIXES) {
      if (!id.endsWith(suffix) || id.length <= suffix.length) continue;
      // Codex Max is a model (`gpt-5.1-codex-max`), not Claude's max-mode suffix
      if (suffix === '-max' && id.endsWith('codex-max')) continue;
      id = id.slice(0, -suffix.length);
      again = true;
      break;
    }
  }
  if (!id.startsWith('claude-')) id = id.replace(/(\d+)-(\d+)/g, '$1.$2');
  id = anthropicId(id);
  return fast ? `${id}-fast` : id;
}

const CLAUDE_FAMILY = 'opus|sonnet|haiku|fable';

/**
 * Cursor writes `claude-4.5-sonnet`; Anthropic writes `claude-sonnet-4-5`. Same model.
 * Short names (`sonnet-4.5`, `opus-5`) are the same again. The Anthropic id is the one
 * the price table and the picker already use.
 */
function anthropicId(id: string): string {
  const cursor = new RegExp(`^claude-(\\d+(?:[.-]\\d+)*)-(${CLAUDE_FAMILY})$`).exec(id);
  if (cursor) {
    const major = Number(cursor[1].split(/[.-]/)[0]);
    // Family-first starts at Claude 4 (`claude-sonnet-4-5`). `claude-3-5-sonnet` stays.
    if (major >= 4) return `claude-${cursor[2]}-${cursor[1].replace(/\./g, '-')}`;
  }
  const short = new RegExp(`^(${CLAUDE_FAMILY})-(\\d+(?:[.-]\\d+)*)$`).exec(id);
  if (short) return `claude-${short[1]}-${short[2].replace(/\./g, '-')}`;
  const familyFirst = new RegExp(`^claude-(${CLAUDE_FAMILY})-(\\d+(?:[.-]\\d+)*)$`).exec(id);
  if (familyFirst) return `claude-${familyFirst[1]}-${familyFirst[2].replace(/\./g, '-')}`;
  return id;
}

/**
 * An unversioned alias prefers the newest versioned sibling on the same provider.
 *
 * `composer-latest` and `composer` are Composer 2.5, not a fourth model beside
 * `composer-2.5`. Fast stays on its own side: `composer-2.5-fast` is not a candidate
 * for the standard alias. `gemini-flash` has no versioned `gemini-flash-2.x`, so it
 * stays `gemini-flash`.
 */
function preferVersioned(id: string, pool: string[]): string {
  const fast = id.endsWith('-fast');
  const family = fast ? id.slice(0, -'-fast'.length) : id;
  if (/\d/.test(family)) return id;

  let best: string | undefined;
  let bestVer: number[] = [];
  for (const candidate of pool) {
    if (candidate.endsWith('-fast') !== fast) continue;
    const stem = candidate.endsWith('-fast') ? candidate.slice(0, -'-fast'.length) : candidate;
    if (stem === family) continue;
    if (!stem.startsWith(`${family}-`)) {
      const claude = new RegExp(`^claude-${family}-([\\d-]+)$`).exec(stem);
      if (claude && /^(opus|sonnet|haiku|fable)$/.test(family)) {
        const ver = claude[1].split('-').map(Number);
        if (!best || cmpVer(ver, bestVer) > 0) {
          best = candidate;
          bestVer = ver;
        }
      }
      continue;
    }
    const rest = stem.slice(family.length);
    if (!/^-[\d.]+$/.test(rest)) continue;
    const ver = rest.slice(1).split('.').map(Number);
    if (!best || cmpVer(ver, bestVer) > 0) {
      best = candidate;
      bestVer = ver;
    }
  }
  return best ?? id;
}

/** Positive when `a` is newer. `5` beats `4.8`; `2.5` beats `2`. */
function cmpVer(a: number[], b: number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

export function canonicalOf(name: string, pool: string[]): string {
  return preferVersioned(identityOf(name), pool.map(identityOf));
}

/**
 * What an Anthropic client is told we serve.
 *
 * `[1m]` is a context window, not a model. The table and the picker keep the stem. Claude
 * Code still writes the window onto the name (`opus[1m]` → `claude-opus-5[1m]`) and looks
 * that string up in `GET /v1/models`; missing it is refused as unknown. The alias is only
 * for that lookup — it is not a row, and a pull must not create one.
 */
export function advertisedNames(): string[] {
  const listed = names();
  const seen = new Set(listed);
  const extra: string[] = [];
  for (const id of listed) {
    if (id.includes('[')) continue;
    if (!/^(claude-|opus$|sonnet$|haiku$|fable$)/.test(id)) continue;
    const alias = `${id}[1m]`;
    if (seen.has(alias)) continue;
    seen.add(alias);
    extra.push(alias);
  }
  return extra.length ? [...listed, ...extra] : listed;
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

/**
 * Drop alias slugs that were pulled as if they were models.
 *
 * A Cursor catalogue answers with every variant string and every `-latest` alias. Those
 * used to land as rows, so the picker filled with `claude-sonnet-5-high` beside `-low`
 * and `composer-latest` beside `composer-2.5`. The identity is kept (created if the pull
 * never added it); the suffix rows go. Fast stays, because it is a different price.
 *
 * Returns how many rows were removed.
 */
export function collapseVariantRows(providerId?: string): number {
  const rows = providerId ? list().filter((m) => m.providerId === providerId) : list();
  const have = new Set(rows.map((m) => `${m.providerId}\0${m.name}`));
  const removeIds: string[] = [];
  for (const m of rows) {
    const identity = canonicalOf(m.name, rows.map((r) => r.name));
    if (identity === m.name) continue;
    const key = `${m.providerId}\0${identity}`;
    if (!have.has(key)) {
      create({
        name: identity,
        providerId: m.providerId,
        upstreamName: m.upstreamName,
        enabled: m.enabled,
        priority: m.priority,
        note: m.note,
      });
      have.add(key);
    }
    removeIds.push(m.id);
  }
  for (const id of removeIds) remove(id);
  return removeIds.length;
}

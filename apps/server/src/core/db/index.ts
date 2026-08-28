import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const here = path.dirname(fileURLToPath(import.meta.url));

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!db) throw new Error('The database is not initialised yet — call initDb() first');
  return db;
}

/** A synchronous sleep, used once or twice at startup */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Switch to WAL.
 *
 * The trap: `pragma journal_mode = wal` briefly takes an exclusive lock, and
 * **busy_timeout does not apply to it**. Start two processes together and the slower one
 * throws SQLITE_BUSY and fails to come up.
 *
 * But WAL is a **persistent property** of the database — one process succeeding is enough
 * for all of them. So failure here is not fatal: retry a few times and confirm the mode
 * ended up as wal. Genuinely not getting there only falls back to the default journal
 * mode, where concurrent writes contend more; it should not stop the service starting.
 */
function ensureWal(d: DatabaseSync): void {
  const current = (): string => {
    const row = d.prepare('pragma journal_mode').get() as { journal_mode?: string } | undefined;
    return String(row?.journal_mode ?? '').toLowerCase();
  };

  for (let i = 0; i < 10; i++) {
    if (current() === 'wal') return;
    try {
      d.exec('pragma journal_mode = wal');
    } catch {
      // Another process is switching it; wait and look again
    }
    if (current() === 'wal') return;
    sleepSync(200);
  }
  console.warn('[db] could not switch to WAL; concurrent writes across processes will contend more');
}

export function initDb(): DatabaseSync {
  if (db) return db;
  fs.mkdirSync(config.dataDir, { recursive: true });
  const file = path.join(config.dataDir, 'agentlodge.db');
  db = new DatabaseSync(file);

  // WAL lets reads proceed alongside writes and lets several processes hold the file at
  // once — under compose the main service and the gateway are two containers sharing one
  // database.
  db.exec('pragma busy_timeout = 5000');
  ensureWal(db);

  // schema.sql lives under src/; the path is the same from dist/ because the build copies it
  const schemaPath = [
    path.join(here, 'schema.sql'),
    path.join(here, '../../../src/core/db/schema.sql'),
  ].find((p) => fs.existsSync(p));
  if (!schemaPath) throw new Error('schema.sql not found');

  /*
   * schema.sql is the **only** source the database is built from. There is no incremental
   * migration layer.
   *
   * There used to be one: a list of `alter table add column` statements and a few data
   * corrections, made idempotent by "run it again, catch the error, move on". One of those
   * corrections appended an `/anthropic` prefix to base_url and inferred whether it had
   * already run from the shape of the data — while initDb() is called on every process
   * start. So a correctly configured official-endpoint provider was rewritten into a
   * 404-producing path on the next restart.
   *
   * If a migration is genuinely needed, give it a real one-shot switch first: pragma
   * user_version, or a migrations table. Inferring "has this run" from what the data looks
   * like cannot work once new data can look like old data.
   */
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrate(db);
  console.log(`[db] ${file}`);
  return db;
}

/**
 * The one-shot switch the comment above asks for.
 *
 * `pragma user_version` is a counter SQLite keeps in the file itself, so "has this run" is
 * a fact rather than something inferred from what the data looks like — which is how the
 * previous migration layer rewrote a working configuration on every restart.
 *
 * A step only ever adds what is missing: schema.sql already builds a new database complete,
 * so the same code has to be a no-op there and a repair on an older file.
 */
const SCHEMA_VERSION = 7;

export function columns(d: DatabaseSync, table: string): Set<string> {
  return new Set(
    (d.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
  );
}

function migrate(d: DatabaseSync): void {
  const [row] = d.prepare('pragma user_version').all() as Array<{ user_version: number }>;
  const from = row?.user_version ?? 0;
  if (from >= SCHEMA_VERSION) return;

  if (from < 1) {
    /*
     * Quotas move from one period with one ceiling to three windows with three ceilings.
     * The old ceiling lands in whichever window its period resembles, so nobody's limit
     * quietly becomes unlimited; the other two start empty, which reads as "not limited on
     * that window" and is true.
     */
    const have = columns(d, 'user_quotas');
    for (const [name, type] of [
      ['limit_kind', "text not null default 'tokens'"],
      ['window_limit', 'integer'],
      ['week_limit', 'integer'],
      ['month_limit', 'integer'],
      ['boost_scope', 'text'],
      ['boost_amount', 'integer'],
      ['boost_until', 'text'],
    ] as const) {
      if (!have.has(name)) d.exec(`alter table user_quotas add column ${name} ${type}`);
    }

    // Only an old file has something to carry over
    if (have.has('token_limit')) {
      d.exec(`
        update user_quotas set
          week_limit = case when period = 'weekly'
            then (case when limit_kind = 'cost' then cost_limit_micro else token_limit end) end,
          month_limit = case when period <> 'weekly'
            then (case when limit_kind = 'cost' then cost_limit_micro else token_limit end) end
        where week_limit is null and month_limit is null
      `);
    }
  }

  if (from < 2) {
    // A recap of each conversation, so a portrait is built from a few lines each rather
    // than from every message ever sent
    const have = columns(d, 'conversations');
    for (const [name, type] of [
      ['summary', 'text'],
      ['summary_at', 'text'],
      // The message count the summary covers, so a conversation that has moved on is
      // recognised without comparing text
      ['summary_upto', 'integer'],
    ] as const) {
      if (!have.has(name)) d.exec(`alter table conversations add column ${name} ${type}`);
    }
  }

  if (from < 3) {
    // Titles start as the opening message and are replaced once there is a summary to
    // name the conversation by. One the user typed is theirs and stays.
    if (!columns(d, 'conversations').has('title_custom')) {
      d.exec('alter table conversations add column title_custom integer not null default 0');
    }
  }

  if (from < 4) {
    // A provider names a credential rather than carrying one. The two columns it used to
    // carry — an encrypted key and a path — are drained into the credential manager and
    // dropped on the gateway's next start; see gateway/legacy-keys.ts.
    if (!columns(d, 'upstream_providers').has('credential_id')) {
      d.exec('alter table upstream_providers add column credential_id text');
    }
  }

  if (from < 5) {
    /*
     * Models become the thing requests are routed by, and a provider stops being a global
     * switch. What each provider listed moves into rows of its own, in the order it was
     * written, so the picker keeps showing the same names in the same order.
     *
     * The defaults follow the same move: a provider carried one, and the two agents get
     * one each — from the row that was active, since that is the one those defaults were
     * written for.
     */
    const cols = columns(d, 'upstream_providers');
    if (cols.has('models')) {
      const rows = d
        .prepare('select id, models, default_model, active from upstream_providers')
        .all() as Array<{ id: string; models: string | null; default_model: string | null; active: number }>;
      const now = new Date().toISOString();
      for (const row of rows) {
        const names = (row.models ?? '').split(',').map((m) => m.trim()).filter(Boolean);
        names.forEach((name, i) => {
          d.prepare(
            `insert or ignore into models (id, name, provider_id, upstream_name, enabled, priority, created_at, updated_at)
             values (?, ?, ?, '', 1, ?, ?, ?)`,
          ).run(crypto.randomUUID(), name, row.id, i, now, now);
        });
      }
      const active = rows.find((r) => r.active === 1);
      const fallback = (active?.default_model ?? '').trim();
      if (fallback) {
        for (const key of ['agent.claude.defaultModel', 'agent.codex.defaultModel']) {
          d.prepare('insert or ignore into settings (key, value, updated_at) values (?, ?, ?)').run(key, fallback, now);
        }
      }
      d.exec('alter table upstream_providers drop column models');
      d.exec('alter table upstream_providers drop column default_model');
      d.exec('alter table upstream_providers drop column active');
    }

    // Which upstream served a call, and what that upstream charges: two providers can
    // offer one model at two prices, and neither the bill nor the report can be worked
    // out from the model name alone.
    if (!columns(d, 'usage_records').has('provider_id')) {
      d.exec('alter table usage_records add column provider_id text');
    }
    if (!columns(d, 'model_pricing').has('provider_id')) {
      d.exec('alter table model_pricing add column provider_id text');
    }
  }

  if (from < 6) {
    // When a model named the conversation. Null means never, and that is the whole
    // condition for naming it: it happens once, on the first turn, and never again.
    if (!columns(d, 'conversations').has('title_at')) {
      d.exec('alter table conversations add column title_at text');
    }
  }

  if (from < 7) {
    // The thinking switch. It defaults to on, so every conversation that already exists
    // gets the behaviour it had — the CLI asks for thinking on every request, and nothing
    // here has ever turned that off.
    if (!columns(d, 'conversations').has('thinking')) {
      d.exec('alter table conversations add column thinking integer not null default 1');
    }
  }

  d.exec(`pragma user_version = ${SCHEMA_VERSION}`);
  console.log(`[db] migrated ${from} → ${SCHEMA_VERSION}`);
}

export function closeDb(): void {
  db?.close();
  db = null;
}

/* ---------------- Query helpers ---------------- */

type Params = Array<string | number | null | bigint | Uint8Array>;

/** SQLite returns null-prototype rows; plain objects spread and serialise properly */
function plain<T>(row: unknown): T {
  return { ...(row as object) } as T;
}

export function all<T>(sql: string, ...params: Params): T[] {
  return getDb()
    .prepare(sql)
    .all(...params)
    .map((r) => plain<T>(r));
}

export function get<T>(sql: string, ...params: Params): T | undefined {
  const row = getDb()
    .prepare(sql)
    .get(...params);
  return row === undefined ? undefined : plain<T>(row);
}

export function run(sql: string, ...params: Params): { changes: number; lastInsertRowid: number | bigint } {
  const r = getDb()
    .prepare(sql)
    .run(...params);
  return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
}

/** Run a group of writes in one transaction; a throw rolls it back */
export function tx<T>(fn: () => T): T {
  const d = getDb();
  d.exec('BEGIN');
  try {
    const out = fn();
    d.exec('COMMIT');
    return out;
  } catch (err) {
    d.exec('ROLLBACK');
    throw err;
  }
}

/* ---------------- Conversions ---------------- */

export const bool = (v: unknown): boolean => v === 1 || v === true || v === '1';
export const flag = (v: boolean): number => (v ? 1 : 0);
export const nowIso = (): string => new Date().toISOString();

/** YYYY-MM-DD in the local timezone — a daily usage total has to agree with the date the user sees */
export function localDay(d: Date = new Date()): string {
  const off = d.getTimezoneOffset() * 60_000;
  return new Date(d.getTime() - off).toISOString().slice(0, 10);
}

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

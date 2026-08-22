import { DatabaseSync } from 'node:sqlite';
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
  console.log(`[db] ${file}`);
  return db;
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

export function run(sql: string, ...params: Params): { changes: number } {
  const r = getDb()
    .prepare(sql)
    .run(...params);
  return { changes: Number(r.changes) };
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

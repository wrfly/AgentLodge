/**
 * A database one version behind can still be opened.
 *
 * schema.test.ts checks that a fresh file has every migrated column. This is the other
 * direction, and the one that took the deployment down: an *older* file has to survive
 * schema.sql running over it.
 *
 * It did not. schema.sql indexes columns that migration steps add — parent_id on
 * conversations, provider_id on usage_records — and `create index` on a column the old
 * table has not got yet is an error. That error abandoned the rest of schema.sql and
 * migrate() with it, so the column was never added and the next start failed in the same
 * place. Not a bad upgrade but an unupgradable file: every start, for ever.
 *
 * So the old file is built by taking a fresh one apart — drop every column the migration
 * steps add, and the indexes that name them — and the check is that initDb() puts it all
 * back.
 *
 * Run: npm -w @agentlodge/server run test:upgrade
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-upgrade-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf8');
const added = [...source.matchAll(/alter table (\w+) add column (\w+)/g)].map((m) => ({
  table: m[1]!,
  column: m[2]!,
}));

// Build the file initDb() will open, then take it back to before those columns existed.
{
  const old = new DatabaseSync(path.join(box, 'agentlodge.db'));
  // Dropping a column makes SQLite re-parse the `create table` it has on file, and the
  // build in Node 22 reads a comment left at the end of that text as an unfinished
  // statement. parent_id is the last column of conversations and has one above it. This
  // database is scaffolding for the test, so it is built from the same DDL with the
  // comments taken out rather than from a schema.sql written around the parser.
  // Block comments come out first. A `--` inside one would otherwise take its closing
  // `*/` with it, and everything down to the next one stops being SQL.
  const bare = fs
    .readFileSync(path.join(here, 'schema.sql'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
  old.exec(bare);

  // SQLite refuses to drop a column an index names, which is the whole shape of the bug:
  // schema.sql carries indexes over columns that only a migration adds.
  const indexes = old
    .prepare("select name, sql from sqlite_master where type = 'index' and sql is not null")
    .all() as Array<{ name: string; sql: string }>;
  for (const { name, sql } of indexes) {
    const body = sql.slice(sql.indexOf('('));
    if (added.some((a) => new RegExp(`\\b${a.column}\\b`).test(body))) {
      old.exec(`drop index ${name}`);
    }
  }
  for (const { table, column } of added) {
    old.exec(`alter table ${table} drop column ${column}`);
  }

  old.exec('pragma user_version = 0');
  old.close();
}

console.log('\n=== initDb() opens a database from before the migrations ===');
const { initDb } = await import('./index.js');
let db: DatabaseSync | null = null;
try {
  db = initDb();
  ok('it opened without throwing', true);
} catch (err) {
  ok('it opened without throwing', false, String(err));
}

if (db) {
  const columns = (table: string): Set<string> =>
    new Set(
      (db!.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
    );

  console.log('\n=== Every column the migrations add is back ===');
  for (const { table, column } of added) {
    ok(`${table}.${column}`, columns(table).has(column));
  }

  console.log('\n=== And the indexes over them ===');
  {
    const have = new Set(
      (db.prepare("select name from sqlite_master where type = 'index'").all() as Array<{
        name: string;
      }>).map((r) => r.name),
    );
    for (const name of ['idx_conv_parent', 'idx_usage_provider_created', 'idx_pricing_model']) {
      ok(name, have.has(name));
    }
  }

  console.log('\n=== The version is stamped, so the next start does none of this ===');
  {
    const [row] = db.prepare('pragma user_version').all() as Array<{ user_version: number }>;
    const expected = Number(/const SCHEMA_VERSION = (\d+)/.exec(source)?.[1]);
    ok(`user_version is ${expected}`, row?.user_version === expected, String(row?.user_version));
  }

  db.close();
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

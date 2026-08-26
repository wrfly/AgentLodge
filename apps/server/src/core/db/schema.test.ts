/**
 * schema.sql builds a complete database on its own.
 *
 * migrate() says so in its own comment — "schema.sql already builds a new database
 * complete, so the same code has to be a no-op there and a repair on an older file" — and
 * that is not a style rule. A column that exists only as a migration step is one
 * short-circuit away from never being created: stamp user_version from schema.sql, skip
 * migrate() for a fresh file, and the first query against that column fails with
 * `no such column`. `title_at` shipped that way and nothing noticed, because a database
 * created before it was added takes the repair path and looks identical afterwards.
 *
 * So the check is mechanical: every `alter table X add column Y` in the migration steps
 * names a column a *fresh* database must already have.
 *
 * Run: npm -w @agentlodge/server run test:schema
 */
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-schema-')));

// Built from schema.sql and nothing else — deliberately not through initDb(), which runs
// migrate() as well. On a fresh file user_version is 0, so *every* step runs and a column
// the migration adds is indistinguishable from one schema.sql declares. Telling those two
// apart is the entire point of this file.
const db = new DatabaseSync(path.join(box, 'schema-only.db'));
db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));

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

function columns(table: string): Set<string> {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

console.log('\n=== Every migrated column is in schema.sql too ===');
{
  const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf8');
  const added = [...source.matchAll(/alter table (\w+) add column (\w+)/g)].map((m) => ({
    table: m[1]!,
    column: m[2]!,
  }));

  ok('the migration steps were found at all', added.length > 0, String(added.length));
  for (const { table, column } of added) {
    ok(`${table}.${column} exists in a fresh database`, columns(table).has(column));
  }
}

console.log('\n=== The steps run in ascending order ===');
{
  // Out of order they still all run, so nothing breaks today — but a later step that
  // depends on an earlier one silently sees the wrong shape, and the file stops being
  // readable as a history.
  const source = fs.readFileSync(path.join(here, 'index.ts'), 'utf8');
  const versions = [...source.matchAll(/if \(from < (\d+)\)/g)].map((m) => Number(m[1]));
  const sorted = [...versions].sort((a, b) => a - b);
  ok('ascending', JSON.stringify(versions) === JSON.stringify(sorted), JSON.stringify(versions));
}

db.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

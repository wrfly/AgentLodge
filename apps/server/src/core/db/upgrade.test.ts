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

  /*
   * A step that takes a column away cannot be tested by a fixture derived from the current
   * schema.sql: the column is not in there to begin with, so the step's own guard makes it a
   * no-op and the suite proves nothing about the only thing it does.
   *
   * So the columns migrations 17 and 19 remove go back in by hand, and a row goes in on top
   * of them. `auto_renew` is one of the six left over from the quota model migration 1
   * replaced — dropping those is the reason 17 rebuilds the table rather than dropping one
   * column. Deliberately not `token_limit`: that one is migration 1's own switch, and putting
   * it back would send this fixture down a data repair written for a database far older
   * than 16.
   */
  old.exec('alter table user_quotas add column reset_at text');
  old.exec('alter table user_quotas add column auto_renew integer');
  old.exec("alter table user_quotas add column limit_kind text not null default 'tokens'");
  old.exec('alter table usage_records add column billable_tokens integer not null default 0');
  /*
   * A catch-all price for 19 to convert against: it re-expresses a token ceiling in money at
   * the catch-all's input price. $2/MTok is 2 micro-units per thousand tokens, so the 5 M
   * ceiling below has to come out at 10 000 000 micro — $10.
   */
  old.exec(`
    insert into model_pricing
      (model, currency, price_input, price_cache_read, price_cache_write, price_output,
       effective_from, created_at)
    values ('*', 'USD', 2000000, 200000, 2500000, 10000000,
            '1970-01-01T00:00:00.000Z', '1970-01-01T00:00:00.000Z');
  `);
  old.exec(`
    insert into users (id, email, username, password_hash, role, status, created_at)
    values ('u-old', 'old@example.com', 'old', 'x', 'user', 'active', '2026-01-01T00:00:00.000Z');
    insert into user_quotas
      (user_id, limit_kind, window_limit, hard_stop, warned_period, reset_at, auto_renew,
       updated_at, updated_by)
    values ('u-old', 'tokens', 5000000, 1, 'window:2026-01-01T00:00:00.000Z',
            '2026-01-01T12:00:00.000Z', 1, '2026-01-01T00:00:00.000Z', 'u-admin');
  `);

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

  console.log('\n=== And the columns migrations 17 and 19 take away are gone, with the row intact ===');
  {
    const cols = columns('user_quotas');
    ok('reset_at is gone', !cols.has('reset_at'), [...cols].join(', '));
    ok('and so is auto_renew, left over from the quota model before this one',
      !cols.has('auto_renew'), [...cols].join(', '));
    ok('and limit_kind, which 19 takes away now that a ceiling has one unit',
      !cols.has('limit_kind'), [...cols].join(', '));
    ok('along with the token count it used to choose between',
      !columns('usage_records').has('billable_tokens'),
      [...columns('usage_records')].join(', '));
    ok('while the columns that are still used stayed',
      ['user_id', 'window_limit', 'week_limit', 'month_limit', 'hard_stop',
       'boost_scope', 'boost_amount', 'boost_until', 'warned_period', 'updated_at', 'updated_by']
        .every((c) => cols.has(c)), [...cols].join(', '));

    const row = db.prepare("select * from user_quotas where user_id = 'u-old'").get() as
      Record<string, unknown> | undefined;
    ok('the row survived the rebuild', row !== undefined, JSON.stringify(row));
    ok('with the rest of its values', row?.['warned_period'] === 'window:2026-01-01T00:00:00.000Z'
      && row?.['updated_by'] === 'u-admin' && row?.['hard_stop'] === 1, JSON.stringify(row));
    /*
     * And the ceiling itself is money now. Not cleared and not left as a token count: 5 M
     * tokens at the catch-all's $2/MTok is $10, and an operator who set a limit before this
     * migration should find a limit after it.
     */
    ok('the token ceiling was re-expressed in money, not dropped',
      row?.['window_limit'] === 10_000_000, String(row?.['window_limit']));

    /*
     * SQLite's `drop column` removes a span of the stored CREATE TABLE text, from the column's
     * name to the next one — which takes the following column's comment with it and leaves the
     * dropped column's comment attached to whatever came after. Measured. 17 rebuilds the
     * table instead, and this is what says so: the word must not survive anywhere in the DDL.
     */
    const [ddl] = db
      .prepare("select sql from sqlite_master where type = 'table' and name = 'user_quotas'")
      .all() as Array<{ sql: string }>;
    ok('and the table definition does not still mention it', !/reset_at/.test(ddl?.sql ?? ''),
      ddl?.sql ?? '');
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

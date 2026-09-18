import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, paths } from '../config.js';

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
  // WAL's default is a full fsync on every commit. NORMAL syncs at checkpoints instead,
  // which under WAL cannot corrupt the file: a power cut loses at most the last few
  // transactions — a handful of usage rows and a last-seen time — never the database.
  // The gateway writes a row per upstream call, so this is the difference between an
  // fsync per call and none.
  db.exec('pragma synchronous = normal');

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
  /*
   * An existing file is repaired *before* schema.sql runs over it.
   *
   * schema.sql indexes columns that a migration step adds — idx_conv_parent on
   * conversations(parent_id), idx_usage_provider_created on usage_records(provider_id).
   * `create index` on a column the old table has not got yet is an error, and an error
   * anywhere in schema.sql abandons the rest of the file, migrate() included. The column
   * then never gets added, so the next start fails in exactly the same place: a database
   * one version behind can never reach the current one.
   *
   * A file with no tables in it has nothing to repair. schema.sql builds it complete and
   * the call below only stamps the version, which is why that call stays where it is.
   */
  const existed = hasTables(db);
  if (existed) migrate(db);
  db.exec(fs.readFileSync(schemaPath, 'utf8'));
  migrate(db, { fresh: !existed });
  console.log(`[db] ${file}`);
  return db;
}

function hasTables(d: DatabaseSync): boolean {
  const [row] = d
    .prepare("select count(*) as n from sqlite_master where type = 'table' and name not like 'sqlite_%'")
    .all() as Array<{ n: number }>;
  return (row?.n ?? 0) > 0;
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
 *
 * Step 17 is the first that takes something away, and it is the reason to say what that costs:
 * a removal cannot be rolled back into. Stepping back to an earlier image leaves
 * `user_version` ahead of it, so this function returns without restoring anything, and the
 * older code then runs against a table it expects a column on. Reverting past a removal means
 * restoring the database with the image — `cli/backup-db.ts` is what makes that copy. Prefer
 * an additive step whenever one will do.
 */
const SCHEMA_VERSION = 21;

export function columns(d: DatabaseSync, table: string): Set<string> {
  return new Set(
    (d.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>).map((r) => r.name),
  );
}

/**
 * Every step, in one transaction, with the version read inside it.
 *
 * `app` and `gateway` are two processes over one file and compose starts them together, so
 * both arrive here at once. Read outside the lock, `user_version` is a fact about the past:
 * both see 18, both run every step, and each step's own `if (columns(...).has(...))` guard is
 * evaluated at one moment and acted on at another. Observed in production on the 18 → 20
 * upgrade — one process asked whether `billable_tokens` was there, the other dropped it, and
 * the first died on `no such column: billable_tokens`. It came back on the next start because
 * the version was current by then, but a step that had *not* finished would have crashed the
 * same way again, which is the crash loop this file already has one scar from.
 *
 * `begin immediate` takes the write lock up front rather than on the first write, so the
 * loser waits here instead of half way through. When it gets in, it re-reads the version,
 * finds it current, and does nothing. `busy_timeout` is set in initDb and applies to this.
 *
 * SQLite's DDL is transactional, so the table rebuilds and column drops below roll back with
 * everything else. That is also what makes a step that dies part-way leave no half-migration.
 */
function migrate(d: DatabaseSync, opts: { fresh?: boolean } = {}): void {
  d.exec('begin immediate');
  try {
    migrateInTx(d, opts);
  } catch (err) {
    d.exec('rollback');
    throw err;
  }
  d.exec('commit');
}

function migrateInTx(d: DatabaseSync, opts: { fresh?: boolean } = {}): void {
  // Inside the lock: what another process has already done is visible, and cannot change
  const [row] = d.prepare('pragma user_version').all() as Array<{ user_version: number }>;
  const from = row?.user_version ?? 0;
  if (from >= SCHEMA_VERSION) return;

  /*
   * A file schema.sql has just built is already current, and stamping it is the whole of
   * what this call is for on that path — the comment above initDb's second migrate() says
   * so, and every step below is written for a database that predates it.
   *
   * The schema steps would be harmless here: each one asks whether a column is missing and
   * a new file has them all. A step that writes **data** is not, and one did. Migration 13
   * prices DeepSeek, and on a new file it ran with nothing to repair, inserted its three
   * rows into an empty table, and left seedDefaults() looking at a table that was no longer
   * empty — so it returned without seeding, and the install came up with three DeepSeek
   * prices, no Claude prices and no '*' catch-all. Nothing failed: costMicro simply returned
   * 0 for every Claude model — and quota is money, so that traffic drew nothing against
   * anybody's ceiling either.
   */
  if (opts.fresh) {
    d.exec(`pragma user_version = ${SCHEMA_VERSION}`);
    return;
  }

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
      // The rows below are the first thing ever written to this table, and a file this old
      // predates it. schema.sql creates it too, but that runs after the repair on an
      // existing file — see initDb.
      d.exec(`create table if not exists models (
        id            text primary key,
        name          text not null,
        provider_id   text not null references upstream_providers(id) on delete cascade,
        upstream_name text not null default '',
        enabled       integer not null default 1,
        priority      integer not null default 0,
        note          text,
        created_at    text not null,
        updated_at    text not null,
        unique(name, provider_id)
      )`);
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

  if (from < 8) {
    /*
     * The default currency became USD, along with a price table seeded at the published
     * Anthropic rates. A table that already exists was written in whatever it was written
     * in — the old seed was CNY — and its rows carry that, so pin the setting to what is
     * actually in there rather than letting a changed default relabel somebody's money.
     *
     * Only when nobody has set it: an explicit choice outranks anything inferred.
     */
    const [chosen] = d.prepare("select value from settings where key = 'billing.currency'").all() as Array<{ value: string }>;
    if (!chosen) {
      const [row] = d
        .prepare('select currency from model_pricing group by currency order by count(*) desc limit 1')
        .all() as Array<{ currency: string }>;
      if (row?.currency) {
        d.prepare('insert into settings (key, value, updated_at) values (?, ?, ?)')
          .run('billing.currency', row.currency, new Date().toISOString());
      }
    }
  }

  if (from < 9) {
    // Refusals used to leave no trace at all; see the table's own comment for why it is not
    // a fourth status on usage_records
    d.exec(`create table if not exists quota_refusals (
      user_id      text not null references users(id) on delete cascade,
      window_start text not null,
      agent        text not null,
      scope        text not null,
      created_at   text not null,
      primary key (user_id, window_start)
    )`);
    d.exec('create index if not exists idx_refusal_window on quota_refusals(window_start)');
  }

  if (from < 10) {
    /*
     * Sweep up the empty conversations the old interface left behind.
     *
     * A row used to be posted the moment somebody opened the chat page, and again on every
     * press of "New chat", so a deployment of any age has a pile of them: "New chat", no
     * messages, nothing to read. Conversations are created by the first message now, so this
     * is a one-off tidy of what the previous rule accumulated, not a policy.
     *
     * **A conversation with files in its workspace is not empty**, whatever the message
     * count says. Attaching a file uploads it there and then, so a file attached and never
     * sent is a real thing somebody may be coming back for, and the row is their only handle
     * on it — deleting it here would strand the directory on disk for ever and take away the
     * one way to reach it. Hence the readdir: this step touches the filesystem because the
     * only alternative is losing somebody's files.
     */
    const orphans = d
      .prepare(
        `select id, user_id from conversations
          where not exists (select 1 from messages m where m.conversation_id = conversations.id)`,
      )
      .all() as Array<{ id: string; user_id: string }>;

    const drop = d.prepare('delete from conversations where id = ?');
    let removed = 0;
    let kept = 0;
    for (const row of orphans) {
      // Built here rather than borrowed from app/turns.ts: core may not depend on app, and
      // check-layers.mjs fails the build over it
      const dir = path.join(paths.workspaces, row.user_id, row.id);
      let empty: boolean;
      try {
        empty = fs.readdirSync(dir).length === 0;
      } catch {
        empty = true; // never had a workspace, which is the common case by far
      }
      if (empty) {
        drop.run(row.id);
        removed++;
      } else {
        kept++;
      }
    }
    if (removed || kept) {
      console.log(
        `[db] removed ${removed} conversation(s) with nothing in them` +
          (kept ? `; kept ${kept} that still hold uploaded files` : ''),
      );
    }
  }

  if (from < 11) {
    // An answer a user asked to replace: the CLI transcript cannot be edited, so the
    // gateway matches the discarded text in later requests and drops it. One row per
    // discarded answer; gone with the conversation.
    d.exec(`create table if not exists message_trims (
      conversation_id text not null references conversations(id) on delete cascade,
      match_text      text not null,
      created_at      text not null
    )`);
    d.exec('create index if not exists idx_trims_conv on message_trims(conversation_id)');
  }

  if (from < 12) {
    // A sub-conversation: a thread opened from a selection, sharing the parent's workspace
    // and CLI session rather than copying either. Old conversations have no parent, which
    // is exactly the "not a sub-conversation" reading of a null.
    if (!columns(d, 'conversations').has('parent_id')) {
      d.exec('alter table conversations add column parent_id text references conversations(id) on delete cascade');
      d.exec('create index if not exists idx_conv_parent on conversations(parent_id)');
    }
  }

  if (from < 13) {
    /*
     * DeepSeek changed its line-up on 2026-09-10 and the seeded prices predate it by five
     * months. seedDefaults() only runs on an empty table, so correcting it there fixes
     * nothing that already exists — and what already exists is costing `deepseek-flash`,
     * which has no row at all, at the catch-all rate of Claude Opus 5. That is $5/MTok
     * against a real $0.15: a bill thirty-three times too large, and a quota that refuses
     * people thirty-three times too early.
     *
     * The amounts are written out rather than imported from pricing.ts. Partly because
     * that module imports from this one, and mostly because a migration is a record of
     * what was done on a particular day: it must not change when the constants it once
     * agreed with are edited again.
     *
     * A row is only corrected if it still holds **exactly** what the old seed wrote. An
     * administrator who has already put their own number in has answered this question,
     * and a migration that overrides them would be a worse bug than the one it fixes.
     *
     * Correcting means adding a row, not rewriting one: `effective_from` is how this table
     * keeps a bill costed at the price of its day, and rewriting history would re-price
     * usage that was already charged.
     */
    const OFF_PEAK = 'Off-peak. DeepSeek doubles this Mon–Fri 01:00–04:00 and 06:00–10:00 UTC.';
    const FLASH = { in: 150_000, cacheRead: 3_000, cacheWrite: 150_000, out: 600_000 };
    const corrections = [
      // Never had a row: the id did not exist when the table was seeded
      { model: 'deepseek-flash', wasInput: null, ...FLASH, note: OFF_PEAK },
      // Seeded at April's preview price, which was half of what it costs
      {
        model: 'deepseek-v4-pro',
        wasInput: 435_000,
        in: 660_000,
        cacheRead: 22_000,
        cacheWrite: 660_000,
        out: 1_980_000,
        note: OFF_PEAK,
      },
      // Retired. The name still answers, and V4.1-Flash is what answers it
      {
        model: 'deepseek-v4-flash',
        wasInput: 220_000,
        ...FLASH,
        note: `Retired 2026-09-10 — served by V4.1-Flash and billed at its price. ${OFF_PEAK}`,
      },
    ];

    const now = new Date().toISOString();
    /*
     * The published DeepSeek rates are in US dollars, and this table is summed as if every
     * row were the same money — the seed says so in as many words. So on a deployment
     * billing in anything else, writing these numbers in is not a correction: it is two
     * currencies added together, which is a number with no meaning and no error attached.
     *
     * There is no conversion to make here either. A rate is a decision with a date on it
     * and nobody in this process has one. So the prices are named in the log and left to
     * the person who does.
     */
    const [cur] = d
      .prepare("select value from settings where key = 'billing.currency'")
      .all() as Array<{ value: string }>;
    const currency = cur?.value ?? 'USD';
    if (currency !== 'USD') {
      console.log(`[db] DeepSeek's 2026-09-10 rates are in USD and this table bills in ${currency},`);
      console.log('     so they have not been written in. Per million tokens, in USD:');
      console.log('       deepseek-flash    in 0.15  cache read 0.003  cache write 0.15  out 0.60');
      console.log('       deepseek-v4-pro   in 0.66  cache read 0.022  cache write 0.66  out 1.98');
      console.log(`     Convert at your own rate and add them under Settings → Price table.`);
    }

    for (const c of currency === 'USD' ? corrections : []) {
      const [row] = d
        .prepare(
          `select price_input as priceInput, currency from model_pricing
           where model = ? and provider_id is null
           order by effective_from desc limit 1`,
        )
        .all(c.model) as Array<{ priceInput: number; currency: string }>;

      // Present and already edited by hand — their number, their decision
      if (row && row.priceInput !== c.wasInput) continue;
      /*
       * Absent gets a row. A database seeded before these ids existed has no opinion about
       * them — it has an old `deepseek` row that catches them by prefix at a price meant
       * for a model two generations back. That legacy row is left alone: it is the
       * administrator's data, and once the three current ids match exactly it only answers
       * for names that are no longer served.
       */

      d.prepare(
        `insert into model_pricing
           (model, provider_id, currency, price_input, price_cache_read, price_cache_write,
            price_output, effective_from, note, created_at)
         values (?, null, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(c.model, currency, c.in, c.cacheRead, c.cacheWrite, c.out, now, c.note, now);
      console.log(`[db] priced ${c.model} at DeepSeek's 2026-09-10 rates${row ? '' : ' (was missing)'}`);
    }
  }

  if (from < 14) {
    /*
     * A price can now depend on the time of day, because one upstream's does: DeepSeek
     * charges double Mon–Fri 01:00–04:00 and 06:00–10:00 UTC. Until this column existed the
     * table held the off-peak number and a note saying it doubled, so a deployment serving
     * those hours billed half of what it was charged — and quota, which counts what a turn
     * cost, let everyone through at twice the intended rate for seven hours a day.
     *
     * Schema first, then the same data repair as migration 13 and on the same terms: only a
     * row still holding exactly what the seed wrote is touched, and the correction is a new
     * row rather than a rewrite. A fresh database never reaches here — see the guard at the
     * top of this function, which is what migration 13 taught.
     */
    const have = columns(d, 'model_pricing');
    if (!have.has('peak_multiplier')) {
      d.exec('alter table model_pricing add column peak_multiplier real not null default 1');
    }
    if (!have.has('peak_windows')) {
      d.exec('alter table model_pricing add column peak_windows text');
    }

    const WINDOWS = '{"days":[1,2,3,4,5],"hours":[[1,4],[6,10]]}';
    // The off-peak figures migration 13 wrote, in micro-units per million tokens
    const SEEDED = [
      { model: 'deepseek-flash', input: 150_000 },
      { model: 'deepseek-v4-pro', input: 660_000 },
      { model: 'deepseek-v4-flash', input: 150_000 },
    ];
    for (const s of SEEDED) {
      const [row] = d
        .prepare(
          `select id, price_input as priceInput, peak_multiplier as peak from model_pricing
           where model = ? and provider_id is null
           order by effective_from desc limit 1`,
        )
        .all(s.model) as Array<{ id: number; priceInput: number; peak: number }>;
      // Absent, edited by hand, or already carrying a schedule — all three are somebody
      // else's decision about this row
      if (!row || row.priceInput !== s.input || row.peak !== 1) continue;
      d.prepare('update model_pricing set peak_multiplier = 2, peak_windows = ? where id = ?')
        .run(WINDOWS, row.id);
      console.log(`[db] ${s.model} now doubles during DeepSeek's peak hours`);
    }
  }

  if (from < 15) {
    /*
     * Undo the damage migration 13 did to a table that does not bill in dollars.
     *
     * It wrote DeepSeek's published USD rates in, taking the currency from whatever row it
     * was correcting and falling back to 'USD' when there was none to correct — which for
     * `deepseek-flash`, the row that had never existed, was always. On a deployment billing
     * in CNY the result was three USD rows beside the yuan ones, and every consumer sums
     * `cost_micro` across the lot: a bill that is two currencies added together, a quota
     * counted in the same mixture, and nothing anywhere to say so.
     *
     * The repair is to take them back out, not to convert them — the rate is a decision
     * with a date on it and this process has neither. One consistent currency, even without
     * a DeepSeek price, beats a table whose total means nothing; without a row of its own
     * the model falls to the catch-all, which is where it was before 13 ran.
     *
     * Only rows still holding exactly what 13 wrote are removed, on the same principle as
     * 13 and 14: anything an administrator has touched is their answer, not ours.
     */
    const [cur] = d
      .prepare("select value from settings where key = 'billing.currency'")
      .all() as Array<{ value: string }>;
    const currency = cur?.value ?? 'USD';
    if (currency !== 'USD') {
      const WROTE = [
        { model: 'deepseek-flash', input: 150_000, output: 600_000 },
        { model: 'deepseek-v4-pro', input: 660_000, output: 1_980_000 },
        { model: 'deepseek-v4-flash', input: 150_000, output: 600_000 },
      ];
      let removed = 0;
      for (const w of WROTE) {
        removed += Number(
          d
            .prepare(
              /*
               * Matched on the amounts, not on the currency label.
               *
               * Migration 13 stamped these rows with `row?.currency ?? 'USD'` — the
               * currency of whatever row it was correcting. So on a CNY table the model
               * that already had a row (deepseek-v4-pro, at the old seeded 435000) got
               * DeepSeek's dollar amounts under a CNY label, and only the one that had
               * never existed got 'USD'. Constraining on 'USD' would leave the mislabelled
               * one behind — and being labelled consistently, it is invisible to the
               * mixed-currency banner too. This whole block only runs when the table does
               * not bill in dollars, so these exact amounts are 13's work either way.
               */
              `delete from model_pricing
               where model = ? and provider_id is null
                 and price_input = ? and price_output = ?`,
            )
            .run(w.model, w.input, w.output).changes,
        );
      }
      if (removed) {
        console.log(`[db] removed ${removed} USD price row(s) from a table billing in ${currency}`);
        console.log('     DeepSeek is unpriced again and falls to the catch-all. Its published');
        console.log('     rates per million tokens, in USD, to convert and enter yourself:');
        console.log('       deepseek-flash    in 0.15  cache read 0.003  cache write 0.15  out 0.60');
        console.log('       deepseek-v4-pro   in 0.66  cache read 0.022  cache write 0.66  out 1.98');
        console.log('     Both double Mon–Fri 01:00–04:00 and 06:00–10:00 UTC. The price form');
        console.log('     cannot express that yet — it shows a schedule but does not set one —');
        console.log('     so a row entered here bills the off-peak rate around the clock.');
      }
    }
  }

  if (from < 16) {
    /*
     * Being over the ceiling stops being a refusal and becomes a wait.
     *
     * Schema only — there is nothing to repair. Every refusal that has already happened is
     * a `quota_refusals` row and a message the person retyped; this table only holds what
     * arrives from here on.
     */
    d.exec(`
      create table if not exists deferred_turns (
        id              text primary key,
        user_id         text not null references users(id) on delete cascade,
        conversation_id text not null references conversations(id) on delete cascade,
        body            text not null,
        scope           text not null,
        release_at      text not null,
        created_at      text not null,
        unique (conversation_id)
      );
      create index if not exists idx_deferred_release on deferred_turns(release_at);
      create index if not exists idx_deferred_user on deferred_turns(user_id);
    `);
  }

  if (from < 17) {
    /*
     * Zeroing one account's usage is retired, and the column that recorded it goes with it.
     *
     * The windows a reset moved the count inside are the platform's — the same instants for
     * everybody — so forgiving one account put that account on a scale nobody else was on,
     * while the gate still enforced everyone else's. The way to let somebody through early is
     * a top-up, which says what it is, raises the ceiling rather than hiding the spend, and
     * expires on the window's own boundary.
     *
     * Removed rather than left null. A column nothing writes and three things read is how a
     * value comes back: `countStartOf` on the gate's path, the admin list's bar and the usage
     * page's "counting from" caption all consulted it, and all of them go in this change.
     *
     * **This is the first step here that takes something away, so it is the first that cannot
     * be rolled back into.** Going back to the previous image leaves `user_version` at 17, so
     * `migrate()` returns immediately and never puts the column back — and the old top-up
     * route writes to it, which is then a 500 on every grant. Going back means restoring the
     * database alongside the image; `cli/backup-db.ts` is what makes that copy.
     *
     * Rebuilt rather than `alter table drop column`. SQLite implements the drop by deleting a
     * span of the stored CREATE TABLE text, and the span runs from the column's name to the
     * next one — which here swallows `warned_period`'s comment and leaves this column's
     * comment sitting on top of it. Measured on a real file. The table is small and rebuilding
     * it leaves a definition that still matches schema.sql.
     */
    if (columns(d, 'user_quotas').has('reset_at')) {
      /*
       * Said out loud, with a count, because this is forgiveness being taken back: an account
       * zeroed inside a window still running goes back to counting the whole window, which can
       * put it over its ceiling on the next turn. Nobody can reconstruct the list afterwards,
       * so the number has to be printed before the column goes.
       */
      const [row] = d
        .prepare('select count(*) as n from user_quotas where reset_at is not null')
        .all() as Array<{ n: number }>;
      const forgiven = row?.n ?? 0;
      if (forgiven > 0) {
        console.log(
          `[db] ${forgiven} account(s) had a manual usage reset; it no longer applies and ` +
            'they now count the whole window. Top up anyone this puts over their ceiling.',
        );
      }

      /*
       * The twelve columns schema.sql declares, in its order. An upgraded file also carries
       * six from the quota model this one replaced — `token_limit`, `period`, `period_hours`,
       * `cycle_start`, `auto_renew`, `cost_limit_micro` — which migration 1 drained into the
       * three ceilings and nothing has read since. Naming the live set carries them out too,
       * which is the point of rebuilding rather than dropping one column at a time.
       *
       * `pragma foreign_keys` is never turned on in this process, so `drop table` here cannot
       * cascade into anything; the `references` clause is documentation either way.
       */
      d.exec(`
        create table user_quotas_new (
          user_id      text primary key references users(id) on delete cascade,
          -- tokens limits by billable tokens; cost limits by money in micro-units
          limit_kind   text not null default 'tokens',
          -- Three ceilings, all in the unit named above, all null-means-unlimited, all over
          -- windows that are the platform's rather than each user's
          window_limit integer,
          week_limit   integer,
          month_limit  integer,
          hard_stop    integer not null default 1,
          -- A top-up raises one window's ceiling, and expires with that window
          boost_scope  text,                    -- window | week | month
          boost_amount integer,
          boost_until  text,                    -- the window's end at the moment it was granted
          -- Which window a warning email has gone out for, so one window does not nag twice
          warned_period text,
          updated_at   text not null,
          updated_by   text
        );
        insert into user_quotas_new
          (user_id, limit_kind, window_limit, week_limit, month_limit, hard_stop,
           boost_scope, boost_amount, boost_until, warned_period, updated_at, updated_by)
        select
           user_id, limit_kind, window_limit, week_limit, month_limit, hard_stop,
           boost_scope, boost_amount, boost_until, warned_period, updated_at, updated_by
        from user_quotas;
        drop table user_quotas;
        alter table user_quotas_new rename to user_quotas;
      `);
    }
  }

  if (from < 18) {
    /*
     * Which money a usage row's cost is in.
     *
     * Vendors price in their own currency and the price table now holds each at its own list
     * — Anthropic in dollars, DeepSeek in yuan — so `sum(cost_micro)` is only meaningful
     * grouped by this. Additive, and the default is the currency every existing row was
     * priced in before there was a choice.
     *
     * The stored amounts themselves are restated separately, at startup, by
     * `usage.repriceHistory()`: it needs `resolve()`'s prefix matching and peak windows, which
     * belong to pricing.ts and cannot be reached from here without a cycle.
     */
    if (!columns(d, 'usage_records').has('cost_currency')) {
      d.exec("alter table usage_records add column cost_currency text not null default 'USD'");
    }
    // schema.sql indexes it, and schema.sql runs *after* this on an existing file — but the
    // index has to survive a file that reaches here with the column already added
    d.exec('create index if not exists idx_usage_cost_currency on usage_records(cost_currency)');
  }

  if (from < 19) {
    /*
     * A ceiling is an amount of money, and there is no second kind.
     *
     * Quota used to be counted in "billable tokens" — the four token counts, weighted — which
     * was a way to make an expensive model draw more of an allowance than a cheap one without
     * putting money on the gate's path. It stopped working when two vendors began billing in
     * two currencies: a token count cannot carry a price, and every way of making it try
     * either flattened the models it was meant to separate or moved everybody's ceiling when
     * an exchange rate did. The thing that number was approximating is the bill, so the bill
     * is what the gate counts now.
     *
     * Two columns go: `usage_records.billable_tokens`, which nothing computes any more, and
     * `user_quotas.limit_kind`, which named a fork that has one side left. The global default
     * a new account starts with is converted and renamed along with them.
     *
     * The ceilings themselves have to be **re-expressed**, not just relabelled. Left alone, a
     * window limit of 20,000,000 — twenty million tokens — would be read as twenty million
     * micro-units, which is twenty of whatever the settlement currency is, and an account
     * would go from a comfortable allowance to one a single turn could exhaust. They are
     * converted at the catch-all's input price, which is what a billable token was defined as
     * meaning: one input token at the standard rate. Every conversion is printed, because it
     * is an approximation of somebody's intent and they should check it.
     */
    if (columns(d, 'user_quotas').has('limit_kind')) {
      /*
       * This is a **non-idempotent** transform — it multiplies each ceiling by a price — so
       * running it twice is not a no-op but a second multiplication: a 5 M ceiling at 2
       * micro/token would go 10 M, then 20 M. `migrate()` holds one transaction around every
       * step for exactly this, and the guard above is read inside it.
       */
      /*
       * A catch-all to convert against, even on a database that has none.
       *
       * `seedDefaults()` does not run until the service is up, which is after this — and
       * seed.test.ts documents a real deployment that reached this point with no '*' row at
       * all, because migration 13 filled an empty table and the seed then declined to. On
       * that file every ceiling would convert to null. Clearing a limit is the safe direction
       * for *one* account, but doing it to every account and to the global default at once,
       * unrecoverably, is not safe at all — the original numbers only exist in the column
       * this step is about to drop.
       *
       * So the step supplies the row itself, at the same $5/$25 the seed uses, backdated the
       * way a backfill is. `seedDefaults()` sees a '*' and leaves it alone.
       */
      let [unit] = d
        .prepare(`select price_input, currency from model_pricing
                   where model = '*' and provider_id is null
                   order by effective_from desc limit 1`)
        .all() as Array<{ price_input: number; currency: string }>;
      if (!unit) {
        d.prepare(
          `insert into model_pricing
             (model, provider_id, currency, price_input, price_cache_read, price_cache_write,
              price_output, effective_from, note, created_at)
           values ('*', null, 'USD', 5000000, 500000, 6250000, 25000000,
                   '1970-01-01T00:00:00.000Z', ?, ?)`,
        ).run(
          'The catch-all, used by any model without a price of its own. Added by migration 19, '
            + 'which had no price to re-express the ceilings against.',
          new Date().toISOString(),
        );
        unit = { price_input: 5_000_000, currency: 'USD' };
        console.log("[db] no '*' catch-all to convert ceilings against; seeded one at $5/$25 per MTok");
      }

      /*
       * **The catch-all is not necessarily in the money a ceiling is counted in.** The
       * deployment this was written for settles in USD and its catch-all is a ¥2/MTok row
       * left over from when the whole seed was in yuan — so converting at it and stopping
       * there would write a yuan figure into a column the gate reads as dollars, and every
       * converted ceiling would be wrong by the exchange rate. Found by running this
       * migration against a copy of that database before deploying it.
       *
       * So the price is settled the same way a bill is: at `billing.rates`, the one place in
       * the system an exchange rate is allowed to appear. A currency with no rate is left at
       * par, which is what `settle()` does and says in its log.
       */
      const settlement =
        (d.prepare("select value from settings where key = 'billing.currency'").get() as
          { value: string } | undefined)?.value || 'USD';
      let rates: Record<string, number> = {};
      try {
        rates = JSON.parse(
          (d.prepare("select value from settings where key = 'billing.rates'").get() as
            { value: string } | undefined)?.value ?? '{}',
        ) as Record<string, number>;
      } catch {
        // A malformed rates setting is the console's problem; at par is the safe reading here
      }
      const rate =
        !unit || unit.currency === settlement ? 1 : (Number(rates[unit.currency]) || 1);

      /*
       * Micro-units of the settlement currency per token, at the catch-all rate. A table with
       * no catch-all cannot price anything at all, so there is nothing to convert against —
       * the ceilings are cleared rather than turned into a number with no meaning, which is
       * the safe direction: an account with no ceiling is not refused.
       */
      const perToken = unit ? (unit.price_input / 1_000_000) * rate : 0;
      if (unit && unit.currency !== settlement) {
        console.log(
          `[db] the catch-all price is in ${unit.currency} and ceilings are counted in ` +
            `${settlement}; converting at ${rate}${rates[unit.currency] ? '' : ' (no rate configured — at par)'}`,
        );
      }

      /*
       * `boost_amount` is converted with the ceilings, because it is added to one.
       *
       * A top-up is granted in whatever unit the ceiling is in — `effectiveCeiling` returns
       * `ceiling + boost` — so a live one left as a token count would be added to a figure in
       * money. At the $5/MTok catch-all a 5 M-token top-up meant $25 and would apply as $5.
       * It expires on its window's own boundary, so at most a few hours of them are live, but
       * "at most a few hours" is not none.
       */
      const rows = d
        .prepare(`select q.user_id, us.username, q.limit_kind,
                         q.window_limit, q.week_limit, q.month_limit, q.boost_amount
                    from user_quotas q left join users us on us.id = q.user_id
                   where q.window_limit is not null or q.week_limit is not null
                      or q.month_limit is not null or q.boost_amount is not null`)
        .all() as Array<{
          user_id: string; username: string | null; limit_kind: string;
          window_limit: number | null; week_limit: number | null; month_limit: number | null;
          boost_amount: number | null;
        }>;

      for (const r of rows) {
        // A row already counted in money keeps its numbers; only the token ones are converted
        if (r.limit_kind === 'cost') continue;
        const to = (v: number | null): number | null =>
          v === null ? null : Math.round(v * perToken);
        const next = { window: to(r.window_limit), week: to(r.week_limit), month: to(r.month_limit) };
        d.prepare(`update user_quotas
                      set window_limit = ?, week_limit = ?, month_limit = ?, boost_amount = ?
                    where user_id = ?`)
          .run(next.window, next.week, next.month, to(r.boost_amount), r.user_id);
        const say = (before: number | null, after: number | null) =>
          before === null ? '—' : `${before.toLocaleString()} → ${after === null ? 'unlimited' : (after / 1_000_000).toFixed(2)}`;
        console.log(
          `[db] ${r.username ?? r.user_id} ceilings re-expressed in money: ` +
            `5h ${say(r.window_limit, next.window)}, week ${say(r.week_limit, next.week)}, ` +
            `month ${say(r.month_limit, next.month)}. Check them in the console.`,
        );
      }

      /*
       * An invite's preset is the same number for a new account's monthly ceiling, so it is
       * the same conversion. The column keeps its name — renaming it is a second rebuild for
       * no behaviour — and schema.sql says what it holds.
       */
      d.prepare(`update invite_codes
                    set preset_token_limit = cast(round(preset_token_limit * ?) as integer)
                  where preset_token_limit is not null`)
        .run(perToken);

      /*
       * And the global default a new account starts with. Renamed as well as converted:
       * `quota.defaultTokenLimit` under a value in money is a trap for whoever reads it
       * next, and the console's field is labelled from the key's spec.
       */
      const def = d
        .prepare("select value from settings where key = 'quota.defaultTokenLimit'")
        .get() as { value: string } | undefined;
      if (def) {
        d.prepare("delete from settings where key = 'quota.defaultTokenLimit'").run();
        const n = Number(def.value);
        if (Number.isFinite(n) && n > 0 && perToken > 0) {
          d.prepare(
            `insert into settings (key, value, updated_at) values ('quota.defaultLimit', ?, ?)
             on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
          ).run(String(Math.round(n * perToken)), new Date().toISOString());
          console.log(
            `[db] default quota for new users re-expressed in money: ${(n * perToken / 1_000_000).toFixed(2)}`,
          );
        }
      }

      /*
       * And the two weights, whose specs are gone. `listSettings()` iterates the specs, so a
       * row without one can never be seen or cleared from the console — it just sits there
       * looking live, describing an accounting model that no longer exists.
       */
      const orphans = d
        .prepare("delete from settings where key in ('quota.weightCacheRead', 'quota.weightOutput')")
        .run().changes;
      if (orphans) console.log(`[db] removed ${orphans} setting(s) for the retired token weights`);

      /*
       * Rebuilt rather than `alter table drop column`: SQLite implements the drop by deleting
       * a span of the stored CREATE TABLE text, from the column's name to the next one, which
       * takes the following column's comment with it. Measured, in migration 17.
       */
      d.exec(`
        create table user_quotas_new (
          user_id      text primary key references users(id) on delete cascade,
          window_limit integer,
          week_limit   integer,
          month_limit  integer,
          hard_stop    integer not null default 1,
          boost_scope  text,
          boost_amount integer,
          boost_until  text,
          warned_period text,
          updated_at   text not null,
          updated_by   text
        );
        insert into user_quotas_new
          (user_id, window_limit, week_limit, month_limit, hard_stop,
           boost_scope, boost_amount, boost_until, warned_period, updated_at, updated_by)
        select
           user_id, window_limit, week_limit, month_limit, hard_stop,
           boost_scope, boost_amount, boost_until, warned_period, updated_at, updated_by
        from user_quotas;
        drop table user_quotas;
        alter table user_quotas_new rename to user_quotas;
      `);
    }

    /*
     * The token count itself. Nothing reads it, and a column nothing writes and something
     * still reads is how a retired idea comes back — migration 17 says the same thing about
     * `reset_at`. `usage_records` is the large table, so this one is a plain drop: it has no
     * comment after it to lose, being the last of the cost columns.
     */
    if (columns(d, 'usage_records').has('billable_tokens')) {
      d.exec('alter table usage_records drop column billable_tokens');
    }
  }

  if (from < 20) {
    /*
     * DeepSeek, priced twice — in two currencies, with the wrong one winning.
     *
     * The seed was briefly USD-only, and it wrote DeepSeek's yuan figures into USD rows:
     * ¥1/MTok became $0.15 and so on. Correcting the seed added CNY rows, and because they
     * are a backfill rather than a price change they are stamped 1970 so that history can be
     * recosted against them (pricing.ts says why). But `resolve()` orders by `effective_from
     * desc` and takes the first exact match — so the *stale* USD rows, stamped the day they
     * were written, win over the corrected ones, for ever. Nothing looks wrong in the price
     * table: both rows are there, and the console lists them.
     *
     * Verified on the deployment this was written for, with the real resolver:
     *
     *     deepseek-flash    -> id=3 USD in=150000     (stale)
     *     deepseek-v4-pro   -> id=4 USD in=660000     (stale)
     *     deepseek-v4-flash -> id=5 USD in=150000     (stale)
     *
     * A model has one vendor and one billing currency, so a *global* row in the wrong one is
     * always a leftover and never a choice. Per-provider rows are left alone — the same model
     * on two upstreams can genuinely cost two different things — and so is the '*' catch-all,
     * whose currency is a separate decision with a separate blast radius.
     *
     * Named explicitly rather than derived from the seed: a migration is a statement about
     * one historical defect, and the seed it would read is free to change underneath it.
     */
    const stale = d
      .prepare(`select id, model, currency, price_input from model_pricing
                 where provider_id is null
                   and model in ('deepseek-flash', 'deepseek-v4-pro', 'deepseek-v4-flash')
                   and currency <> 'CNY'`)
      .all() as Array<{ id: number; model: string; currency: string; price_input: number }>;
    for (const r of stale) {
      console.log(
        `[db] removing a stale ${r.currency} price for ${r.model} ` +
          `(${r.price_input / 1_000_000} per MTok); its CNY row is the vendor's own`,
      );
    }
    if (stale.length) {
      d.prepare(
        `delete from model_pricing
          where id in (${stale.map(() => '?').join(', ')})`,
      ).run(...stale.map((r) => r.id));
    }
  }

  if (from < 21) {
    /*
     * One rate, in the direction people say it out loud.
     *
     * `billing.rates` was a JSON object of currency → how many settlement units one of it is
     * worth. More general than a two-vendor deployment needs, and it invites two mistakes the
     * shape cannot report: an entry for the settlement currency itself, which is dead code in
     * `settle()`, and a rate written upside down, which looks perfectly plausible. The
     * deployment this was written for carried `{"USD":6.75,"CNY":0.148148}` while settling in
     * USD — the USD entry inert, the CNY one the reciprocal of the number anybody would say.
     *
     * So: one number, `billing.cnyPerUsd`, read as "how many yuan one dollar is worth".
     * Whichever way the settlement currency points, that relates the two.
     */
    const rates = d
      .prepare("select value from settings where key = 'billing.rates'")
      .get() as { value: string } | undefined;
    if (rates) {
      const settlement =
        (d.prepare("select value from settings where key = 'billing.currency'").get() as
          { value: string } | undefined)?.value || 'USD';
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(rates.value) as Record<string, unknown>;
      } catch {
        // A malformed setting carries no rate to keep; the default takes over
      }
      /*
       * Read from whichever entry was the live one. Settling in USD, the CNY entry held
       * "dollars per yuan" and the rate wanted is its reciprocal; settling in CNY, the USD
       * entry already held yuan per dollar. The entry matching the settlement currency is
       * ignored — `settle()` never read it either.
       */
      const usd = Number(parsed['USD']);
      const cny = Number(parsed['CNY']);
      let carried: number | null = null;
      if (settlement === 'CNY' && Number.isFinite(usd) && usd > 0) carried = usd;
      else if (settlement !== 'CNY' && Number.isFinite(cny) && cny > 0) carried = 1 / cny;

      d.prepare("delete from settings where key = 'billing.rates'").run();
      if (carried !== null) {
        // Four places: 0.148148 inverts to 6.7500045, and nobody typed that
        const value = String(Number(carried.toFixed(4)));
        d.prepare(
          `insert into settings (key, value, updated_at) values ('billing.cnyPerUsd', ?, ?)
           on conflict(key) do update set value = excluded.value, updated_at = excluded.updated_at`,
        ).run(value, new Date().toISOString());
        console.log(`[db] exchange rate carried over as billing.cnyPerUsd = ${value}`);
      } else {
        console.log(
          '[db] billing.rates held no rate between CNY and USD; billing.cnyPerUsd falls back to '
            + 'its default. Check it in the console.',
        );
      }
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

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from '../core/config.js';

/**
 * A backup that can actually be restored.
 *
 * The obvious thing — `cp agentlodge.db somewhere` — does not work here, and it fails in
 * the way that only shows up on the day you need it. The database runs in WAL mode, so at
 * any moment some committed transactions live in `agentlodge.db-wal` and not yet in the
 * main file. Copying the three files one at a time copies them at three different
 * instants; what comes back is a main file from one moment and a write-ahead log from
 * another, and SQLite is entitled to refuse the pair.
 *
 * `VACUUM INTO` is the fix and it is one statement: SQLite reads the database inside a
 * transaction and writes a complete, defragmented, consistent copy to a new file. No
 * external `sqlite3` binary, no stopping the service, no reaching into the WAL.
 *
 *   docker exec agentlodge-app-1 node apps/server/dist/cli/backup-db.js
 *   docker exec agentlodge-app-1 node apps/server/dist/cli/backup-db.js --keep 30
 *   npm -w @agentlodge/server run backup-db
 *
 * Run it from cron on the host. Once a day is enough for a database this size; the copy
 * takes well under a second at 36 MB and the retention below keeps the directory bounded:
 *
 *   17 4 * * *  docker exec agentlodge-app-1 node apps/server/dist/cli/backup-db.js >> /var/log/agentlodge-backup.log 2>&1
 *
 * **The copies sit beside the original.** That protects against the database being
 * corrupted or a migration going wrong; it protects against nothing that happens to the
 * disk. Getting them onto another machine is a separate job and this command deliberately
 * does not guess how — it prints the path it wrote so that whatever does can pick it up.
 */

const DEFAULT_KEEP = 14;

/**
 * Both spellings, because this runs from cron and the wrong one is silent.
 *
 * `--keep 30` was the only form understood, so `--keep=30` — the spelling half the world
 * reaches for — left keepRaw at the default and the command went on to delete the copies
 * the operator had just asked to keep, with nothing in the log to distinguish it from
 * success. A bare trailing `--keep` did the same.
 */
function arg(name: string): string | undefined {
  const joined = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (joined) return joined.slice(name.length + 3);
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return undefined;
  const next = process.argv[i + 1];
  // `--keep` with nothing after it is a mistake, not a request for the default
  return next === undefined || next.startsWith('--') ? '' : next;
}

const keepRaw = arg('keep') ?? String(DEFAULT_KEEP);
const keep = Number(keepRaw);
if (!Number.isInteger(keep) || keep < 1) {
  console.error(`--keep wants a whole number of copies to retain, not ${keepRaw}`);
  process.exit(2);
}

const source = path.join(config.dataDir, 'agentlodge.db');
if (!fs.existsSync(source)) {
  console.error(`no database at ${source} — is DATA_DIR right?`);
  process.exit(1);
}

const dir = path.join(config.dataDir, 'db-backup');
fs.mkdirSync(dir, { recursive: true });

// Sortable, and legible without converting anything: 2026-09-14T2231
const stamp = new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, '').replace(/:/g, '');
const target = path.join(dir, `agentlodge-${stamp}.db`);
if (fs.existsSync(target)) {
  console.error(`${target} already exists — a backup this minute has already been taken`);
  process.exit(1);
}

/*
 * Opened read-only on purpose. VACUUM INTO only reads the source, and a backup command
 * that cannot write is a backup command that cannot damage the thing it is backing up —
 * including by running a schema migration, which is what opening through initDb() would do.
 *
 * The price is stated rather than hidden: a WAL database whose last writer died without
 * closing cleanly — a killed container, an OOM, a host that rebooted — needs its log
 * replayed before it can be read, and a read-only handle cannot do that. SQLite answers
 * SQLITE_READONLY_RECOVERY, which is exactly the situation somebody is in when they go
 * looking for a backup. So the error says what it means and what to do about it, instead
 * of arriving as a bare SQLite code in a cron log.
 */
const db = new DatabaseSync(source, { readOnly: true });
try {
  // The path is a value, not a fragment of SQL: a data directory with a quote in it would
  // otherwise end the string and change the statement.
  db.prepare('vacuum into ?').run(target);
} catch (err) {
  // The one failure worth translating: a database left mid-transaction by a writer that
  // died. Read-only cannot replay the log, and the bare SQLite code says nothing useful
  // from a cron log at four in the morning.
  if (String(err).includes('READONLY_RECOVERY') || String(err).includes('recovery')) {
    fs.rmSync(target, { force: true });
    console.error(
      `${source} needs its write-ahead log replayed before it can be read, which a`
      + ' read-only backup cannot do. Start the service (or open the file once with a'
      + ' writable client) and run this again.',
    );
    process.exit(1);
  }
  /*
   * A half-written copy is worse than none. VACUUM INTO that runs out of disk — the
   * realistic failure on a volume that also holds the database and a fortnight of these —
   * leaves the target behind, and everything downstream treats it as the newest good
   * backup: it matches the retention glob, so it evicts a real one, and it sorts last, so
   * it is the file a restore reaches for first.
   */
  fs.rmSync(target, { force: true });
  throw err;
} finally {
  db.close();
}

const size = fs.statSync(target).size;
console.log(`${target}  ${(size / 1e6).toFixed(1)} MB`);

/* ---- retention ---- */

const copies = fs
  .readdirSync(dir)
  .filter((f) => /^agentlodge-.*\.db$/.test(f))
  .sort();

const stale = copies.slice(0, Math.max(0, copies.length - keep));
for (const f of stale) {
  fs.rmSync(path.join(dir, f));
  console.log(`removed ${f}`);
}
console.log(`${copies.length - stale.length} kept, ${stale.length} removed`);

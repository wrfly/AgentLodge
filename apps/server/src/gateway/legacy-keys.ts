import { all, columns, get, getDb, run } from '../core/db/index.js';
import { decrypt } from '../core/db/settings.js';
import * as credentialManager from '../core/credential-manager.js';

/**
 * Moving what a database already holds into the credential manager, once.
 *
 * A provider used to carry its key two ways: encrypted in `api_key`, or as a path in
 * `api_key_file`. Both columns are gone from schema.sql, so a new database never has
 * them — but an existing one still does, with values in it that a deployment depends on.
 *
 * This runs from the gateway rather than from initDb, because it is the process that can
 * reach the credential manager. It is idempotent by construction: the columns are dropped
 * once nothing is left in them, and a database without the columns returns immediately.
 *
 * When there is nothing to reach, nothing is destroyed — the values stay where they are
 * and the next start tries again. What the deployment sees in the meantime is providers
 * with no credential, which the console shows and the gateway refuses; that is the honest
 * state for "the service holding the keys is not running".
 */

interface LegacyRow {
  id: string;
  name: string;
  api_key: string | null;
  api_key_file: string | null;
  credential_id: string | null;
}

/** A credential id from a provider name: what an administrator will recognise in the list */
function credentialIdFor(name: string, fallback: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return slug || `provider-${fallback.slice(0, 8)}`;
}

export async function drainLegacyProviderKeys(log: (message: string) => void): Promise<void> {
  const db = getDb();
  const cols = columns(db, 'upstream_providers');
  const hasKey = cols.has('api_key');
  const hasFile = cols.has('api_key_file');
  if (!hasKey && !hasFile) return;

  const select = ['id', 'name', 'credential_id']
    .concat(hasKey ? ['api_key'] : [])
    .concat(hasFile ? ['api_key_file'] : [])
    .join(', ');
  const rows = all<LegacyRow>(`select ${select} from upstream_providers`);
  const pending = rows.filter((r) => !r.credential_id && (r.api_key || r.api_key_file));

  // An old deployment configured before the provider table existed keeps its key in a
  // setting or in the environment; seedFromSettings made the row, this brings the value.
  const orphanKey = decrypt(get<{ value: string }>('select value from settings where key = ?', 'deepseek.apiKey')?.value ?? '')
    ?? process.env.DEEPSEEK_API_KEY;

  if (pending.length === 0 && !orphanKey) {
    dropColumns(hasKey, hasFile, log);
    return;
  }

  if (!credentialManager.isConfigured()) {
    log(
      `${pending.length} upstream key(s) are still stored in the database and no credential manager is configured. `
      + 'Start the credential-manager service and restart; until then those providers have no credential.',
    );
    return;
  }

  for (const row of pending) {
    const id = credentialIdFor(row.name, row.id);
    try {
      if (row.api_key_file) {
        await credentialManager.storeKeyFile({ id, label: row.name, path: row.api_key_file });
      } else {
        const value = decrypt(row.api_key ?? '');
        if (!value) {
          log(`upstream "${row.name}": its stored key could not be decrypted, so it was left alone`);
          continue;
        }
        await credentialManager.storeApiKey({ id, label: row.name, apiKey: value });
      }
      // Cleared in the same statement that records where it went: a row that names a
      // credential and still carries the old value is two answers to one question
      run(
        `update upstream_providers set credential_id = ?${hasKey ? ', api_key = null' : ''}${hasFile ? ', api_key_file = null' : ''} where id = ?`,
        id,
        row.id,
      );
      log(`upstream "${row.name}": its key moved to the credential manager as "${id}"`);
    } catch (e) {
      log(`upstream "${row.name}": moving its key failed — ${(e as Error).message}`);
      return; // leave everything else alone; the next start tries again
    }
  }

  if (orphanKey) {
    // The first provider still without a credential: that key belonged to whichever
    // upstream the deployment was using, and a database this old has one.
    const target = get<LegacyRow>(
      'select id, name, credential_id from upstream_providers where credential_id is null order by created_at limit 1',
    );
    if (target && !target.credential_id) {
      const id = credentialIdFor(target.name, target.id);
      try {
        await credentialManager.storeApiKey({ id, label: target.name, apiKey: orphanKey });
        run('update upstream_providers set credential_id = ? where id = ?', id, target.id);
        log(`upstream "${target.name}": the key from the old settings moved to the credential manager as "${id}"`);
      } catch (e) {
        log(`upstream "${target.name}": moving the key from the old settings failed — ${(e as Error).message}`);
        return;
      }
    }
  }

  // Only once nothing is left to lose
  const conditions = [hasKey ? 'api_key is not null' : '', hasFile ? 'api_key_file is not null' : '']
    .filter(Boolean)
    .join(' or ');
  const left = get<{ n: number }>(`select count(*) as n from upstream_providers where ${conditions}`)?.n ?? 0;
  if (left === 0) dropColumns(hasKey, hasFile, log);
  else log(`${left} upstream key(s) could not be moved and are still in the database`);
}

function dropColumns(hasKey: boolean, hasFile: boolean, log: (message: string) => void): void {
  const db = getDb();
  try {
    if (hasKey) db.exec('alter table upstream_providers drop column api_key');
    if (hasFile) db.exec('alter table upstream_providers drop column api_key_file');
    log('the upstream table no longer carries keys; those columns are gone');
  } catch (e) {
    // Not fatal: nothing reads them any more. Worth saying, because a column that will
    // not drop usually means an old SQLite, and the operator may want to know.
    log(`the legacy key columns could not be dropped: ${(e as Error).message}`);
  }
}

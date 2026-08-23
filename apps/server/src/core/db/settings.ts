import crypto from 'node:crypto';
import { config } from '../config.js';
import { all, get, nowIso, run } from './index.js';
import { AGENT_IDS } from '../protocol.js';

/**
 * System settings: the runtime configuration an administrator can change.
 *
 * Sensitive entries — API keys — are stored AES-256-GCM encrypted and the read endpoint
 * returns only a mask. The key is derived from JWT_SECRET, so changing JWT_SECRET makes
 * existing ciphertext undecryptable. The console says so.
 */

const ENC_PREFIX = 'enc:v1:';

// hkdfSync returns an ArrayBuffer; wrap it for createCipheriv
function encKey(): Uint8Array {
  return new Uint8Array(
    crypto.hkdfSync('sha256', config.jwtSecret, 'share-it-settings', 'aes-256-gcm', 32),
  );
}

export function encrypt(plaintext: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encKey(), new Uint8Array(iv));
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
}

export function decrypt(stored: string): string | null {
  if (!stored.startsWith(ENC_PREFIX)) return stored;
  const [ivB64, tagB64, ctB64] = stored.slice(ENC_PREFIX.length).split(':');
  if (!ivB64 || !tagB64 || !ctB64) return null;
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      encKey(),
      new Uint8Array(Buffer.from(ivB64, 'base64url')),
    );
    decipher.setAuthTag(new Uint8Array(Buffer.from(tagB64, 'base64url')));
    return Buffer.concat([
      decipher.update(new Uint8Array(Buffer.from(ctB64, 'base64url'))),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // JWT_SECRET changed, or the data is corrupt
    return null;
  }
}

/* ---------------- Setting definitions ---------------- */

export interface SettingSpec {
  key: string;
  label: string;
  group: 'mail' | 'quota' | 'agents';
  type: 'string' | 'secret' | 'number' | 'boolean' | 'list';
  hint?: string;
  /** Environment fallback, read when the setting itself is unset */
  envFallback?: string;
  default?: string;
  /**
   * Kept out of the generic list on the System settings page.
   *
   * For settings that **have their own interface**: they still use the same storage, type
   * checking and environment fallback, only their rendering belongs to their own card.
   * Without hiding them the same switch would have two entry points — one with an
   * explanation, one a bare true/false box — both editable and each overwriting the other.
   */
  hidden?: boolean;
  /**
   * Validation before writing. Return a message to refuse the write; undefined passes.
   *
   * Why it exists: some settings fail without an error, by making a feature quietly
   * disappear. Write an empty string for "which agents are offered" and the interface has
   * no agent at all, while the administrator sees a successful save. A constraint like
   * that has to be enforced at the moment of writing.
   */
  validate?: (value: string) => string | undefined;
}

/*
 * There are **no** upstream settings here. Address, key, model list and default model all
 * belong to the `upstream_providers` table: they are properties of an endpoint, and
 * switching upstream switches the whole set. Splitting them across a provider table and
 * global settings only lets the two disagree. The balance query reads the active row too.
 */
export const SETTING_SPECS: SettingSpec[] = [
  // Email
  {
    key: 'mail.sendgridApiKey',
    label: 'SendGrid API Key',
    group: 'mail',
    type: 'secret',
    envFallback: 'SENDGRID_API_KEY',
    hint: 'Without it email degrades: invite and reset links are printed to the server log',
  },
  {
    key: 'mail.from',
    label: 'From address',
    group: 'mail',
    type: 'string',
    envFallback: 'MAIL_FROM',
    hint: 'Must be a sender verified in SendGrid',
  },
  { key: 'mail.fromName', label: 'From name', group: 'mail', type: 'string', default: 'AgentLodge' },
  {
    // Three uses: the invite link, the password-reset link, and the link in a quota
    // warning email — all email, hence this group
    key: 'app.baseUrl',
    label: 'Site address',
    group: 'mail',
    type: 'string',
    envFallback: 'APP_BASE_URL',
    default: 'http://localhost:5173',
    hint: 'Links in emails are built from it',
  },

  // Egress policy
  {
    key: 'egress.useAuditProxy',
    label: 'Enable the audit proxy',
    // A hidden entry does not reach the generic list; group just needs a valid value
    group: 'mail',
    type: 'boolean',
    // Its interface is the Audit proxy card, which also shows status and handles the
    // proxy being unreachable; no need to render it twice
    hidden: true,
    envFallback: 'USE_AUDIT_PROXY',
    default: 'false',
    hint:
      'On: everything outbound goes through the proxy, and an upstream with no '
      + 'AUDIT_PROXY_URL gets a 503 (fail closed). Off: direct to the upstream, '
      + 'no proxy and no x-forwarded-* routing headers, and no record of that traffic.',
  },


  // Quota
  {
    key: 'quota.defaultTokenLimit',
    label: 'Default quota for new users',
    group: 'quota',
    type: 'number',
    hint: 'Billable tokens per period. Empty means unlimited.',
  },
  {
    key: 'quota.anchorDayOfMonth',
    label: 'Monthly reset day',
    group: 'quota',
    type: 'number',
    default: '1',
    hint: '1–31. A billing period need not start on the 1st; a month without that day falls back to its last (e.g. the 31st in February).',
  },
  {
    key: 'quota.anchorDayOfWeek',
    label: 'Weekly reset day',
    group: 'quota',
    type: 'number',
    default: '1',
    hint: '1 = Monday … 7 = Sunday',
  },
  {
    key: 'quota.anchorHour',
    label: 'Reset hour',
    group: 'quota',
    type: 'number',
    default: '0',
    hint: '0–23, in the server\'s local timezone. Used by the daily, weekly and monthly periods alike.',
  },
  {
    key: 'quota.weightCacheRead',
    label: 'Cache-hit weight',
    group: 'quota',
    type: 'number',
    default: '0.1',
    hint: 'Cache reads cost less than ordinary input; this is the conversion factor',
  },
  {
    key: 'quota.weightOutput',
    label: 'Output weight',
    group: 'quota',
    type: 'number',
    default: '1.5',
    hint: 'Output tokens cost more than input; this is the conversion factor',
  },

  // agent
  {
    /*
     * The model list itself stays on the provider — it is a property of an endpoint, and the
     * note at the top of this file explains why none of those live here. This only decides
     * **who writes it**: left off, whatever the administrator typed; turned on, the upstream
     * every hour, so a newly released model appears without anyone editing anything.
     *
     * Off by default because turning it on hands a hand-curated list over to the upstream.
     * An upstream that cannot answer changes nothing rather than emptying the list.
     */
    key: 'agents.autoRefreshModels',
    label: 'Refresh the model list hourly',
    group: 'agents',
    type: 'boolean',
    // Rendered at the foot of the upstream card instead, next to the list it overwrites and
    // the button that does the same thing by hand. A switch about a provider's model list,
    // sitting in a generic list of unrelated settings, is a switch nobody finds.
    hidden: true,
    default: 'false',
    hint: 'Asks the active upstream what models it has, once an hour, and overwrites that provider\'s list. Off leaves the list exactly as typed. Either way the manual "Pull from the upstream" button still works.',
  },
  {
    /*
     * Which agents this deployment actually offers.
     *
     * Not "is the CLI installed" — that is what probing answers, and listAgents spawns a
     * process to find out. This is an **operational decision**: both CLIs can be on the
     * machine and only one offered. The two are kept apart because they owe the user
     * different answers: a missing CLI is a fault, while an agent that is not offered
     * should not appear at all.
     *
     * A disabled agent is not in the available list from /api/agents and the frontend
     * draws no button for it — with only one left it draws no switcher either. Existing
     * conversations on it are kept; they simply cannot be reached.
     */
    key: 'agents.enabled',
    label: 'Agents offered',
    group: 'agents',
    type: 'list',
    // Has its own card under System settings, so it stays out of the generic list
    hidden: true,
    default: AGENT_IDS.join(','),
    envFallback: 'ENABLED_AGENTS',
    validate(value) {
      const ids = value.split(',').map((s) => s.trim()).filter(Boolean);
      if (!ids.length) return 'At least one agent has to be enabled';
      const unknown = ids.filter((id) => !(AGENT_IDS as readonly string[]).includes(id));
      if (unknown.length) return `Unknown agent(s): ${unknown.join(', ')}`;
      return undefined;
    },
  },
];

const SPEC_BY_KEY = new Map(SETTING_SPECS.map((s) => [s.key, s]));

/* ---------------- Reads and writes ---------------- */

interface Row {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

/** An in-memory cache: settings are read constantly, and a write invalidates the lot */
let cache: Map<string, string> | null = null;

function load(): Map<string, string> {
  if (cache) return cache;
  const rows = all<Row>('select * from settings');
  cache = new Map(rows.map((r) => [r.key, r.value]));
  return cache;
}

export function invalidate(): void {
  cache = null;
}

/** The raw value, decrypted where needed. Order: database, environment, default. */
export function getSetting(key: string): string | undefined {
  const spec = SPEC_BY_KEY.get(key);
  const raw = load().get(key);
  if (raw !== undefined && raw !== '') {
    const v = decrypt(raw);
    if (v) return v;
  }
  if (spec?.envFallback) {
    const env = process.env[spec.envFallback];
    if (env) return env;
  }
  return spec?.default;
}

export function getString(key: string, fallback = ''): string {
  return getSetting(key) ?? fallback;
}

export function getNumber(key: string): number | undefined {
  const v = getSetting(key);
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export function getBool(key: string): boolean {
  return getSetting(key) === 'true';
}

/**
 * Read the database directly, past the in-memory cache.
 *
 * For switches that have to take effect **across processes**. The cache above is
 * per-process and only invalidated by a write in that process: app changes a setting and
 * the gateway — another container under compose — keeps the old value until it restarts.
 * A safety switch cannot have that window.
 *
 * The cost is one local SQLite read, microseconds, and only when deciding whether to
 * allow a particular egress. It is not on a hot path. Do not use it for frequently read
 * configuration.
 */
export function getBoolFresh(key: string): boolean {
  const spec = SPEC_BY_KEY.get(key);
  const row = get<{ value: string }>('select value from settings where key = ?', key);
  if (row?.value) {
    const v = decrypt(row.value);
    if (v) return v === 'true';
  }
  if (spec?.envFallback) {
    const env = process.env[spec.envFallback];
    if (env) return env === 'true';
  }
  return spec?.default === 'true';
}

export function getList(key: string): string[] {
  return getString(key)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function setSetting(key: string, value: string, updatedBy?: string): void {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) throw new Error(`Unknown setting: ${key}`);
  const problem = spec.validate?.(value);
  if (problem) throw new Error(`${spec.label}：${problem}`);
  const stored = spec.type === 'secret' && value ? encrypt(value) : value;
  run(
    `insert into settings (key, value, updated_at, updated_by) values (?, ?, ?, ?)
     on conflict(key) do update set value = excluded.value,
       updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    key,
    stored,
    nowIso(),
    updatedBy ?? null,
  );
  invalidate();
}

/** A secret is returned masked; the plaintext never reaches the frontend */
function mask(v: string): string {
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

export interface SettingView extends SettingSpec {
  value: string;
  /** For a secret, whether one is configured */
  isSet: boolean;
  /** Where the value came from */
  source: 'db' | 'env' | 'default' | 'unset';
}

export function listSettings(): SettingView[] {
  const store = load();
  // The hidden ones have interfaces of their own and stay out of the generic list
  return SETTING_SPECS.filter((spec) => !spec.hidden).map((spec) => {
    const raw = store.get(spec.key);
    const hasDb = raw !== undefined && raw !== '';
    const resolved = getSetting(spec.key) ?? '';
    const source: SettingView['source'] = hasDb
      ? 'db'
      : spec.envFallback && process.env[spec.envFallback]
        ? 'env'
        : spec.default !== undefined
          ? 'default'
          : 'unset';
    return {
      ...spec,
      value: spec.type === 'secret' ? (resolved ? mask(resolved) : '') : resolved,
      isSet: Boolean(resolved),
      source,
    };
  });
}

/* ---------------- Convenience accessors ---------------- */

/** The period anchor: the day of month, day of week and hour an administrator set for the reset */
export const quotaAnchor = () => ({
  dayOfMonth: getNumber('quota.anchorDayOfMonth') ?? 1,
  dayOfWeek: getNumber('quota.anchorDayOfWeek') ?? 1,
  hour: getNumber('quota.anchorHour') ?? 0,
});

export const quotaWeights = () => ({
  input: 1,
  cacheRead: getNumber('quota.weightCacheRead') ?? 0.1,
  cacheCreation: 1,
  output: getNumber('quota.weightOutput') ?? 1.5,
});

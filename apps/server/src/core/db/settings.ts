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

/**
 * The widths a field can take, and not a number.
 *
 * The console turns this into a Tailwind class through a lookup table, and Tailwind needs
 * the class to appear in the source — so there is a fixed set of them. Typed as `number`,
 * `span: 5` type-checked, found nothing in the table, rendered with no class at all, and
 * collapsed the field to a sixth of the row.
 */
export type SettingSpan = 1 | 2 | 3 | 4 | 6;

export interface SettingSpec {
  key: string;
  label: string;
  group: 'mail' | 'quota' | 'agents' | 'gateway';
  type: 'string' | 'secret' | 'number' | 'boolean' | 'list' | 'select';
  hint?: string;
  /**
   * The values a `select` takes, shown as written.
   *
   * Not translated, and not paired with display labels: these are product names — resend,
   * brevo, smtp — which read the same in every language, and a label here would land in
   * every locale table for nothing.
   */
  options?: string[];
  /**
   * How many of the console's six columns this field takes, when the viewport has room.
   *
   * Left out it takes the row. A reset hour and a weight are three characters wide and
   * had a row each, which turned six numbers into six screens of scrolling.
   */
  span?: SettingSpan;
  /**
   * Only shown while another setting holds one of these values.
   *
   * Display only: the value is stored, read and env-overridden exactly as any other, and
   * the server never refuses a write because a field was out of view. What it buys is a
   * mail card that asks for an API key or for a relay, rather than for both and a note on
   * each saying which half to ignore.
   */
  showWhen?: { key: string; is: string[] };
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
   * What the console shows and takes, as a multiple of what is stored.
   *
   * A money setting is stored in micro-units because that is what every cost and ceiling in
   * the database is counted in, and typed in whole units because nobody sizes an allowance
   * to the sixth decimal place — and a misplaced zero in `10000000` is invisible in a way
   * that one in `10` is not. The conversion is the console's; the stored value, the
   * environment fallback and validate() all stay in the unit the rest of the server uses.
   */
  scale?: number;
  /** Shown inside the field, in the entered scale */
  unit?: string;
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
    key: 'mail.provider',
    span: 2,
    label: 'Mail provider',
    group: 'mail',
    type: 'select',
    options: ['resend', 'brevo', 'smtp'],
    default: 'resend',
    envFallback: 'MAIL_PROVIDER',
    validate: (v) =>
      ['resend', 'brevo', 'smtp'].includes(v) ? undefined : 'Pick resend, brevo or smtp',
  },
  {
    key: 'mail.apiKey',
    span: 4,
    label: 'API key',
    group: 'mail',
    type: 'secret',
    envFallback: 'MAIL_API_KEY',
    showWhen: { key: 'mail.provider', is: ['resend', 'brevo'] },
    hint: 'Without it, links go to the server log instead.',
  },
  {
    key: 'mail.smtpHost',
    span: 4,
    label: 'SMTP host',
    group: 'mail',
    type: 'string',
    envFallback: 'SMTP_HOST',
    showWhen: { key: 'mail.provider', is: ['smtp'] },
  },
  {
    key: 'mail.smtpPort',
    span: 2,
    label: 'SMTP port',
    group: 'mail',
    type: 'number',
    default: '587',
    envFallback: 'SMTP_PORT',
    showWhen: { key: 'mail.provider', is: ['smtp'] },
    hint: '465 is TLS; 587 and 25 use STARTTLS.',
  },
  {
    key: 'mail.smtpUser',
    span: 2,
    label: 'SMTP username',
    group: 'mail',
    type: 'string',
    envFallback: 'SMTP_USER',
    showWhen: { key: 'mail.provider', is: ['smtp'] },
    hint: 'Empty if the relay needs no login.',
  },
  {
    key: 'mail.smtpPassword',
    span: 2,
    label: 'SMTP password',
    group: 'mail',
    type: 'secret',
    envFallback: 'SMTP_PASSWORD',
    showWhen: { key: 'mail.provider', is: ['smtp'] },
  },
  {
    key: 'mail.from',
    span: 2,
    label: 'From address',
    group: 'mail',
    type: 'string',
    envFallback: 'MAIL_FROM',
    hint: 'Must be verified at the provider.',
  },
  { key: 'mail.fromName', label: 'From name', group: 'mail', type: 'string', span: 2, default: 'AgentLodge' },
  {
    // Three uses: the invite link, the password-reset link, and the link in a quota
    // warning email — all email, hence this group
    key: 'app.baseUrl',
    span: 2,
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
    key: 'quota.defaultLimit',
    span: 2,
    label: 'Default quota for new users',
    group: 'quota',
    type: 'number',
    // Typed in whole units of the settlement currency, stored in micro-units, which is
    // what every ceiling and every cost in the database is counted in
    scale: 1_000_000,
    unit: 'money',
    hint: 'A monthly ceiling for a new account, in the settlement currency; empty is unlimited.',
  },
  {
    key: 'quota.anchorDayOfMonth',
    span: 2,
    label: 'Monthly reset day',
    group: 'quota',
    type: 'number',
    default: '1',
    hint: '1–31. A month without that day uses its last.',
  },
  {
    key: 'quota.anchorDayOfWeek',
    span: 2,
    label: 'Weekly reset day',
    group: 'quota',
    type: 'number',
    default: '1',
    hint: '1 = Monday … 7 = Sunday',
  },
  {
    key: 'quota.anchorHour',
    span: 2,
    label: 'Reset hour',
    group: 'quota',
    type: 'number',
    default: '0',
    hint: '0–23, server time.',
  },
  {
    /*
     * The first of the gate's two limits: how many requests may be in flight to one
     * upstream at once.
     *
     * A row, not just a number in the gateway process. It was only the latter for a long
     * time — `PATCH /gate` called `setMaxConcurrency` and nothing else — which meant the
     * limit was not a setting at all but a property of an uptime: every restart of the
     * gateway container put it back to `MAX_UPSTREAM_CONCURRENCY`, and the console went on
     * showing whatever it had been told last. Stored here it survives the restart, and the
     * gate reads it fresh on each admission pass for the same cross-container reason as the
     * per-user cap below.
     *
     * Hidden because it has an interface of its own — the Metering gateway card, which also
     * shows what the gate is doing with it.
     */
    key: 'gateway.maxUpstreamConcurrency',
    span: 2,
    label: 'Slots per upstream',
    group: 'gateway',
    type: 'number',
    hidden: true,
    default: '3',
    envFallback: 'MAX_UPSTREAM_CONCURRENCY',
    hint: 'How many requests may be in flight to one upstream at once.',
    // The same range the console's own check uses, so a write that got here another way
    // cannot leave the gate on a number the page would have refused
    validate: (v) => {
      if (v.trim() === '') return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 64
        ? undefined
        : 'A whole number from 1 to 64. Empty uses the default.';
    },
  },
  {
    /*
     * Whether a 429 is allowed to move the limit above.
     *
     * On — the long-standing behaviour — the gate halves itself when the upstream pushes
     * back and climbs one step per twenty clean responses, which is right when the real
     * threshold is unknown and wrong when it is known: a deployment on a plan whose
     * concurrency is written in the contract wants the number it paid for, not a number
     * discovered from the last incident, and "the limit says twelve and the gate is running
     * at two" is indistinguishable from a bug when you are looking at it from the console.
     *
     * Off only stops the narrowing. A `retry-after` is still waited out — that is the
     * upstream saying when to come back, not how wide to run.
     */
    key: 'gateway.adaptiveConcurrency',
    span: 2,
    label: 'Adapt to the upstream',
    group: 'gateway',
    type: 'boolean',
    hidden: true,
    default: 'true',
    hint:
      'On: a rate-limited upstream halves this gate, which then climbs back over a run of '
      + 'clean responses. Off: it stays at the configured limit and only the retry-after '
      + 'pause applies.',
  },
  {
    /*
     * The second of the gate's two limits, and the one that does the work.
     *
     * The pool's ceiling is per upstream; this is per user per upstream, and an agent loop
     * fires several calls in a burst — so without it one person's conversation takes every
     * slot and everybody else queues behind it. Which also makes it the limit that is
     * usually binding: a pool of twenty with two in flight and eight queued is not a
     * contradiction, it is one user at their own cap of two.
     *
     * Read fresh on each admission pass, because the gate lives in the gateway container
     * and this is written from the console in the app one. The environment variable stays
     * as the fallback for a deployment that never opens the page.
     */
    key: 'gateway.perUserInflightMax',
    span: 2,
    label: 'Slots one user may hold',
    group: 'gateway',
    type: 'number',
    default: '2',
    envFallback: 'PER_USER_INFLIGHT_MAX',
    hint: 'Per upstream, so a busy conversation cannot take the whole pool.',
    /*
     * Refused here rather than ignored later. The gate falls back to its configured value
     * for anything it cannot use, so a zero typed into this box would be stored, silently
     * overridden, and leave somebody looking at a saved setting that does nothing. Empty is
     * allowed and means the same as never set: the environment variable, then the default.
     */
    validate: (v) => {
      if (v.trim() === '') return undefined;
      const n = Number(v);
      return Number.isInteger(n) && n >= 1 && n <= 64
        ? undefined
        : 'A whole number from 1 to 64. Empty uses the default.';
    },
  },
  {
    /*
     * The currency every figure on every report is expressed in.
     *
     * The price table is **not** one currency: each vendor is held at its own published list,
     * because a converted price cannot be checked against an invoice and goes stale the day a
     * rate moves. What a turn cost is recorded in the money it was charged in. This is what
     * all of that is converted to on the way to a screen — and what a ceiling is read in.
     *
     * Reports used to print every currency side by side, "¥12.34 + $5.67", on the argument
     * that adding them invents a number nothing corresponds to. True, and unusable: nobody
     * can tell at a glance whether that is more or less than last month. One currency, one
     * rate, stated in the console, with the original amounts a hover away.
     */
    key: 'billing.currency',
    span: 2,
    label: 'Settlement currency',
    group: 'quota',
    type: 'string',
    default: 'USD',
    hint: 'What every report and every ceiling is counted in. Prices stay in the currency each vendor publishes; this is what they are converted to on the way to the screen.',
  },
  {
    /*
     * The one exchange rate, in the direction people say it out loud.
     *
     * Two vendors, two currencies: Anthropic bills in dollars and DeepSeek in yuan, and one
     * rate relates them whichever way round the settlement currency is set. It used to be a
     * JSON object of currency → multiplier, which is more general than a two-currency
     * deployment needs and gets the direction wrong in a way nobody notices: the entry for
     * the settlement currency itself is dead, and a stale one sits there looking live.
     *
     * Applied from the moment it is set, to old figures as well as new. Nothing stored is
     * rewritten — the conversion happens on the way out — so correcting a rate that was typed
     * wrong fixes every report at once rather than leaving a month of bad numbers behind.
     */
    key: 'billing.cnyPerUsd',
    span: 2,
    label: 'CNY per USD',
    group: 'quota',
    type: 'number',
    default: '7.1',
    hint: 'How many yuan one dollar is worth, e.g. 7.1. The only exchange rate in the system; it converts what each vendor charges into the settlement currency.',
    validate: (v: string) => {
      if (!v.trim()) return undefined;
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) return 'has to be a positive number, e.g. 7.1';
      // Not a bound on the market, a bound on typos: 0.71 and 71 are both one keystroke away
      return n >= 0.01 && n <= 1000 ? undefined : 'that is not a plausible rate — check the decimal point';
    },
  },
  {
    /*
     * Not a setting anybody edits: the gateway writes it when the upstream reports when its
     * 5-hour window resets, and both processes read it to cut that window at the same
     * instant. It lives here because the settings table is the only store both containers
     * already share, and it is hidden because there is nothing here for a person to decide.
     */
    key: 'quota.windowResetAt',
    label: 'Upstream 5-hour window reset',
    group: 'quota',
    type: 'string',
    hidden: true,
  },
  {
    /* The weekly window's twin of the above, written and read the same way. */
    key: 'quota.weekResetAt',
    label: 'Upstream weekly window reset',
    group: 'quota',
    type: 'string',
    hidden: true,
  },
  {
    /*
     * The newest Claude Code seen through the gateway, written the same way and for the same
     * reason: observed from traffic, needed by both processes. It is what our own upstream
     * calls claim to be, since the upstream gates models on that number — see
     * gateway/cli-version.ts.
     */
    key: 'upstream.cliVersion',
    label: 'Newest Claude Code version seen',
    group: 'agents',
    type: 'string',
    hidden: true,
  },
  {
    /**
     * The model a conversation gets when nobody picks one, per agent.
     *
     * Per agent rather than global because the two CLIs are pointed at different models
     * more often than not: a subscription-backed Claude and a cheap chat endpoint for
     * Codex, say. Empty leaves it to the CLI's own default.
     */
    key: 'agent.claude.defaultModel',
    span: 3,
    label: 'Default model for Claude',
    group: 'agents',
    type: 'string',
    default: '',
    hint: 'Empty leaves it to the CLI.',
  },
  {
    key: 'agent.codex.defaultModel',
    span: 3,
    label: 'Default model for Codex',
    group: 'agents',
    type: 'string',
    default: '',
    hint: 'Empty leaves it to the CLI.',
  },
  {
    /*
     * What the service itself asks for, as opposed to what a user asks for: naming a
     * conversation, summarising one, writing the portrait on the profile page.
     *
     * Its own setting because the two have nothing to do with each other. Those calls read
     * a transcript and write a line or two — a job the cheapest model on the deployment
     * does as well as the most expensive one, at a fiftieth of the price — and until now
     * they went out on whatever the main model was, so a deployment on an expensive model
     * paid that rate to produce a four-word title.
     *
     * It is the user's own quota either way. The setting decides what it costs them, not
     * who pays.
     */
    key: 'agents.toolModel',
    span: 3,
    label: 'Model for titles and summaries',
    group: 'agents',
    type: 'string',
    default: '',
    hint: 'Used for naming conversations, summarising them and writing the profile — never for a reply. A cheap model is the right choice here. Empty follows the main model.',
  },
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
    hint: 'Asks every upstream what models it has, once an hour, and adds the names that are missing. Nothing is removed or reordered, and a model turned off stays off. Either way the manual "Pull from the upstream" button still works.',
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
/**
 * Read past the cache.
 *
 * The cache is per process and the two containers share one database, so anything one of
 * them writes has to be read this way by the other or it is a restart behind.
 */
export function getStringFresh(key: string): string | undefined {
  const row = get<{ value: string }>('select value from settings where key = ?', key);
  if (row?.value) {
    const v = decrypt(row.value);
    if (v) return v;
  }
  return SPEC_BY_KEY.get(key)?.default;
}

/**
 * A number read past the cache, for the same reason as the two above: the gateway is
 * another container, and a value it only re-reads on restart is not a setting.
 *
 * No `scale`: the console multiplies a scaled field before it sends it, so what is stored
 * is already in base units — the same reason `getNumber` does not apply it either.
 */
export function getNumberFresh(key: string): number | undefined {
  const spec = SPEC_BY_KEY.get(key);
  const row = get<{ value: string }>('select value from settings where key = ?', key);
  const stored = row?.value ? decrypt(row.value) : undefined;
  const raw = stored
    || (spec?.envFallback ? process.env[spec.envFallback] : undefined)
    || spec?.default;
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

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
      /*
       * A money field is labelled in whatever currency this deployment settles in, which is
       * itself a setting — so the unit is filled in here rather than written into the spec.
       * `money` is the placeholder, not something an administrator should ever read.
       */
      unit: spec.unit === 'money' ? getString('billing.currency', 'USD') : spec.unit,
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


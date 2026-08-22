import crypto from 'node:crypto';
import { readSecretFile } from '../secret-file.js';
import { all, get, nowIso, run } from './index.js';
import { decrypt, encrypt, invalidate as invalidateSettings } from './settings.js';

/**
 * Upstream providers: where the gateway forwards to.
 *
 * Several can be configured — DeepSeek, a local Ollama, another third party, the mock
 * — and exactly one is active at a time. Switching needs no code change and no restart.
 */

export type ProviderKind = 'anthropic-native' | 'openai-chat' | 'mock' | 'local-agent';

/**
 * Shown in the console's kind dropdown. English is the source text; the client
 * runs it through the translator, so these strings double as i18n keys.
 */
export const KIND_LABEL: Record<ProviderKind, string> = {
  'anthropic-native': 'Anthropic Messages native (official / DeepSeek compatibility layer / your own gateway)',
  'openai-chat': 'OpenAI Chat compatible (Ollama / LM Studio / third party)',
  mock: 'Built-in mock upstream (no network, no cost)',
  'local-agent': 'CLI on the host (testing only, text out)',
};

export interface Provider {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  /**
   * Whether a key is configured; never the key itself.
   *
   * True for a key that comes from a file too — but "configured" is not "readable",
   * and the file's actual state is queried separately by the console (see
   * app/routes/admin/providers.ts).
   */
  hasKey: boolean;
  /**
   * Path to the file holding the key, as seen inside the container. Empty means the
   * key is stored in the database directly.
   *
   * A reference, not a value: when another container rotates that file, the next
   * request uses the new one. See core/secret-file.ts.
   */
  keyFile: string;
  active: boolean;
  note?: string;
  /**
   * Model names this upstream answers to. Empty falls back to each agent's own defaults
   * (Claude's aliases, Codex's models.json).
   *
   * On the provider rather than in global settings because a model name is **a property
   * of the endpoint**: switching upstream means switching the whole set of names. Held
   * globally you would have to edit it again on the way back, and for the instant after
   * a switch the list and the endpoint would disagree.
   */
  models: string[];
  /** Used when a conversation names no model. Empty leaves it to the CLI. */
  defaultModel: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  api_key: string | null;
  api_key_file: string | null;
  active: number;
  note: string | null;
  models: string | null;
  default_model: string | null;
  created_at: string;
  updated_at: string;
}

const splitModels = (raw: string | null): string[] =>
  (raw ?? '').split(',').map((m) => m.trim()).filter(Boolean);

const toProvider = (r: Row): Provider => ({
  id: r.id,
  name: r.name,
  kind: r.kind as ProviderKind,
  baseUrl: r.base_url,
  hasKey: Boolean(r.api_key || r.api_key_file),
  keyFile: r.api_key_file ?? '',
  active: r.active === 1,
  note: r.note ?? undefined,
  models: splitModels(r.models),
  defaultModel: (r.default_model ?? '').trim(),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function list(): Provider[] {
  return all<Row>('select * from upstream_providers order by created_at').map(toProvider);
}

export function findById(id: string): Provider | undefined {
  const r = get<Row>('select * from upstream_providers where id = ?', id);
  return r && toProvider(r);
}

/** The active one, or undefined when there is none — which is how callers tell whether the gateway can work at all */
export function active(): Provider | undefined {
  const r = get<Row>('select * from upstream_providers where active = 1 limit 1');
  return r && toProvider(r);
}

/**
 * The key in plaintext, for the gateway alone — no path that returns to the frontend
 * may touch it.
 *
 * When it is a file reference this **re-reads from disk on every call**, deliberately.
 * The whole point of pointing at a file is that somebody else — a secret sidecar,
 * another container — rotates it, and caching throws away the one benefit that buys.
 * The cost is a few syscalls per upstream request, tens of microseconds, against the
 * LLM call that follows.
 */
export function secretOf(id: string): string | undefined {
  const r = get<{ api_key: string | null; api_key_file: string | null }>(
    'select api_key, api_key_file from upstream_providers where id = ?',
    id,
  );
  if (!r) return undefined;

  if (r.api_key_file) {
    const read = readSecretFile(r.api_key_file);
    if ('error' in read) {
      // All the gateway sees is "no key", which is not enough to debug from, so say why here
      console.error(`[providers] cannot read the key file (${r.api_key_file}): ${read.error}`);
      return undefined;
    }
    return read.value;
  }

  if (!r.api_key) return undefined;
  return decrypt(r.api_key) ?? undefined;
}

/**
 * Whether what was typed into apiKey is the key itself or the path to a file holding it.
 *
 * One test: **does it start with `/`**.
 *
 * It has to be purely syntactic — no stat to see whether the file exists. The app
 * container very likely does not mount that volume at all (mounting it only into the
 * gateway is the recommended shape; see the comments in core/secret-file.ts). Touch the
 * filesystem and a perfectly good path gets classified as a literal key because *this*
 * process cannot see it, encrypted into the database, and sent upstream as
 * Authorization. The error is a 401, and nothing about it points at the cause.
 *
 * It is the same line secret-file.ts draws: that side only ever accepted absolute paths.
 * Real keys do not start with `/` either — sk-, sk-ant- and the rest all carry a prefix.
 * To bypass the test, pass apiKeyFile directly.
 */
export function looksLikePath(v: string): boolean {
  return v.trim().startsWith('/');
}

export interface UpsertInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  /**
   * The key itself, **or** the path to a file holding it — decided by looksLikePath().
   * Omitted means leave it alone when editing; an empty string clears it.
   */
  apiKey?: string;
  /** Says outright that this is a path. For bypassing the automatic test; see keyColumns(). */
  apiKeyFile?: string;
  note?: string;
  models?: string[];
  defaultModel?: string;
}

/**
 * Turns apiKey / apiKeyFile into the two column values.
 *
 * The rule: **either field appearing means the source of the key is being respecified**,
 * and the other column is always cleared. Otherwise the database can end up holding an
 * old ciphertext *and* a new path, while secretOf reads only one of them — the console
 * says "configured" and something else goes out on the wire, which is the hardest kind
 * of discrepancy to chase.
 *
 * apiKey takes both a key and a path in one field; a leading `/` routes it to the file
 * column (see looksLikePath). apiKeyFile remains as the **explicit** form and takes no
 * part in the test.
 *
 * undefined means the patch did not mention a key at all: leave both columns alone.
 */
function keyColumns(input: Pick<UpsertInput, 'apiKey' | 'apiKeyFile'>):
  { key: string | null; file: string | null } | undefined {
  if (input.apiKey === undefined && input.apiKeyFile === undefined) return undefined;
  const file = (input.apiKeyFile ?? '').trim();
  if (file) return { key: null, file };
  const literal = input.apiKey ?? '';
  // All whitespace clears it. This used to test for the empty string only, so ' ' was
  // encrypted and stored as a key made of spaces
  if (!literal.trim()) return { key: null, file: null };
  if (looksLikePath(literal)) return { key: null, file: literal.trim() };
  return { key: encrypt(literal), file: null };
}

/** The frontend can send anything; normalise to a trimmed, de-duplicated, non-empty string array before storing */
function cleanModels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
}

export function create(input: UpsertInput): Provider {
  const id = crypto.randomUUID();
  const now = nowIso();
  const key = keyColumns(input) ?? { key: null, file: null };
  run(
    `insert into upstream_providers
       (id, name, kind, base_url, api_key, api_key_file, active, note, models, default_model, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.kind,
    (input.baseUrl ?? '').replace(/\/+$/, ''),
    key.key,
    key.file,
    input.note ?? null,
    cleanModels(input.models).join(','),
    (input.defaultModel ?? '').trim(),
    now,
    now,
  );
  return findById(id)!;
}

export function update(id: string, patch: Partial<UpsertInput>): Provider | undefined {
  const cur = findById(id);
  if (!cur) return undefined;

  // No key in the patch leaves both columns alone; a key in the patch resets both (see keyColumns)
  const key = keyColumns(patch);
  const keyClause = key ? ', api_key = ?, api_key_file = ?' : '';
  const args: (string | null)[] = [
    patch.name?.trim() ?? cur.name,
    patch.kind ?? cur.kind,
    (patch.baseUrl ?? cur.baseUrl).replace(/\/+$/, ''),
    patch.note ?? cur.note ?? null,
    (patch.models === undefined ? cur.models : cleanModels(patch.models)).join(','),
    (patch.defaultModel ?? cur.defaultModel).trim(),
    nowIso(),
  ];
  if (key) args.push(key.key, key.file);
  args.push(id);

  run(
    `update upstream_providers
        set name = ?, kind = ?, base_url = ?, note = ?, models = ?, default_model = ?, updated_at = ?${keyClause}
      where id = ?`,
    ...args,
  );
  return findById(id);
}

export function remove(id: string): boolean {
  return run('delete from upstream_providers where id = ?', id).changes > 0;
}

/** Switch the active provider. Exactly one globally: clear, then set. */
export function activate(id: string): Provider | undefined {
  if (!findById(id)) return undefined;
  run('update upstream_providers set active = 0 where active = 1');
  run('update upstream_providers set active = 1, updated_at = ? where id = ?', nowIso(), id);
  return findById(id);
}

/** Read a legacy setting that may still be in the database — the specs are gone, the rows are not */
function legacySetting(key: string): string | undefined {
  const r = get<{ value: string }>('select value from settings where key = ?', key);
  if (!r?.value) return undefined;
  return decrypt(r.value) ?? undefined;
}

/**
 * On first start, turn the old deepseek.* settings into a provider row, so an existing
 * deployment does not have to be configured again.
 *
 * Those setting specs are gone — keys belong to providers now — but **the rows are still
 * in old databases**, while a fresh deployment may only have the DEEPSEEK_API_KEY
 * environment variable. Both sources are accepted; this runs once either way, since a
 * non-empty table returns immediately.
 */
export function seedFromSettings(): void {
  if (get('select 1 as x from upstream_providers limit 1')) return;

  const key = legacySetting('deepseek.apiKey') ?? process.env.DEEPSEEK_API_KEY;
  const chat = legacySetting('upstream.protocol') === 'openai-chat';
  const deepseek = {
    baseUrl: () =>
      (legacySetting('deepseek.baseUrl') ?? process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com')
        .replace(/\/+$/, ''),
  };
  const p = create({
    name: 'DeepSeek',
    kind: chat ? 'openai-chat' : 'anthropic-native',
    // DeepSeek's Anthropic compatibility layer sits under /anthropic. That prefix
    // belongs to their routing, so it goes in base_url — the gateway layer knows no
    // vendor names (see gateway/upstream.ts)
    baseUrl: chat ? deepseek.baseUrl() : `${deepseek.baseUrl()}/anthropic`,
    apiKey: key,
    note: 'Migrated from system settings',
  });
  if (key) activate(p.id);

  create({
    name: 'Mock upstream (testing)',
    kind: 'mock',
    note: 'No network, no cost — for exercising the path and the metering',
  });
  console.log('[providers] upstream list initialised');
}

/**
 * One-off: move the old global model list onto the active provider.
 *
 * The list used to be four global settings — agent.claude.models, agent.codex.models and
 * two defaultModel entries — and now belongs to the provider. The rules:
 *   - only onto the active row, and only when it has no list yet; other providers are
 *     meant to carry their own
 *   - two agents had a list each and a provider has one, so take the **union**. The same
 *     endpoint should answer to the same names for both agents anyway, and where they
 *     differ, merging is safer than discarding
 *   - the four rows are deleted afterwards, so a second run does nothing
 */
export function migrateModelSettings(): void {
  const keys = [
    'agent.claude.models',
    'agent.codex.models',
    'agent.claude.defaultModel',
    'agent.codex.defaultModel',
  ];
  const [claudeModels, codexModels, claudeDefault, codexDefault] = keys.map(legacySetting);
  if (!claudeModels && !codexModels && !claudeDefault && !codexDefault) return;

  const cur = active();
  if (cur && cur.models.length === 0) {
    const merged = [
      ...new Set(
        `${claudeModels ?? ''},${codexModels ?? ''}`.split(',').map((m) => m.trim()).filter(Boolean),
      ),
    ];
    update(cur.id, { models: merged, defaultModel: (claudeDefault || codexDefault || '').trim() });
    console.log(
      `[providers] model list migrated from system settings onto "${cur.name}": ${merged.join(', ') || '(empty)'}`,
    );
  }
  for (const k of keys) run('delete from settings where key = ?', k);
  invalidateSettings();
}

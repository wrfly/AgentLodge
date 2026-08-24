import crypto from 'node:crypto';
import * as credentialManager from '../credential-manager.js';
import { all, get, nowIso, run } from './index.js';
import { decrypt, invalidate as invalidateSettings } from './settings.js';

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
   * Whether a credential is configured; never anything of the credential itself.
   *
   * "Configured" is not "usable": whether that credential still exists and still yields
   * a token is asked of the credential manager separately (see credentialIds in
   * app/routes/admin/shared.ts).
   */
  hasKey: boolean;
  /**
   * The credential this provider uses, named by id.
   *
   * The value behind it — a pasted key, the contents of a file another process rotates,
   * or a subscription's access token — lives in the credential manager and nowhere else.
   * The gateway asks for it per request; see secretOf.
   */
  credentialId: string;
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
  credential_id: string | null;
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
  hasKey: Boolean(r.credential_id),
  credentialId: r.credential_id ?? '',
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
 * The value to send upstream, for the gateway alone — no path that returns to the
 * frontend may touch it.
 *
 * It is asked of the credential manager **on every call**. That service mints a
 * subscription's access token before the old one expires and re-reads a key file each
 * time it is asked, so what comes back has hours to live at most and holding on to it
 * would only serve something stale. The cost is one Unix-socket round trip per upstream
 * request, against the LLM call that follows.
 *
 * force asks for a mint before answering, which is what the gateway does after a 401: the
 * token it just used may have been revoked upstream rather than merely aged out.
 */
export async function secretOf(id: string, opts: { force?: boolean } = {}): Promise<string | undefined> {
  const r = get<{ credential_id: string | null }>(
    'select credential_id from upstream_providers where id = ?',
    id,
  );
  if (!r?.credential_id) return undefined;
  return credentialManager.tokenFor(r.credential_id, opts);
}

export interface UpsertInput {
  name: string;
  kind: ProviderKind;
  baseUrl?: string;
  /**
   * The credential this provider uses, by id. Omitted means leave it alone when editing;
   * an empty string clears it, after which the provider has no way to authenticate and
   * the gateway refuses its requests.
   */
  credentialId?: string;
  note?: string;
  models?: string[];
  defaultModel?: string;
}

/** The frontend can send anything; normalise to a trimmed, de-duplicated, non-empty string array before storing */
function cleanModels(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))];
}

export function create(input: UpsertInput): Provider {
  const id = crypto.randomUUID();
  const now = nowIso();
  run(
    `insert into upstream_providers
       (id, name, kind, base_url, credential_id, active, note, models, default_model, created_at, updated_at)
     values (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.kind,
    (input.baseUrl ?? '').replace(/\/+$/, ''),
    (input.credentialId ?? '').trim() || null,
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

  // No credential in the patch leaves the column alone; an empty string clears it
  const credential = patch.credentialId === undefined ? undefined : patch.credentialId.trim() || null;
  const keyClause = credential !== undefined ? ', credential_id = ?' : '';
  const args: (string | null)[] = [
    patch.name?.trim() ?? cur.name,
    patch.kind ?? cur.kind,
    (patch.baseUrl ?? cur.baseUrl).replace(/\/+$/, ''),
    patch.note ?? cur.note ?? null,
    (patch.models === undefined ? cur.models : cleanModels(patch.models)).join(','),
    (patch.defaultModel ?? cur.defaultModel).trim(),
    nowIso(),
  ];
  if (credential !== undefined) args.push(credential);
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
    note: 'Migrated from system settings',
  });
  // The key it used to be created with goes to the credential manager instead, from the
  // gateway, which is the process that can reach it: see gateway/legacy-keys.ts. The row
  // is activated here regardless — a provider with no credential is visibly unusable in
  // the console, which is a better state than a deployment with nothing active at all.
  activate(p.id);

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

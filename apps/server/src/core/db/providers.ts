import crypto from 'node:crypto';
import * as credentialManager from '../credential-manager.js';
import { all, get, nowIso, run } from './index.js';
import { decrypt, invalidate as invalidateSettings } from './settings.js';

/**
 * Upstream providers: where the gateway can forward to.
 *
 * This registry answers "how do we connect to it" — address, protocol, credential — and
 * nothing about when it is used. Which upstream serves a request follows from the model
 * that request asks for; see core/db/models.ts.
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
  note?: string;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  name: string;
  kind: string;
  base_url: string;
  credential_id: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
}

const toProvider = (r: Row): Provider => ({
  id: r.id,
  name: r.name,
  kind: r.kind as ProviderKind,
  baseUrl: r.base_url,
  hasKey: Boolean(r.credential_id),
  credentialId: r.credential_id ?? '',
  note: r.note ?? undefined,
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
}

export function create(input: UpsertInput): Provider {
  const id = crypto.randomUUID();
  const now = nowIso();
  run(
    `insert into upstream_providers
       (id, name, kind, base_url, credential_id, note, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name.trim(),
    input.kind,
    (input.baseUrl ?? '').replace(/\/+$/, ''),
    (input.credentialId ?? '').trim() || null,
    input.note ?? null,
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
    nowIso(),
  ];
  if (credential !== undefined) args.push(credential);
  args.push(id);

  run(
    `update upstream_providers
        set name = ?, kind = ?, base_url = ?, note = ?, updated_at = ?${keyClause}
      where id = ?`,
    ...args,
  );
  return findById(id);
}

export function remove(id: string): boolean {
  return run('delete from upstream_providers where id = ?', id).changes > 0;
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
  // gateway, which is the process that can reach it: see gateway/legacy-keys.ts.
  void p;

  create({
    name: 'Mock upstream (testing)',
    kind: 'mock',
    note: 'No network, no cost — for exercising the path and the metering',
  });
  console.log('[providers] upstream list initialised');
}

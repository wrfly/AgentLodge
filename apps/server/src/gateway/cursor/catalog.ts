import { accessToken } from './auth.js';
import { decode, encode, type Message } from './codec.js';
import { splitModel } from './request.js';

/**
 * What Cursor calls a model, and what it wants sent instead.
 *
 * `claude-opus-5-thinking-high` is not a model name. It is one **variant** of the model
 * `claude-opus-5`, and the request carries the two apart: `model_id` names the model and
 * `parameters` says which variant. So a slug has to be resolved before it can be sent.
 *
 * The resolution is a lookup, not string surgery. Every model in `AvailableModels` carries a
 * `variants[]` table, each entry giving its own slug (`variant_string_representation`, plus a
 * `legacy_slug` for the name it used to have) alongside the exact parameters it stands for —
 * and that is what Cursor's own client matches a slug against. Reading the suffixes instead
 * gets the common cases right and then quietly diverges:
 *
 *   `-max`   reads like an effort level beside `-low`, `-medium`, `-high` and `-xhigh`, and
 *            the account's list has all five. But whether that variant also sets max mode is
 *            a separate field and a different price, and only the table says so
 *   `-fast`  is a parameter on some models and part of the name on others
 *            (`cursor-grok-4.6-high-fast` against `composer-2.5-fast`)
 *
 * The table is fetched once per credential and held: it is the same answer for every request,
 * and a round trip per turn would buy nothing. When it cannot be had, the suffix reading in
 * splitModel() stands in — a model sent slightly wrong is recoverable, and refusing the turn
 * because a second call failed is not.
 */

/** A slug, resolved into the three fields the request carries */
export interface ResolvedModel {
  /** What goes in `model_id` */
  id: string;
  /** What goes in `parameters`, in the `{ id, value }` shape the wire wants */
  parameters: Message[];
  /** What goes in `max_mode` */
  max: boolean;
  /** Where this came from, which is the difference between a fact and a guess */
  from: 'catalog' | 'suffix';
}

interface Catalog {
  /** Every slug the console can offer */
  names: string[];
  /** Every slug Cursor answers to — variants and legacy names included — resolved */
  slugs: Map<string, ResolvedModel>;
}

const MODELS_RPC = '/aiserver.v1.AiService/AvailableModels';

/** How long a fetched catalog stands. Cursor's list moves, but not within a turn. */
const TTL_MS = 5 * 60_000;

/** Keyed by credential and host, so two providers on two accounts do not share one list */
const cache = new Map<string, { at: number; catalog: Catalog }>();

/** Where a request actually goes: the audit proxy when one is in use. null means refuse to send. */
export type Egress = (url: string) => { url: string; headers: Record<string, string> } | null;

const direct: Egress = (url) => ({ url, headers: {} });

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

const parametersOf = (variant: Message | undefined): Message[] =>
  (Array.isArray(variant?.['parameter_values']) ? (variant!['parameter_values'] as Message[]) : [])
    .map((p) => ({ id: str(p['id']), value: str(p['value']) }))
    .filter((p) => p['id']);

/** One model's variants, as resolutions keyed by every slug that selects them */
function variantsOf(model: Message, into: Map<string, ResolvedModel>): void {
  const name = str(model['name']);
  if (!name) return;

  const variants = Array.isArray(model['variants']) ? (model['variants'] as Message[]) : [];
  for (const variant of variants) {
    const resolution: ResolvedModel = {
      id: name,
      parameters: parametersOf(variant),
      max: variant['is_max_mode'] === true,
      from: 'catalog',
    };
    for (const slug of [str(variant['variant_string_representation']), str(variant['legacy_slug'])]) {
      if (slug && !into.has(slug)) into.set(slug, resolution);
    }
  }

  /*
   * The bare name, which a caller may well ask for even on a parameterised model. Whichever
   * variant Cursor marks as its default is the one its own client would have selected; a
   * model with no variants takes no parameters and is simply itself.
   */
  if (!into.has(name)) {
    const preferred = variants.find((v) => v['is_default_non_max_config'] === true)
      ?? variants.find((v) => v['is_default_max_config'] === true);
    into.set(name, {
      id: name,
      parameters: parametersOf(preferred),
      max: preferred?.['is_max_mode'] === true,
      from: 'catalog',
    });
  }

  for (const legacy of Array.isArray(model['legacy_slugs']) ? (model['legacy_slugs'] as unknown[]) : []) {
    const slug = str(legacy);
    if (slug && !into.has(slug)) into.set(slug, { id: name, parameters: [], max: false, from: 'catalog' });
  }
}

export interface CatalogOptions {
  secret: string;
  baseUrl: string;
  /** The `x-cursor-*` set this client presents with, given a request id */
  headers: (requestId: string) => Record<string, string>;
  egress?: Egress;
  signal?: AbortSignal;
}

/** Ask Cursor what this account can use. Throws, so the caller decides what a failure means. */
async function fetchCatalog(opts: CatalogOptions): Promise<Catalog> {
  const base = opts.baseUrl.replace(/\/+$/, '');
  const out = (opts.egress ?? direct)(`${base}${MODELS_RPC}`);
  if (!out) throw new Error('This provider has no audit proxy configured, so the request was refused');

  const token = await accessToken(opts.secret, base, { signal: opts.signal });
  const res = await fetch(out.url, {
    method: 'POST',
    headers: {
      ...opts.headers(crypto.randomUUID()),
      authorization: `Bearer ${token}`,
      'content-type': 'application/proto',
      ...out.headers,
    },
    /*
     * `use_model_parameters` is what asks for the variant table. Without it the answer is the
     * older flat one, where every effort level is a model name of its own and there is nothing
     * to resolve — a list the console can show and this module cannot use.
     */
    body: encode('aiserver.v1.AvailableModelsRequest', { is_nightly: false, use_model_parameters: true }),
    signal: opts.signal ?? AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new Error(`Cursor returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const body = decode('aiserver.v1.AvailableModelsResponse', new Uint8Array(await res.arrayBuffer()));
  const models = Array.isArray(body['models']) ? (body['models'] as Message[]) : [];

  const slugs = new Map<string, ResolvedModel>();
  for (const model of models) variantsOf(model, slugs);

  /*
   * Two lists, and the structured one is the better answer: `model_names` is the flat legacy
   * field, while `models[]` carries what each name actually is. Falling back to the flat one
   * keeps the console working if the structured field goes away; it just cannot resolve
   * variants, which is what the suffix reading is for.
   */
  const flat = (Array.isArray(body['model_names']) ? (body['model_names'] as unknown[]) : []).map(str).filter(Boolean);
  /*
   * Every slug, not just every model name: a console offering `claude-opus-5` alone would hide
   * the effort levels, and on this upstream those are how a model is chosen.
   */
  const names = slugs.size ? [...slugs.keys()].sort() : flat;
  return { names, slugs };
}

/** The catalog for this credential, fetched if it is not held or has aged out */
async function catalogOf(opts: CatalogOptions): Promise<Catalog> {
  const key = JSON.stringify([opts.baseUrl, opts.secret]);
  const hit = cache.get(key);
  if (hit && hit.at + TTL_MS > Date.now()) return hit.catalog;

  const catalog = await fetchCatalog(opts);
  cache.set(key, { at: Date.now(), catalog });
  return catalog;
}

/**
 * What to send for the model a request asked for.
 *
 * Never throws: a catalog that cannot be reached falls back to reading the suffixes. `from`
 * says which happened, so a probe can tell a resolved model from a guessed one.
 */
export async function resolveModel(slug: string, opts: CatalogOptions): Promise<ResolvedModel> {
  try {
    const hit = (await catalogOf(opts)).slugs.get(slug);
    if (hit) return hit;
  } catch {
    // Falls through to the suffix reading, deliberately: the model is the request's subject,
    // not its destination, and a second call failing must not fail the turn
  }
  const split = splitModel(slug);
  return { ...split, from: 'suffix' };
}

/** Every model this account can use, for the console's list */
export async function listModels(opts: CatalogOptions): Promise<{ models: string[]; error?: string }> {
  try {
    const { names } = await catalogOf(opts);
    return names.length ? { models: names } : { models: [], error: 'Cursor returned an empty model list' };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
}

/** For tests, and for a console that has just had its credential changed under it */
export function forget(): void {
  cache.clear();
}

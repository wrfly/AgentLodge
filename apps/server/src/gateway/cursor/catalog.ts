import { accessToken } from './auth.js';
import { decode, encode, type Message } from './codec.js';
import { parseSlug, splitModel } from './request.js';

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
 * And one parameter has no slug at all: the context window. `claude-opus-5[1m]` is how Claude
 * Code names the model it is running as, and no variant stands for it — so it is read off the
 * slug (request.ts, parseSlug) and checked here against the `parameter_definitions` the model
 * carries, which say which parameters it takes and which values each of them accepts. A window
 * nothing is asking for is not sent: the variant's own parameters are what Cursor's client would
 * have sent, and inventing a default would be this end choosing a context size — and a price.
 *
 * Claude Code's names are not Cursor's. A dated Anthropic id (`claude-haiku-4-5-20251001`),
 * an older family id (`claude-3-5-sonnet`, `claude-sonnet-4-5` when this account has no
 * such row), and a short family name (`opus`, `sonnet`, `haiku`, `fable`) all miss the
 * variant table: the date is stripped before lookup, and anything that still names a
 * family rather than a variant is pointed at the newest model of that family this account
 * can actually use — which is what Claude Code means by those words, and not always what
 * Cursor lists as `opus-latest`.
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

/** What a model says it takes: each parameter's id, and the values it will accept for it */
type Parameters = Map<string, Set<string>>;

interface Catalog {
  /** Every slug the console can offer */
  names: string[];
  /** Every slug Cursor answers to — variants and legacy names included — resolved */
  slugs: Map<string, ResolvedModel>;
  /** Keyed by model name, which is what `model_id` carries rather than what a caller asked for */
  parameters: Map<string, Parameters>;
}

const MODELS_RPC = '/aiserver.v1.AiService/AvailableModels';

/** One line when LOG_LEVEL is debug, so a live run can show cache hits without a debugger */
export function cursorLog(msg: string, extra: Record<string, unknown> = {}): void {
  const level = process.env.LOG_LEVEL ?? 'warn';
  if (level !== 'debug' && level !== 'trace') return;
  const rest = Object.keys(extra).length ? ` ${JSON.stringify(extra)}` : '';
  console.log(`[cursor] ${msg}${rest}`);
}

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

/**
 * What one model says its parameters are, and which values each of them takes.
 *
 * Both kinds answer the same way — a boolean parameter lists `"true"` and `"false"` just as an
 * enum lists `"1m"` and `"300k"` — so a caller's value is checked the same way whichever it is.
 */
function definitionsOf(model: Message): Parameters {
  const out: Parameters = new Map();
  const definitions = Array.isArray(model['parameter_definitions'])
    ? (model['parameter_definitions'] as Message[])
    : [];
  for (const definition of definitions) {
    const id = str(definition['id']);
    if (!id) continue;
    const type = definition['parameter_type'] as Message | undefined;
    const arm = (type?.['enum_parameter'] ?? type?.['boolean_parameter']) as Message | undefined;
    const values = Array.isArray(arm?.['values']) ? (arm!['values'] as Message[]) : [];
    out.set(id, new Set(values.map((v) => str(v['value'])).filter(Boolean)));
  }
  return out;
}

/** One model's variants, as resolutions keyed by every slug that selects them */
function variantsOf(model: Message, into: Map<string, ResolvedModel>): ResolvedModel | undefined {
  const name = str(model['name']);
  if (!name) return undefined;

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
  const preferred = variants.find((v) => v['is_default_non_max_config'] === true)
    ?? variants.find((v) => v['is_default_max_config'] === true);
  const fallback: ResolvedModel = into.get(name) ?? {
    id: name,
    parameters: parametersOf(preferred),
    max: preferred?.['is_max_mode'] === true,
    from: 'catalog',
  };
  if (!into.has(name)) into.set(name, fallback);

  /*
   * Names that are not a variant of their own still have to resolve to *something*. An empty
   * parameter list used to be sent for these, which is a silent default — the same as asking
   * for the model with none of the choices its table exists to make. The default variant is
   * the one Cursor itself would have picked.
   */
  for (const slug of [
    ...(Array.isArray(model['legacy_slugs']) ? (model['legacy_slugs'] as unknown[]) : []),
    ...(Array.isArray(model['id_aliases']) ? (model['id_aliases'] as unknown[]) : []),
  ]) {
    const key = str(slug);
    if (!key || into.has(key) || SHORT_NAME.has(key)) continue;
    into.set(key, fallback);
  }

  return fallback;
}

/**
 * The names Claude Code uses for a family, which Cursor scatters across several models.
 *
 * Cursor's own `id_aliases` put `opus` on 4.5, 4.6 and 4.8 at once, and `opus-latest` on
 * 4.8 while Claude Code's `opus` is Opus 5. A gateway that speaks Claude Code on the way
 * in has to pick the newest of the family this account can use, not the first row Cursor
 * happened to list.
 */
const SHORT_NAME = new Set(['opus', 'sonnet', 'haiku', 'fable']);

const familyOf = (name: string): string | undefined => {
  const match = /^claude-(?:3(?:-\d+)?-)?(opus|sonnet|haiku|fable)(?:-|$)/.exec(name);
  return match?.[1];
};

/**
 * Trailing numeric segments, for picking the newest of a family.
 *
 * `claude-opus-5` is `[5]`, `claude-opus-4-8` is `[4, 8]`. A date on the end is ignored
 * here because it is stripped before lookup — see undated().
 */
const versionOf = (name: string): number[] => {
  const rest = name.replace(/^claude-(?:opus|sonnet|haiku|fable)-/, '');
  if (rest === name) return [];
  return rest.split('-').filter((p) => /^\d+$/.test(p)).map(Number);
};

/** Negative when `a` is newer. Compared segment by segment, so 5 beats 4-8. */
const newer = (a: string, b: string): number => {
  const va = versionOf(a);
  const vb = versionOf(b);
  for (let i = 0; i < Math.min(va.length, vb.length); i++) {
    if (va[i] !== vb[i]) return (vb[i] ?? 0) - (va[i] ?? 0);
  }
  // The longer remainder is the newer patch: `claude-opus-4-8` beats `claude-opus-4`.
  return vb.length - va.length;
};

/** Anthropic's dated snapshot id: `claude-haiku-4-5-20251001` is the model `claude-haiku-4-5` */
export const undated = (name: string): string => name.replace(/-\d{8}$/, '');

/**
 * A model identity rather than a variant slug.
 *
 * `claude-sonnet-4-5` and `claude-3-5-sonnet` name a model. `claude-opus-5-thinking-high`
 * names a variant, and those are looked up as written — falling through to the newest of
 * the family would throw away the variant the caller did pick.
 */
function isFamilyIdentity(name: string): boolean {
  if (!familyOf(name)) return false;
  const rest = name.replace(/^claude-(?:3(?:-\d+)?-)?(?:opus|sonnet|haiku|fable)-?/, '');
  return rest === '' || /^[\d-]+$/.test(rest);
}

function applyShortNames(
  defaults: Map<string, { name: string; resolution: ResolvedModel }>,
  into: Map<string, ResolvedModel>,
): void {
  const newest = new Map<string, { name: string; resolution: ResolvedModel }>();
  for (const row of defaults.values()) {
    const family = familyOf(row.name);
    if (!family) continue;
    const cur = newest.get(family);
    if (!cur || newer(row.name, cur.name) < 0) newest.set(family, row);
  }
  for (const [family, row] of newest) into.set(family, row.resolution);
}

/** The lookup tables, from the structured `models[]` Cursor answers with */
export function buildCatalog(models: Message[], flat: string[] = []): Catalog {
  const slugs = new Map<string, ResolvedModel>();
  const parameters = new Map<string, Parameters>();
  const defaults = new Map<string, { name: string; resolution: ResolvedModel }>();

  for (const model of models) {
    const resolution = variantsOf(model, slugs);
    const name = str(model['name']);
    if (name) {
      parameters.set(name, definitionsOf(model));
      if (resolution) defaults.set(name, { name, resolution });
    }
  }
  applyShortNames(defaults, slugs);

  const names = slugs.size ? [...slugs.keys()].sort() : flat;
  return { names, slugs, parameters };
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
  const flat = (Array.isArray(body['model_names']) ? (body['model_names'] as unknown[]) : []).map(str).filter(Boolean);
  /*
   * Two lists, and the structured one is the better answer: `model_names` is the flat legacy
   * field, while `models[]` carries what each name actually is. Falling back to the flat one
   * keeps the console working if the structured field goes away; it just cannot resolve
   * variants, which is what the suffix reading is for.
   *
   * Every slug, not just every model name: a console offering `claude-opus-5` alone would hide
   * the effort levels, and on this upstream those are how a model is chosen.
   */
  return buildCatalog(models, flat);
}

/** The catalog for this credential, fetched if it is not held or has aged out */
async function catalogOf(opts: CatalogOptions): Promise<Catalog> {
  const key = JSON.stringify([opts.baseUrl, opts.secret]);
  const hit = cache.get(key);
  if (hit && hit.at + TTL_MS > Date.now()) {
    cursorLog('catalog cache hit', {
      host: opts.baseUrl,
      ageMs: Date.now() - hit.at,
      ttlMs: TTL_MS,
      slugs: hit.catalog.slugs.size,
    });
    return hit.catalog;
  }

  cursorLog('catalog fetch', { host: opts.baseUrl });
  const catalog = await fetchCatalog(opts);
  cache.set(key, { at: Date.now(), catalog });
  cursorLog('catalog fetched', {
    host: opts.baseUrl,
    models: catalog.parameters.size,
    slugs: catalog.slugs.size,
  });
  return catalog;
}

/**
 * A resolution with a caller's own parameters applied, where the model accepts them.
 *
 * A copy rather than an edit in place: one resolution object is shared by every slug that
 * selects the same variant, so writing this caller's context window into it would hand that
 * window to everybody who asked for the model afterwards.
 *
 * Anything the model does not declare is dropped rather than sent. A parameter Cursor does not
 * know, or a value outside the set it listed, is an `invalid_argument` that fails the whole
 * turn — and the request is perfectly good without it.
 */
function withParameters(model: ResolvedModel, asked: Map<string, string>, accepts?: Parameters): ResolvedModel {
  const parameters = model.parameters.map((p) => ({ ...p }));
  for (const [id, value] of asked) {
    if (!accepts?.get(id)?.has(value)) continue;
    const at = parameters.findIndex((p) => p['id'] === id);
    if (at >= 0) parameters[at] = { id, value };
    else parameters.push({ id, value });
  }
  return { ...model, parameters };
}

/**
 * What to send for the model a request asked for.
 *
 * Never throws: a catalog that cannot be reached falls back to reading the suffixes. `from`
 * says which happened, so a probe can tell a resolved model from a guessed one.
 *
 * The bracket a caller may have written — `claude-opus-5[1m]` — is taken off before the lookup
 * and applied after it, because it names a parameter rather than a variant and no slug in the
 * catalogue carries one. A date Anthropic stamps on a snapshot — `claude-haiku-4-5-20251001`
 * — comes off the same way: Cursor's table has the undated name. A family identity that still
 * is not in the table (`claude-sonnet-4-5`, `claude-3-5-sonnet`) takes the newest of that
 * family, the same answer the short name would have got.
 */
export async function resolveModel(slug: string, opts: CatalogOptions): Promise<ResolvedModel> {
  const { base, parameters: asked } = parseSlug(slug);
  try {
    const catalog = await catalogOf(opts);
    const stem = undated(base);
    const family = familyOf(stem);
    const hit = catalog.slugs.get(base)
      ?? catalog.slugs.get(stem)
      ?? (family && isFamilyIdentity(stem) ? catalog.slugs.get(family) : undefined);
    if (hit) {
      const resolved = asked.size ? withParameters(hit, asked, catalog.parameters.get(hit.id)) : hit;
      cursorLog('resolve', {
        asked: slug,
        id: resolved.id,
        from: resolved.from,
        max: resolved.max,
        params: resolved.parameters,
      });
      return resolved;
    }
  } catch {
    // Falls through to the suffix reading, deliberately: the model is the request's subject,
    // not its destination, and a second call failing must not fail the turn
  }
  /*
   * The suffixes, of the slug without its bracket. The parameters the bracket asked for are
   * dropped with the catalogue that would have checked them: sending one unverified is how a
   * turn fails outright, and the window it names is a preference rather than the request.
   */
  const split = splitModel(undated(base));
  cursorLog('resolve suffix', { asked: slug, id: split.id, max: split.max, params: split.parameters });
  return { ...split, from: 'suffix' };
}

/** Every model this account can use, for the console's list */
export async function listModels(opts: CatalogOptions): Promise<{ models: string[]; error?: string }> {
  try {
    const { names } = await catalogOf(opts);
    // Brackets carry parameters (`[1m]`, `[fast=false]`), not a model identity. Pulling
    // them as rows floods the picker and hands Claude Code a `--model` it will refuse.
    const models = names.filter((n) => !n.includes('['));
    return models.length ? { models } : { models: [], error: 'Cursor returned an empty model list' };
  } catch (e) {
    return { models: [], error: (e as Error).message };
  }
}

/** For tests, and for a console that has just had its credential changed under it */
export function forget(): void {
  cache.clear();
}

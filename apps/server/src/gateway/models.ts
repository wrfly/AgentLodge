import * as providers from '../core/db/providers.js';
import { outboundHeaders } from './upstream.js';

/**
 * Asking an upstream what models it has.
 *
 * Claude Code has no "list models" command and Codex reads a file, so the console's model
 * list has always been typed in by hand. The endpoint exists on the upstream, though, and
 * the one process allowed to use the real key is this one — so the question has to be asked
 * here and the answer handed back.
 *
 * Both shapes in use put the name in the same place:
 *
 *   Anthropic          GET /v1/models   → { data: [{ id, display_name }], has_more }
 *   OpenAI-compatible  GET /models      → { object: 'list', data: [{ id }] }
 *
 * so `data[].id` is the whole of the parsing. Anything else — a compatibility layer that
 * never implemented it, a local model server, the built-in mock — comes back as a reason
 * rather than an empty list, because "this upstream cannot tell you" and "this upstream has
 * no models" would look identical in the console and mean opposite things.
 */

export interface ModelsResult {
  models: string[];
  /** Present when the upstream could not answer; the console shows it instead of a list */
  error?: string;
}

/**
 * Where the list lives for this kind of upstream.
 *
 * null means there is nothing to ask: the mock and the local agent never speak HTTP.
 */
function modelsUrl(p: providers.Provider): string | null {
  const base = p.baseUrl.replace(/\/+$/, '');
  if (p.kind === 'mock' || p.kind === 'local-agent') return null;
  if (p.kind === 'openai-chat') return `${base}/models`;
  // anthropic-native. The base may carry a vendor's compatibility prefix (DeepSeek's
  // /anthropic); the models endpoint is on the root, so it is stripped the same way
  // resolveUpstream strips it for the other wires.
  return `${base.replace(/\/anthropic$/, '')}/v1/models`;
}

interface ModelListing {
  data?: Array<{ id?: string }>;
}

/**
 * @param egress decides where this actually goes — the audit proxy when one is in use, so
 * the request is recorded like every other. null means egress is refused, which is the same
 * answer /v1/messages gives when auditing is required and unconfigured: a missing
 * configuration must not become a silent direct connection.
 */
export async function fetchModels(
  provider: providers.Provider,
  apiKey: string,
  egress: (upstreamUrl: string) => { url: string; headers: Record<string, string> } | null,
): Promise<ModelsResult> {
  const url = modelsUrl(provider);
  if (!url) {
    return { models: [], error: `"${providers.KIND_LABEL[provider.kind]}" answers no model list` };
  }
  if (!apiKey) return { models: [], error: 'This provider has no API key configured' };

  const out = egress(url);
  if (!out) {
    return { models: [], error: 'This provider has no audit proxy configured, so the request was refused' };
  }

  const wire = provider.kind === 'openai-chat' ? 'chat' : 'anthropic';
  try {
    const res = await fetch(out.url, {
      method: 'GET',
      headers: { ...outboundHeaders({}, wire, apiKey), ...out.headers },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      // 404 is the ordinary answer from a compatibility layer that stops at /v1/messages
      return {
        models: [],
        error:
          res.status === 404
            ? `The upstream has no model list at ${url}`
            : `The upstream returned ${res.status}`,
      };
    }
    const body = (await res.json()) as ModelListing;
    const models = (body.data ?? [])
      .map((m) => m.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return models.length ? { models } : { models: [], error: 'The upstream returned an empty list' };
  } catch (e) {
    return { models: [], error: `Could not reach the upstream: ${(e as Error).message}` };
  }
}

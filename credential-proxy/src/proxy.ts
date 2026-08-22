import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { UsageAccumulator } from './usage.js';
import { metering, usageToRecord } from './metering.js';
import { extractToken } from './token.js';

/** Hop-by-hop headers, which must not be forwarded as they are */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'host',
  'content-encoding',
]);

export interface ForwardSpec {
  provider: string;
  upstreamUrl: string;
  /** Upstream authentication headers; these override anything the caller sent under the same name */
  authHeaders: Record<string, string>;
  /** On a 401, refresh the credentials and retry exactly once */
  onUnauthorized?: () => Promise<Record<string, string>>;
  body: Buffer | null;
}

/** Who called: an explicit declaration if there is one, otherwise a short hash of the token, otherwise anonymous */
function clientIdOf(req: FastifyRequest): string {
  const explicit = req.headers['x-gateway-client'];
  if (typeof explicit === 'string' && explicit) return explicit.slice(0, 64);
  const tok = extractToken(req);
  if (tok) return 'tok:' + crypto.createHash('sha256').update(tok).digest('hex').slice(0, 8);
  return 'anonymous';
}

export async function forward(
  req: FastifyRequest,
  reply: FastifyReply,
  spec: ForwardSpec,
): Promise<void> {
  const started = Date.now();
  const client = clientIdOf(req);

  // The caller's headers pass through untouched, minus the hop-by-hop ones and anything that
  // would collide with upstream authentication
  const outHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    const lk = k.toLowerCase();
    if (HOP_BY_HOP.has(lk)) continue;
    if (lk === 'authorization' || lk === 'x-api-key' || lk === 'x-gateway-token') continue;
    if (typeof v === 'string') outHeaders[lk] = v;
    else if (Array.isArray(v)) outHeaders[lk] = v.join(', ');
  }
  Object.assign(outHeaders, spec.authHeaders);

  const doFetch = async (headers: Record<string, string>): Promise<Response> => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), config.upstreamTimeoutMs);
    req.raw.on('close', () => ac.abort());
    try {
      return await fetch(spec.upstreamUrl, {
        method: req.method,
        headers,
        // A Buffer is not a BodyInit, so hand over a Uint8Array
        body:
          req.method === 'GET' || req.method === 'HEAD' || !spec.body
            ? undefined
            : new Uint8Array(spec.body),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  };

  let upstream: Response;
  try {
    upstream = await doFetch(outHeaders);
    if (upstream.status === 401 && spec.onUnauthorized) {
      await upstream.body?.cancel();
      Object.assign(outHeaders, await spec.onUnauthorized());
      upstream = await doFetch(outHeaders);
    }
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Upstream timed out or the connection dropped' : (e as Error).message;
    metering.record(
      usageToRecord(
        {
          ts: started, provider: spec.provider, path: req.url, status: 502,
          durationMs: Date.now() - started, stream: false, client, model: 'unknown',
        },
        { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      ),
    );
    if (!reply.sent) await reply.code(502).send({ error: { message: msg } });
    return;
  }

  const contentType = upstream.headers.get('content-type') ?? '';
  const isStream = contentType.includes('text/event-stream');

  const respHeaders: Record<string, string> = {};
  upstream.headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) respHeaders[k] = v;
  });

  const acc = new UsageAccumulator();
  const finish = (): void => {
    metering.record(
      usageToRecord(
        {
          ts: started, provider: spec.provider, path: req.url, status: upstream.status,
          durationMs: Date.now() - started, stream: isStream, client,
        },
        acc.usage,
      ),
    );
  };

  // Usage is extracted as the bytes go past, so the whole response never has to be buffered
  reply.hijack();
  reply.raw.writeHead(upstream.status, respHeaders);

  if (!upstream.body) {
    reply.raw.end();
    finish();
    return;
  }

  const decoder = new TextDecoder();
  const reader = upstream.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        acc.feedBody(decoder.decode(value, { stream: true }), contentType);
        if (!reply.raw.write(Buffer.from(value))) {
          await new Promise((r) => reply.raw.once('drain', r));
        }
      }
    }
  } catch {
    /* The client went away, or the upstream cut us off */
  } finally {
    reply.raw.end();
    finish();
  }
}

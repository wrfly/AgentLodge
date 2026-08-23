import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { config } from '../core/config.js';
import { auditProxyBase, auditProxyEnabled, requiresAuditProxy } from '../core/egress.js';
import * as usageRepo from '../core/db/usage.js';
import * as quota from '../core/quota.js';
import * as trace from '../core/trace.js';
import { publish } from '../core/events.js';
import {
  AbortedError,
  OverloadedError,
  QueueTimeoutError,
  UpstreamGate,
  type GateStats,
} from './gate.js';
import {
  resolve as resolveCredential,
  splitPathCredential,
  tokenFromHeaders,
  type Principal,
} from '../core/credential.js';
import { attachUser, requireAdmin } from '../core/auth/guard.js';
import { inspect, listCandidates } from '../core/secret-file.js';
import { installLocale, tr } from '../core/i18n/locale.js';
import { localAgentText, mockStream, outboundHeaders, resolveUpstream, type Resolved } from './upstream.js';
import {
  ChatToAnthropic,
  ChatToResponses,
  anthropicRequestToChat,
  chatResponseToAnthropic,
  responsesRequestToChat,
  type AnthropicRequest,
  type ResponsesRequest,
} from './translate.js';
import { SseSniffer, absorbBody, absorbStream, newUsageAcc, type Wire } from './usage-parser.js';
import {
  RateLimitScrubber,
  oauthUsage,
  stripRateLimits,
  unifiedHeaders,
} from './quota-report.js';
import * as allowance from './upstream-allowance.js';
import { fetchModels } from './models.js';
import { startModelRefresh } from './model-refresh.js';
import * as providersRepo from '../core/db/providers.js';

/**
 * The metering gateway.
 *
 * Every upstream request from an agent process goes through here — the one place that
 * accounts for usage, enforces quota, rate-limits, and holds the real key.
 *
 * It currently shares a process with the main service on a different port. Splitting it
 * into its own container is a matter of listening on this file alone; the code does not
 * change.
 */

export const gate = new UpstreamGate({
  maxConcurrency: config.maxUpstreamConcurrency,
  maxQueueDepth: config.maxQueueDepth,
  queueTimeoutMs: config.queueTimeoutMs,
  leaseMaxMs: config.leaseMaxMs,
  perUserInflightMax: config.perUserInflightMax,
});

/* ---------------- Error shapes ---------------- */

/**
 * The error type decides whether the CLI retries, and getting it wrong causes a retry
 * storm. Measured: Claude Code retries a 500 eleven times, Codex five.
 *   permission_error / invalid_request_error → no retry
 *   rate_limit_error / overloaded_error      → retried with backoff
 */
function anthropicError(type: string, message: string) {
  return { type: 'error', error: { type, message } };
}
function openaiError(type: string, message: string, code?: string) {
  return { error: { message, type, code: code ?? type, param: null } };
}

function sendError(
  reply: FastifyReply,
  wire: Wire,
  status: number,
  anthropicType: string,
  openaiType: string,
  message: string,
): FastifyReply {
  return reply
    .code(status)
    .send(
      wire === 'anthropic'
        ? anthropicError(anthropicType, message)
        : openaiError(openaiType, message),
    );
}

/* ---------------- Forwarding ---------------- */

interface Egress {
  /** The address actually fetched */
  url: string;
  /** Routing headers added when a proxy is configured */
  headers: Record<string, string>;
}

/**
 * The address actually fetched.
 *
 * With an audit proxy configured the request goes to the proxy, carrying the original path
 * and query unchanged — on the proxy's side `new URL(req.url, UPSTREAM_URL)` rebuilds the
 * same address, since its UPSTREAM_URL is pinned to that upstream. Which is why each
 * upstream needs its own proxy instance and they cannot share one.
 *
 * null means **refuse to go out**. What audit promises is that everything that left was
 * recorded, so a missing configuration has to be an error rather than a silent direct
 * connection — otherwise the books contain a stretch of unrecorded traffic.
 */
function egressTarget(target: Resolved): Egress | null {
  // Audit proxy off means direct: no proxy, and the two x-forwarded-* headers below are
  // never sent
  const proxy = auditProxyEnabled() ? auditProxyBase() : '';
  if (!proxy) {
    return requiresAuditProxy(target.provider.kind, target.url)
      ? null
      : { url: target.url, headers: {} };
  }
  const real = new URL(target.url);
  return {
    url: new URL(real.pathname + real.search, proxy).toString(),
    /*
     * Tells the proxy where to relay this one, which is what lets a single shared instance
     * serve every upstream.
     *
     * Why not just set `Host`: the gateway uses Node's fetch, and undici treats Host as a
     * forbidden header and **drops it silently** — measured: setting it neither sends it
     * nor errors. Setting Host would mean moving the outbound side to node:http, which
     * means rewriting the SSE relay and usage sniffing below. `x-forwarded-*` is the
     * standard way to say this through a reverse proxy, means the same thing, and fetch
     * allows it.
     *
     * Host cannot carry a scheme either, so proto needs a header of its own regardless.
     */
    headers: {
      'x-forwarded-host': real.host,
      'x-forwarded-proto': real.protocol.replace(':', ''),
    },
  };
}


/**
 * Keep the active provider's model list current, once an hour, when the setting says so.
 *
 * Started from here rather than from the module itself because egressTarget lives in this
 * file: the refresher must leave the same way every other request does, audit proxy
 * included.
 */
export function startModelAutoRefresh(log: (message: string) => void): void {
  startModelRefresh(
    (provider) => (upstreamUrl) =>
      egressTarget({
        url: upstreamUrl,
        wire: 'anthropic',
        translate: false,
        apiKey: providersRepo.secretOf(provider.id) ?? '',
        provider,
      }),
    log,
  );
}

/** The model list for one provider, sent out under the same audit rules as everything else */
async function modelsFor(provider: providersRepo.Provider | undefined): Promise<{ models: string[]; error?: string }> {
  if (!provider) return { models: [], error: 'No upstream provider is enabled' };
  const apiKey = providersRepo.secretOf(provider.id) ?? '';
  return fetchModels(provider, apiKey, (upstreamUrl) =>
    egressTarget({ url: upstreamUrl, wire: 'anthropic', translate: false, apiKey, provider }),
  );
}

/**
 * Where rewriteUrl leaves the credential it took out of the path.
 *
 * A Symbol on the raw request rather than a custom header: headers are client-writable, so
 * anyone could claim to have supplied a credential. Only this process can reach a Symbol.
 */
const PATH_CREDENTIAL = Symbol('agentlodge.pathCredential');
type RawWithCredential = FastifyRequest['raw'] & { [PATH_CREDENTIAL]?: string };

/**
 * Which credential this request uses. **The path wins over the header.**
 *
 * With only `ANTHROPIC_BASE_URL=…/u/<credential>` set, the CLI keeps its claude.ai login,
 * so Authorization carries **the user's own Anthropic token**. That is not our credential,
 * and trying it first would 401 a request that is perfectly valid.
 *
 * That header is neither forwarded nor recorded: outboundHeaders overwrites authorization
 * with the upstream credential, and it is not on the passthrough allowlist.
 */
function credentialOf(req: FastifyRequest): string | undefined {
  return (req.raw as RawWithCredential)[PATH_CREDENTIAL] ?? tokenFromHeaders(req.headers);
}

async function handleProxy(
  req: FastifyRequest,
  reply: FastifyReply,
  wire: Wire,
): Promise<FastifyReply | undefined> {
  // Two credentials: the 20-minute ticket from a container, and the long-lived api key a
  // user's own CLI carries. Past this point every step treats them the same; the only
  // difference is that an api key has no cid/tid.
  const claims = await resolveCredential(credentialOf(req), wire);
  if (!claims) {
    return sendError(reply, wire, 401, 'authentication_error', 'invalid_request_error', tr(req, 'The credential is invalid or has expired'));
  }

  const target = resolveUpstream(wire, req.url);
  if (!target) {
    return sendError(
      reply,
      wire,
      503,
      'api_error',
      'server_error',
      tr(req, 'The server has no upstream provider enabled; ask an administrator'),
    );
  }
  // The mock upstream and the local agent need no key; for any other kind, a missing key
  // is a misconfiguration
  const needsKey = target.provider.kind === 'anthropic-native' || target.provider.kind === 'openai-chat';
  if (needsKey && !target.apiKey && !target.url.startsWith('http://127.0.0.1')) {
    return sendError(
      reply,
      wire,
      503,
      'api_error',
      'server_error',
      // With a key held in a file, "could not read it" and "not configured" are different
      // problems: one is fixed in the console, the other by checking the mount. The reason
      // — missing, no permission, wrong contents — is in the server log; see secretOf
      target.provider.keyFile
        ? tr(req, 'The API key file for upstream "{name}" cannot be read ({path}); ask an administrator', {
            name: target.provider.name,
            path: target.provider.keyFile,
          })
        : tr(req, 'Upstream "{name}" has no API key configured; ask an administrator', {
            name: target.provider.name,
          }),
    );
  }

  /*
   * The audit gate: no proxy configured, no egress.
   *
   * Before taking a slot, because a misconfiguration is an operational problem and should
   * not sit in the concurrency queue. A 503 rather than a general 5xx: this is the
   * server's own configuration and has nothing to do with the upstream, and the message
   * names the provider so it is not chased as an upstream fault.
   */
  if (egressTarget(target) === null) {
    req.log.error(
      { provider: target.provider.name },
      'gateway refused egress: this upstream has no audit proxy configured '
      + '(enforcement is on and can be turned off under Audit proxy in the console)',
    );
    return sendError(
      reply, wire, 503, 'api_error', 'server_error',
      tr(req, 'Upstream "{name}" has no audit proxy configured, so the request was refused. Ask an administrator.', {
        name: target.provider.name,
      }),
    );
  }

  // The hard quota gate — the only place that can stop a turn while it is running
  const verdict = quota.check(claims.sub);
  if (!verdict.allow) {
    // A non-retryable type, or the CLI hammers the gateway with retries
    return sendError(reply, wire, 402, 'permission_error', 'invalid_request_error', verdict.reason!);
  }

  const body = req.body as Record<string, unknown> | undefined;
  // A small max_tokens with no tools is almost always background work such as title
  // generation, so it queues behind interactive requests
  const isBackground =
    typeof body?.max_tokens === 'number' && body.max_tokens <= 512 && !body.tools;

  const ac = new AbortController();
  /**
   * Disconnect detection has to be attached to both the request and the response.
   *
   * Measured: with a streaming response, req.raw's 'close' does not fire promptly when the
   * client goes away. Listening only to it means the slot is not returned until the
   * upstream finishes on its own — in load testing, three seconds after the disconnect.
   */
  const onDisconnect = () => ac.abort();
  req.raw.on('close', onDisconnect);
  req.raw.on('aborted', onDisconnect);
  reply.raw.on('close', onDisconnect);
  reply.raw.on('error', onDisconnect);

  let lease;
  try {
    lease = await gate.acquire({
      userId: claims.sub,
      turnId: claims.tid,
      priority: isBackground ? 1 : 0,
      signal: ac.signal,
      onQueued: (position) => {
        if (claims.cid) {
          publish(claims.cid, { type: 'queue.waiting', turnId: claims.tid, position });
        }
      },
    });
  } catch (err) {
    if (err instanceof OverloadedError) {
      reply.header('retry-after', '5');
      return sendError(reply, wire, 529, 'overloaded_error', 'rate_limit_exceeded', tr(req, 'The gateway is busy; try again shortly'));
    }
    if (err instanceof QueueTimeoutError) {
      reply.header('retry-after', '10');
      return sendError(reply, wire, 429, 'rate_limit_error', 'rate_limit_exceeded', tr(req, 'Timed out waiting in the queue; try again'));
    }
    if (err instanceof AbortedError) return undefined; // the client went away
    throw err;
  }

  const acc = newUsageAcc();
  const startedAt = Date.now();
  let status = 0;

  try {
    /* A built-in kind: no network, the response is built here */
    if (target.provider.kind === 'mock' || target.provider.kind === 'local-agent') {
      status = 200;
      const stream =
        target.provider.kind === 'mock'
          ? mockStream(wire, body)
          : mockStream(wire, body, await localAgentText(body, ac.signal));
      absorbStream(wire, stream, acc);
      acc.ttftMs = Date.now() - startedAt;
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        ...(wire === 'anthropic' ? unifiedHeaders(verdict.status) : {}),
      });
      reply.raw.write(stream);
      reply.raw.end();
      return undefined;
    }

    const reqModel =
      ((body ?? {}) as AnthropicRequest & ResponsesRequest).model ?? 'local';
    const outbound = !target.translate
      ? (body ?? {})
      : wire === 'anthropic'
        ? anthropicRequestToChat((body ?? {}) as AnthropicRequest, reqModel)
        : responsesRequestToChat((body ?? {}) as ResponsesRequest, reqModel);

    // null was already refused above, so this cannot fall back to a direct connection
    const egress = egressTarget(target)!;
    const upstream = await fetch(egress.url, {
      method: 'POST',
      headers: { ...outboundHeaders(req.headers, target.wire, target.apiKey), ...egress.headers },
      body: JSON.stringify(outbound),
      signal: ac.signal,
    });

    status = upstream.status;
    /*
     * The upstream's allowance headers stop here — the client is told about its own quota
     * instead. They are still the only place the shared plan's real figures exist, and the
     * administrator has to be able to see them, so they are kept before being dropped.
     */
    allowance.record(target.provider.name, target.wire, upstream.headers);
    const retryAfter = Number(upstream.headers.get('retry-after')) * 1000;
    gate.reportUpstream(status, Number.isFinite(retryAfter) ? retryAfter : undefined);

    const ct = upstream.headers.get('content-type') ?? 'application/json';
    /*
     * The upstream's own headers are not forwarded — only the ones below are written, and
     * that is deliberate: a shared subscription's allowance headers describe the pool, so
     * relaying them would show every user the whole platform's consumption. The allowance
     * this user gets told about is their own quota. See quota-report.ts.
     *
     * The figure is the one the quota gate read on the way in, which does not yet include
     * this request — deliberately, since it has not been billed either. Reading it again
     * here would cost a second query to move the number by one turn.
     */
    reply.raw.writeHead(status, {
      'content-type': ct,
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      ...(wire === 'anthropic' ? unifiedHeaders(verdict.status) : {}),
    });

    if (!upstream.body) {
      reply.raw.end();
    } else if (ct.includes('text/event-stream')) {
      // Streaming: relay the bytes untouched while sniffing usage alongside. When
      // translation is needed this becomes upstream bytes → translator → client, and usage
      // is still parsed from the upstream copy, so accounting uses the real numbers rather
      // than the ones we produced.
      const sniffer = new SseSniffer(target.wire, acc);
      const translator = !target.translate
        ? null
        : wire === 'anthropic'
          ? new ChatToAnthropic(reqModel)
          : new ChatToResponses(reqModel);
      /*
       * Codex carries the shared account's allowance inside the body rather than in
       * headers, so on that side the bytes cannot simply be relayed. A translated stream
       * needs no scrubbing: it is built here from the upstream's content, and nothing that
       * is not deliberately copied survives.
       */
      const scrubber =
        !translator && wire !== 'anthropic'
          ? new RateLimitScrubber((rl) => allowance.recordCodex(target.provider.name, target.wire, rl))
          : null;
      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!acc.ttftMs) acc.ttftMs = Date.now() - startedAt;
        const text = decoder.decode(value, { stream: true });
        sniffer.push(text);
        // The other end has gone; stop writing and finish so the slot is returned
        if (reply.raw.destroyed || ac.signal.aborted) {
          await reader.cancel().catch(() => {});
          break;
        }
        // Untouched paths write the original bytes, not the decoded text, so a relay that
        // rewrites nothing stays byte-identical
        reply.raw.write(
          translator
            ? Buffer.from(translator.push(text))
            : scrubber
              ? Buffer.from(scrubber.push(text))
              : Buffer.from(value),
        );
      }
      if (!reply.raw.destroyed) {
        if (translator) reply.raw.write(Buffer.from(translator.end()));
        else if (scrubber) reply.raw.write(Buffer.from(scrubber.end()));
      }
      reply.raw.end();
    } else {
      const text = await upstream.text();
      acc.ttftMs = Date.now() - startedAt;
      absorbBody(target.wire, text, acc);
      // Non-streaming is rare — probes and fallbacks — but a Codex-shaped body would carry
      // the shared account's allowance in it just the same
      reply.raw.write(
        target.translate && wire === 'anthropic'
          ? chatResponseToAnthropic(text, reqModel)
          : wire === 'anthropic'
            ? text
            : (stripRateLimits(text, (rl) => allowance.recordCodex(target.provider.name, target.wire, rl)) ?? text),
      );
      reply.raw.end();
    }
  } catch (err) {
    if (!ac.signal.aborted) {
      req.log.error({ err }, 'gateway upstream failed');
      if (!reply.raw.headersSent) {
        // A dead proxy and a dead upstream have to be told apart: one is our component,
        // the other is theirs. Reporting both as "the upstream request failed" sends
        // whoever is on call to the provider's status page while the problem is here.
        const viaProxy = auditProxyBase();
        const msg = viaProxy
          ? tr(req, 'The audit proxy is unreachable ({url}); the request was not sent', { url: viaProxy })
          : tr(req, 'The upstream request failed');
        reply.raw.writeHead(502, { 'content-type': 'application/json' });
        reply.raw.write(
          JSON.stringify(
            wire === 'anthropic' ? anthropicError('api_error', msg) : openaiError('server_error', msg),
          ),
        );
      }
      reply.raw.end();
    }
  } finally {
    req.raw.off('close', onDisconnect);
    req.raw.off('aborted', onDisconnect);
    reply.raw.off('close', onDisconnect);
    reply.raw.off('error', onDisconnect);
    // Released in finally because all three paths — success, throw, client disconnect —
    // have to return the slot. Missing one permanently costs a third of the capacity
    lease.release();
    const latencyMs = Date.now() - startedAt;
    settle(claims, acc, { status, latencyMs, queueWaitMs: lease.waitedMs });

    // So a user can see what actually went upstream. A structured summary of the request
    // side, recorded on failure too — the failed one is usually the one they want to see
    trace.record({
      userId: claims.sub,
      conversationId: claims.cid || undefined,
      turnId: claims.tid || undefined,
      agent: claims.agent,
      credential: claims.kind,
      wire,
      upstream: target?.provider.name,
      body: req.body,
      status,
      durationMs: latencyMs,
      ttftMs: acc.ttftMs,
      queueWaitMs: lease.waitedMs,
      usage: {
        inputTokens: acc.inputTokens,
        cacheReadTokens: acc.cacheReadTokens,
        cacheCreationTokens: acc.cacheCreationTokens,
        outputTokens: acc.outputTokens,
      },
    });
  }

  return undefined;
}

/* ---------------- Accounting ---------------- */

function settle(
  claims: Principal,
  acc: ReturnType<typeof newUsageAcc>,
  meta: { status: number; latencyMs: number; queueWaitMs: number },
): void {
  const total =
    acc.inputTokens + acc.cacheReadTokens + acc.cacheCreationTokens + acc.outputTokens;
  if (total === 0) return; // nothing was used, an auth failure say, so nothing is booked

  usageRepo.record({
    userId: claims.sub,
    conversationId: claims.cid || undefined,
    turnId: claims.tid || undefined,
    agent: claims.agent,
    model: acc.model,
    usage: {
      inputTokens: acc.inputTokens,
      cacheReadTokens: acc.cacheReadTokens,
      cacheCreationTokens: acc.cacheCreationTokens,
      outputTokens: acc.outputTokens,
      costUsd: 0, // the gateway knows no unit prices; the price table converts this later
      durationMs: meta.latencyMs,
      numTurns: 1,
    },
    source: 'gateway',
    apiKeyId: claims.apiKeyId,
    status: meta.status >= 200 && meta.status < 300 ? 'completed' : 'error',
    queueWaitMs: meta.queueWaitMs,
    ttftMs: acc.ttftMs,
  });

  // ⚠️ events is an **in-process** bus and the SSE connections live in the app process.
  // Once ROLE=gateway is split out, this push never reaches a browser — the app still
  // pushes once when the turn ends (see turns.ts), so what is lost is the live refresh
  // during a turn. queue.waiting disappears entirely for the same reason. The real fix is
  // a cross-process event bus; a warning is logged about this at startup.
  if (claims.cid) {
    publish(claims.cid, { type: 'quota.updated', quota: quota.status(claims.sub) });
  }
}

/* ---------------- The server ---------------- */

export function buildGateway(): FastifyInstance {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'warn' },
    bodyLimit: 32 * 1024 * 1024, // a long-context request body can be large

    /*
     * A credential can ride in the URL path (`/u/<credential>/v1/messages`; see
     * core/credential.ts).
     *
     * Stripped here rather than in a route because rewriteUrl runs **before routing**:
     * everything downstream that can see a URL — the route table, Fastify's own request
     * logging, error messages — only ever sees the stripped path. A credential in a URL
     * leaks more readily than one in a header; the least we can do is not copy it into our
     * own logs.
     */
    rewriteUrl(req) {
      const { token, rest } = splitPathCredential(req.url ?? '/');
      if (token) (req as RawWithCredential)[PATH_CREDENTIAL] = token;
      return rest;
    },
  });

  // Same as the app side: the locale has to be available before any error is built. The
  // gateway needs it more than the app does — its errors are printed by a CLI.
  app.addHook('onRequest', async (req) => installLocale(req));

  // Claude Code probes with HEAD /api/hello before starting
  app.route({
    method: ['HEAD', 'GET'],
    url: '/api/hello',
    handler: async () => ({ ok: true }),
  });

  app.post('/v1/messages', (req, reply) => handleProxy(req, reply, 'anthropic'));

  /**
   * Claude Code uses this to estimate context length. It takes no concurrency slot and is
   * not billed, but it **has to be authenticated**.
   *
   * It used to be wide open while forwarding with the real upstream key. Bound to
   * 127.0.0.1 that was harmless; the moment the gateway is exposed publicly — which is how
   * a user's own CLI connects — it becomes a free "use our key against the upstream"
   * endpoint, and a way to burn through the upstream's rate limit.
   *
   * It also used to bypass the provider registry and read DeepSeek's settings directly, so
   * switching upstream in the console did not affect it. It now resolves the same way
   * /v1/messages does.
   */
  app.post('/v1/messages/count_tokens', async (req, reply) => {
    const who = await resolveCredential(credentialOf(req), 'anthropic');
    if (!who) {
      return reply.code(401).send(anthropicError('authentication_error', tr(req, 'The credential is invalid or has expired')));
    }

    const target = resolveUpstream('anthropic', '/v1/messages/count_tokens');
    const egress = target && egressTarget(target);
    if (target && egress && target.apiKey && !target.translate) {
      try {
        const res = await fetch(egress.url, {
          method: 'POST',
          headers: { ...outboundHeaders(req.headers, 'anthropic', target.apiKey), ...egress.headers },
          body: JSON.stringify(req.body ?? {}),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return reply.code(200).send(await res.json());
      } catch {
        /* Fall through to the local estimate below */
      }
    }
    // Roughly 1.5 characters per token for Chinese and 4 for English; split the difference
    const approx = Math.ceil(JSON.stringify(req.body ?? {}).length / 3);
    return reply.code(200).send({ input_tokens: approx });
  });

  /**
   * What Claude Code's `/usage` panel reads.
   *
   * The upstream has this endpoint and it answers for **the shared subscription**, so the
   * one thing that must not happen is a passthrough. It is answered here, from the asking
   * user's own quota, and the upstream is never consulted.
   *
   * Authenticated exactly like /v1/messages: same credential, same resolution. A CLI that
   * kept its claude.ai login sends that login in Authorization, which is not a credential
   * of ours — the path credential is what identifies the user, and it wins (credentialOf).
   */
  app.get('/api/oauth/usage', async (req, reply) => {
    const who = await resolveCredential(credentialOf(req), 'anthropic');
    if (!who) {
      return reply
        .code(401)
        .send(anthropicError('authentication_error', tr(req, 'The credential is invalid or has expired')));
    }
    return reply.code(200).send(oauthUsage(quota.status(who.sub)));
  });

  /**
   * What models this upstream has.
   *
   * The real key never leaves this process, so the question can only be asked here — the
   * console reaches it through the admin route below rather than calling the upstream
   * itself. Authenticated like count_tokens and billed like it too: not at all, and no
   * concurrency slot, because it is one small GET that answers a configuration question.
   */
  app.get('/v1/models', async (req, reply) => {
    const who = await resolveCredential(credentialOf(req), 'anthropic');
    if (!who) {
      return reply.code(401).send(anthropicError('authentication_error', tr(req, 'The credential is invalid or has expired')));
    }
    return reply.code(200).send(await modelsFor(providersRepo.active()));
  });

  app.post('/responses', (req, reply) => handleProxy(req, reply, 'responses'));
  // Where Codex lands in openai-chat mode, and any OpenAI client can use it directly
  app.post('/v1/chat/completions', (req, reply) => handleProxy(req, reply, 'chat'));
  app.post('/chat/completions', (req, reply) => handleProxy(req, reply, 'chat'));
  app.post('/v1/responses', (req, reply) => handleProxy(req, reply, 'responses'));

  /**
   * Gate status, and changing it live.
   *
   * Split across processes (ROLE=app / ROLE=gateway), the limiter's state exists only in
   * **the gateway process**; the console reaches it by forwarding. Reading this process's
   * own gate directly would read an empty shell.
   *
   * Both endpoints have to be authenticated: agent containers share agent-net with the
   * gateway, and unguarded, an agent could raise its own concurrency limit.
   */
  const adminOnly = { preHandler: [attachUser, requireAdmin] };

  app.get('/gate', adminOnly, async (): Promise<GateStats> => gate.stats());

  /**
   * The shared plan's own allowance, as the upstream last reported it.
   *
   * Only this process sees those headers — they are dropped before the response leaves — so
   * the console has to ask for them here, the same way it asks for gate status.
   */
  app.get('/upstream-allowance', adminOnly, async () => ({ allowance: allowance.snapshot() }));

  /**
   * The same question, for a named provider rather than the active one.
   *
   * An administrator configuring an upstream needs its model list before making it the
   * active one, and that is the whole point of the button this serves.
   */
  app.get('/models', adminOnly, async (req) => {
    const { provider } = (req.query ?? {}) as { provider?: string };
    return modelsFor(provider ? providersRepo.findById(provider) : providersRepo.active());
  });

  app.patch('/gate', adminOnly, async (req, reply) => {
    const body = (req.body ?? {}) as { maxConcurrency?: number };
    const n = Number(body.maxConcurrency);
    if (!Number.isFinite(n) || n < 1 || n > 64)
      return reply.code(400).send({ error: tr(req, 'The concurrency limit has to be between 1 and 64') });
    gate.setMaxConcurrency(n);
    return gate.stats();
  });

  /**
   * The status of a key file. **The gateway decides.**
   *
   * This process is what reads the key, so it is the only one that can say whether it is
   * readable. The app container is free not to mount that volume — the recommended shape,
   * see core/secret-file.ts — and then app's own stat says "no such file" while the file is
   * fine and the gateway reads it on every request. Asking app is asking an unrelated
   * process a question about this one.
   *
   * Authenticated for the same reason /gate is, and more so: this returns file fingerprints
   * and masked previews — the first and last four characters of a key — and agent
   * containers are on agent-net.
   */
  app.get('/secret-files', adminOnly, async (req) => {
    const { path } = (req.query ?? {}) as { path?: string };
    const listing = listCandidates();
    return path ? { ...listing, checked: inspect(path) } : listing;
  });

  return app;
}

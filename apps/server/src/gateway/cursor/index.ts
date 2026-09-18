import crypto from 'node:crypto';
import { accessToken, CursorAuthError } from './auth.js';
import type { Egress } from './bidi.js';
import { listModels, resolveModel, type CatalogOptions } from './catalog.js';
import { AgentSession, type AgentEvent } from './session.js';
import { canonical, identify, keep, planFor, recall, spoken, systemOf, type Sticky } from './conversation.js';
import { buildRunRequest, toolResults, type ChatRequest } from './request.js';
import { ChatStream } from './stream.js';
import { BUNDLE_VERSION } from './schema.generated.js';
import { park, resume } from './turns.js';

/**
 * The Cursor upstream.
 *
 * Cursor has no HTTP API to point an `ANTHROPIC_BASE_URL` at: its client speaks Connect-RPC
 * with protobuf bodies, over a schema that is published nowhere and read out of the client
 * instead (scripts/extract-cursor-schema.mjs). This module is the whole of that conversation,
 * and it hands the rest of the gateway something it already knows how to handle: a Chat
 * Completions SSE response.
 *
 * That last part is the design. `resolveUpstream` gives a Cursor provider `wire: 'chat'`, so
 * gateway/translate.ts has already turned Claude Code's Messages or Codex's Responses into
 * Chat Completions on the way in, and turns the stream back on the way out. Both CLIs work
 * against Cursor without either of them, or the relay between them, knowing it.
 *
 * ## Which protocol, and why this one
 *
 * `agent.v1.AgentService` — the protocol Cursor's own CLI speaks. The IDE's chat RPC
 * (`aiserver.v1.ChatService/StreamUnifiedChat`) would be the simpler bridge, and this used to
 * use it, but it is gone: the CLI bundle stopped carrying those messages in 2026.09, and a
 * schema that cannot be regenerated cannot be kept honest across a Cursor release.
 *
 * Agent mode is also the better bridge, for two reasons that matter to a gateway:
 *
 *   **Token counts are real.** Every turn ends with the counts Cursor itself measured. The
 *   chat RPC reported none, so this upstream used to meter a character estimate — the quota
 *   gate, the usage report and every price derived from them, all guesses.
 *
 *   **Tools are native, both ways.** A caller's own tools go out as MCP definitions and are
 *   called as tools rather than coaxed out of a prompt. And Cursor's side of the loop — read
 *   this file, run this command — is handed back to the caller to run in its own checkout.
 *
 * The cost is that a turn is a conversation rather than a request, and the APIs this gateway
 * speaks end a response at a tool call. See turns.ts for what keeps the turn alive in between.
 */

/** Where Cursor's API lives when a provider does not say otherwise */
export const CURSOR_API = 'https://api2.cursor.sh';

/**
 * And where its agent lives, which is not the same host.
 *
 * Cursor advertises this through `GetServerConfig`; pinned here to what it advertises today,
 * because a gateway that resolved it per request would be asking a second service whether the
 * first one is reachable.
 */
export const CURSOR_AGENT_API = 'https://agentn.us.api5.cursor.sh';

/** The turn, and the model list, which is a plain unary call on the API host */
export { RUN_SSE_RPC, APPEND_RPC } from './bidi.js';
const MODELS_RPC = '/aiserver.v1.AiService/AvailableModels';

/** What the caller's workspace is called, for the one field that has to name one */
const WORKSPACE = '/workspace';

/**
 * How this client describes itself.
 *
 * Every header here is one a capture of the real `cursor-agent` shows it sending, and the
 * list is short on purpose. It used to be longer — an `x-cursor-checksum` built from the
 * credential, and the os, arch and timezone the IDE reports — and the capture settled it:
 * the CLI sends none of those on these RPCs. A checksum in particular was this process
 * inventing a machine identity it does not have, which is worse than not sending one.
 *
 * `x-cursor-streaming` is set by the agent transport's own interceptor, on both calls of the
 * pair rather than only the streaming half.
 */
export function clientHeaders(token: string, requestId: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    'connect-protocol-version': '1',
    'user-agent': 'connect-es/1.6.1',
    'x-cursor-client-type': 'cli',
    'x-cursor-client-version': `cli-${BUNDLE_VERSION}`,
    'x-cursor-streaming': 'true',
    'x-request-id': requestId,
    // Cursor's own switch for "do not keep this". A gateway relaying other people's work has
    // no standing to opt their code into anything, so it is on and not configurable.
    'x-ghost-mode': 'true',
  };
}

export type { Egress };

const direct: Egress = (url) => ({ url, headers: {} });

export interface FetchOptions {
  /** The provider's base url, or Cursor's own when it is blank */
  baseUrl?: string;
  /** The credential as configured: a Cursor API key, or an access token already */
  secret: string;
  /** The request, already in Chat Completions shape */
  body: ChatRequest;
  /** What this upstream calls the model */
  model: string;
  conversationId?: string;
  signal: AbortSignal;
  egress?: Egress;
}

/**
 * One turn against Cursor, as a Chat Completions response.
 *
 * Returns a Response rather than a stream so the relay in gateway/index.ts needs no branch of
 * its own: a stream comes back as `text/event-stream` and a refusal as the JSON error body
 * that the same code path already knows how to relay and translate.
 */
export async function fetchCursor(opts: FetchOptions): Promise<Response> {
  const base = (opts.baseUrl || CURSOR_API).replace(/\/+$/, '');
  // A provider pointed at a relay sends both calls through it; otherwise the agent lives on
  // its own host and only the API base is configurable
  const agentBase = opts.baseUrl ? base : CURSOR_AGENT_API;
  const route = opts.egress ?? direct;

  /*
   * The transcript as the conversation store compares them, and the instructions that came with
   * it. Read once, here, because both paths below want them: the one that resumes a parked turn
   * and the one that starts a new one.
   */
  const messages = opts.body.messages ?? [];
  const now = canonical(messages);
  const system = systemOf(messages);

  /*
   * A request answering a tool call resumes the turn that asked for it, if that turn is still
   * here. When it is not — it expired, or this process restarted — the transcript carries the
   * whole history including the tool results, so starting again is a worse answer rather than
   * a wrong one.
   */
  const results = toolResults(messages);
  const parked = results.length ? resume(results.map((r) => r.callId)) : undefined;

  if (parked) {
    const answer = results.find((r) => r.callId === parked.callId)!;
    try {
      await parked.session.submit(answer.callId, answer.text);
    } catch (e) {
      await parked.session.close().catch(() => {});
      return jsonError(502, `Could not return a tool result to Cursor: ${(e as Error).message}`);
    }
    /*
     * The lane comes from the parked turn rather than being worked out here: it is keyed by the
     * resolved model, and this path never resolves one — it picks up a turn already running.
     * The transcript is this request's, which is the one carrying the tool results, and so the
     * one the next turn has to be compared against.
     */
    const resumed = parked.lane ? { lane: parked.lane, messages: now, system } : undefined;
    return relay(parked.events, parked.session, parked.controller, opts, parked.model, undefined, resumed);
  }

  let token: string;
  try {
    token = await accessToken(opts.secret, base, { signal: opts.signal });
  } catch (e) {
    // An authentication problem is the deployment's, not the model's: a 401 so the client
    // stops rather than retrying, carrying the sentence an administrator has to read
    return jsonError(e instanceof CursorAuthError ? 401 : 502, (e as Error).message);
  }

  /*
   * The model, as Cursor's own catalogue describes it. A slug names a variant rather than a
   * model — see catalog.ts — so this is a lookup, cached per credential, that falls back to
   * reading the suffixes when it cannot be done.
   */
  const model = await resolveModel(opts.model, {
    secret: opts.secret,
    baseUrl: base,
    headers: (requestId) => clientHeaders(token, requestId),
    egress: (url) => route(url),
    signal: opts.signal,
  });

  /*
   * Which Cursor conversation this request belongs to, and what that conversation left behind.
   * Worked out here rather than earlier because a lane is keyed by the model configuration as
   * well as the thread — see conversation.ts — and the model has only just been resolved.
   */
  const identity = identify({ conversationId: opts.conversationId, model, messages: now });
  const plan = planFor(recall(identity.lane), now, system);
  const held = plan.kind === 'continue' ? plan.held : undefined;

  /*
   * The turn's own id, which is not the stream's. The real client keeps the two apart — a
   * retried turn opens a new stream and keeps this — so it is minted here and travels as both
   * the request's `run_id` and the `x-original-request-id` header on every call.
   */
  const turnId = crypto.randomUUID();
  const { request, delegate } = buildRunRequest(opts.body, {
    model,
    /*
     * An aside is not this thread, so it is sent as a conversation of its own — one
     * buildRunRequest mints — under the thread's group, where Cursor's own accounting can still
     * read the two as one piece of work.
     */
    conversationId: plan.kind === 'aside' ? undefined : identity.id,
    conversationGroupId: identity.groupId,
    runId: turnId,
    state: held?.state,
    /*
     * Only what is new, sliced out of spoken() because that is the filter the held transcript
     * was counted with: `from` indexes the conversation, not the request the system prompt is
     * still in.
     */
    messages: plan.kind === 'continue' ? spoken(messages).slice(plan.from) : undefined,
  });

  /*
   * What this turn writes back to the lane if it finishes. An aside writes nothing: it is not
   * the thread, and the state it produces would stand where the thread's own belongs.
   */
  const sticky: Sticky | undefined =
    plan.kind === 'aside' ? undefined : { lane: identity.lane, messages: now, system };

  const start = async (bearer: string) => {
    const controller = new AbortController();
    const session = new AgentSession({
      apiBase: base,
      agentBase,
      token: bearer,
      headers: (requestId) => clientHeaders(bearer, requestId),
      turnId,
      egress: (url) => route(url),
      signal: controller.signal,
      workspace: WORKSPACE,
      delegate,
      /*
       * The blobs this conversation has already handed over. The server asks for them by id
       * and does not care which request stored them, so a turn that continues one without them
       * stops at the first `get_blob` it cannot answer.
       */
      blobs: held?.blobs,
    });
    const events = session.run(request);
    /*
     * Started here rather than in relay(), and deliberately not awaited here: while nothing has
     * been written a refusal can still be a status, which is the difference between a client
     * retrying and a client giving up. The pull travels on either way, so a turn that outlasts
     * the wait below still delivers its first event rather than losing it to a dropped promise.
     */
    const pending = events.next();
    return { session, events, controller, pending };
  };

  let run = await start(token);
  let first = await settled(run.pending);
  /*
   * A token that was refused. It may have been revoked rather than aged out — the cache cannot
   * tell the difference — so the one retry mints a new one and tries again. Only once: a key
   * that is genuinely invalid would otherwise be exchanged on every request.
   */
  if (unauthorised(first?.value)) {
    run.controller.abort();
    const fresh = await accessToken(opts.secret, base, { force: true, signal: opts.signal }).catch(() => token);
    if (fresh !== token) {
      run = await start(fresh);
      first = await settled(run.pending);
    }
  }

  const event = first?.value;
  if (event?.kind === 'error') {
    run.controller.abort();
    await run.session.close().catch(() => {});
    return jsonError(event.status ?? 502, event.message);
  }

  return relay(run.events, run.session, run.controller, opts, opts.model, run.pending, sticky);
}

/**
 * How long a refusal is worth waiting for before the stream starts anyway.
 *
 * Two cases arrive on the same promise and want opposite things. A refusal — an expired token,
 * an exhausted plan, a model this account cannot use — comes back in the first moment, and
 * while nothing has been written it can still be an HTTP **status**, which is what a client
 * retries on and what the gate reads to decide whether to back off. A turn that is merely slow
 * to start is the other, and waiting on that one costs: the response headers are what start the
 * gateway's keep-alive, so until they go out the client hears nothing at all, and the upstream
 * headers bound would eventually abort a turn that was working the whole time.
 *
 * So the wait is short, and what has not arrived by the end of it arrives in band instead.
 */
const FIRST_EVENT_MS = 20_000;

/**
 * The first event, if it turns up in time.
 *
 * `undefined` means it has not arrived **yet** — not that it failed. The same promise is handed
 * to relay(), which awaits it for its own first pull, so giving up on it here loses nothing:
 * awaiting a promise twice yields the same answer, and a rejection is reported by the stream,
 * which by then is the only place left to say anything.
 */
async function settled(pending: Promise<IteratorResult<AgentEvent>>): Promise<IteratorResult<AgentEvent> | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const elapsed = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FIRST_EVENT_MS);
  });
  try {
    return await Promise.race([pending.catch(() => undefined), elapsed]);
  } finally {
    // Otherwise the timer holds the event loop open for its full length after every turn
    clearTimeout(timer);
  }
}

const unauthorised = (event?: AgentEvent): boolean =>
  event?.kind === 'error' && (event.status === 401 || event.status === 403);

/**
 * The turn, as it arrives, until it ends or needs the caller.
 *
 * Three ways out, and the one in the middle is the whole reason turns.ts exists:
 *
 *   the turn ended        usage, `finish_reason: stop`, done
 *   a tool call           the call goes to the client, the turn is parked, and this response
 *                         ends at `finish_reason: tool_calls` — the client answers in a new
 *                         request, which resumes the same turn
 *   the upstream refused  said in band, because the status is long gone
 */
function relay(
  events: AsyncGenerator<AgentEvent>,
  session: AgentSession,
  controller: AbortController,
  opts: FetchOptions,
  model: string,
  /**
   * The pull already in flight, which this stream owns from here.
   *
   * An async generator hands each `next()` to the caller that asked for it, so the first event
   * belongs to the pull fetchCursor started — asking for another one here would wait for the
   * *second* event and lose the first.
   */
  first?: Promise<IteratorResult<AgentEvent>>,
  /**
   * Which lane this turn's state belongs to, and the transcript to file it under.
   *
   * Absent for a turn whose state is nobody's to keep — an aside, or a resumed turn whose lane
   * did not outlive the request that parked it.
   */
  sticky?: Sticky,
): Response {
  const out = new ChatStream(model);
  const encoder = new TextEncoder();
  let parkedHere = false;

  /*
   * The client going away aborts the turn — unless the turn has been parked, in which case the
   * response ending is the normal way this request finishes and the turn belongs to the next
   * one. Without that exception, handing over a tool call would kill the turn it was handed
   * over from.
   */
  const onAbort = () => {
    if (!parkedHere) controller.abort();
  };
  opts.signal.addEventListener('abort', onAbort, { once: true });

  const finish = () => {
    opts.signal.removeEventListener('abort', onAbort);
    if (!parkedHere) void session.close().catch(() => {});
  };

  let pending = first;

  const stream = new ReadableStream<Uint8Array>({
    async pull(controllerOut) {
      const write = (text: string) => {
        if (text) controllerOut.enqueue(encoder.encode(text));
      };

      // The pull in flight on the first turn of this loop, a fresh one after that. Taken before
      // the await so a rejection cannot leave it to be awaited a second time.
      const source = pending ?? events.next();
      pending = undefined;

      let step: IteratorResult<AgentEvent>;
      try {
        step = await source;
      } catch (e) {
        write(out.error(`Cursor stopped answering: ${(e as Error).message}`));
        controllerOut.close();
        finish();
        return;
      }
      if (step.done) {
        // The generator ended without saying how, which nothing in session.ts does; saying
        // `stop` here would tell the client the model finished
        write(out.error('the upstream ended the turn without finishing'));
        controllerOut.close();
        finish();
        return;
      }
      const event = step.value;

      if (event.kind === 'text') {
        write(out.text(event.text));
        return;
      }

      if (event.kind === 'tool') {
        write(out.tool(event.callId, event.name, event.input));
        /*
         * No usage on this one. Cursor reports the turn's counts once, when the turn ends, so
         * every request but the last in a tool chain books nothing — which is also what those
         * requests cost upstream, since they are the same turn.
         */
        write(out.done());
        parkedHere = true;
        /*
         * The lane travels with the turn rather than being written now. The state is not this
         * turn's to keep yet — it is still running, and the request that resumes it cannot work
         * the lane out for itself, because it never resolves a model.
         */
        park({ session, events, controller, callId: event.callId, model, lane: sticky?.lane });
        controllerOut.close();
        finish();
        return;
      }

      if (event.kind === 'error') {
        write(out.error(event.message));
        controllerOut.close();
        finish();
        return;
      }

      /*
       * A turn that finished is the only one worth filing. One that errored leaves the lane as
       * it was: its checkpoint describes a conversation that did not get to the end of a turn,
       * and the client's retry carries the same transcript anyway.
       */
      keep(sticky, session.carried);
      write(out.done(event.usage));
      controllerOut.close();
      finish();
    },
    cancel() {
      finish();
    },
  });

  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** A refusal in the shape the relay reads: JSON, under a status, with the upstream's words */
function jsonError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type: 'upstream_error' } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * What models this account can use.
 *
 * Every slug rather than every model name: on this upstream a model is chosen by its variant
 * (`claude-opus-5-thinking-high`), so a list of bare names would hide the choice that matters.
 * See catalog.ts, which holds the answer for the length of its TTL and is the same table the
 * relay resolves a request's model through.
 */
export async function fetchCursorModels(
  secret: string,
  baseUrl: string | undefined,
  egress: Egress = direct,
): Promise<{ models: string[]; error?: string }> {
  const base = (baseUrl || CURSOR_API).replace(/\/+$/, '');
  const options: CatalogOptions = {
    secret,
    baseUrl: base,
    headers: (requestId) => clientHeaders('', requestId),
    egress,
  };
  return listModels(options);
}

import { getStringFresh, setSetting } from '../core/db/settings.js';
import { CLI_VERSION, sdkIdentity, type ClientIdentity } from './upstream.js';

/**
 * Which Claude Code the gateway claims to be, on the calls that are nobody's client.
 *
 * Four kinds of request reach the upstream on a subscription credential without a CLI having
 * written them: naming a conversation, summarising one, pulling a model list, and anybody's
 * own SDK pointed at this gateway. All four get a Claude Code identity filled in — see
 * `outboundHeaders` and `withBillingSystem` — because the credential is Claude Code's and a
 * request carrying it should look like the client it was issued to.
 *
 * That identity carries a version, and the upstream **gates models on it**. Asking for
 * `claude-fable-5-1` under a version below 2.1.251 does not degrade, it is refused:
 *
 *     Claude Code 2.1.224 does not support this model;
 *     version 2.1.251 or newer is required.
 *
 * with the number read from the billing line rather than the user agent. A constant compiled
 * in here is therefore a bug with a delay on it: the day the upstream ships a model gated
 * above our number, that model exists, is enabled, answers every real client, and refuses
 * ours — with an error naming a version nobody in the deployment is running any more.
 *
 * So the number is **observed rather than declared**. Every real Claude Code sends its own
 * billing line, and upstream.ts passes it through untouched; the newest one seen through
 * here becomes what we say about ourselves from then on. A deployment tracks its own users
 * without anybody editing anything — the first person to upgrade carries the gateway with
 * them.
 *
 * **On those four requests and no others.** A request that arrived with a block of its own
 * is answered for by that block, header and body alike; see `identify`. Handing it the
 * learned number instead made one request claim two versions.
 *
 * `CLI_VERSION` stays the floor. It is what the agent image installs, which is the one
 * client this deployment is certain to have, and observation only ever moves forward from
 * it. That also bounds what a client can do by claiming a version it is not: it can make us
 * look newer, which is the direction that unblocks models on the deployment's own
 * subscription and costs nothing else, and it cannot make us look old enough to be refused.
 *
 * Kept in settings rather than in memory, unlike the allowance snapshot next door: there is
 * no reason to re-learn this after a restart, and both containers send upstream calls, so
 * they need to agree on the answer.
 */

/** Where the observed version is kept; hidden, because nobody sets this by hand */
export const SETTING = 'upstream.cliVersion';

/**
 * The numeric run at the head of a version, or null if it does not begin with one.
 *
 * A billing line carries a tail after the number (`2.1.224.ddf`) whose meaning is not
 * documented anywhere we can read. It is dropped rather than carried: what we keep is only
 * ever fed back into `billingLine`, which appends the tail itself, so keeping it here would
 * put it in twice.
 */
function head(v: string): string | null {
  return /^(\d+(?:\.\d+)*)/.exec(v)?.[1] ?? null;
}

function parts(v: string): number[] {
  return head(v)?.split('.').map(Number) ?? [];
}

/** Segment by segment, a missing segment reading as 0, so 2.1.9 loses to 2.1.10 */
function newer(a: string, b: string): boolean {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}

/** `x-anthropic-billing-header: cc_version=2.1.263.ddf; cc_entrypoint=cli;` */
const CC_VERSION = /^x-anthropic-billing-header:[^\n]*?\bcc_version=(\d[\w.-]*)/;

/**
 * The entrypoint the block names.
 *
 * The charset is deliberately narrow. This value is written by whoever sent the request and
 * ends up inside an outbound header, where a newline would be a header injection and a
 * stray quote is a request the upstream refuses. Anything that is not a short run of
 * lowercase, digits and dashes is read as absent.
 */
const CC_ENTRYPOINT = /^x-anthropic-billing-header:[^\n]*?\bcc_entrypoint=([a-z0-9-]{1,32})\b/;

/** What a real CLI writes; the fallback when its block names a version but no entrypoint */
const CLI_ENTRYPOINT = 'cli';

/**
 * The version a request states about itself, if it states one.
 *
 * Only the first system block is read, because that is the only one that counts: it is where
 * Claude Code puts the line, and it is where `withBillingSystem` looks before deciding the
 * request already has one. Reading further would accept a line that is not the line going
 * upstream — including one a user typed into their own prompt.
 */
function attributionBlock(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const { system } = body as { system?: unknown };
  const first =
    typeof system === 'string'
      ? system
      : Array.isArray(system) && system[0] && typeof system[0] === 'object'
        ? (system[0] as { text?: unknown }).text
        : undefined;
  return typeof first === 'string' ? first : null;
}

export function versionOf(body: unknown): string | null {
  const first = attributionBlock(body);
  if (first === null) return null;
  const v = CC_VERSION.exec(first)?.[1];
  return v ? head(v) : null;
}

/**
 * What this request should present itself as, in both the places that carry it.
 *
 * A request a CLI wrote brings its own attribution block, and `withBillingSystem` passes
 * that block upstream untouched — so the user agent beside it has to say the same thing.
 * It used to say the newest version seen anywhere in the deployment, which meant that from
 * the moment one person upgraded ahead of the agent image, every container request went out
 * claiming one version in its header and another in its body. Neither broke anything: the
 * upstream gates models on the block, not the header. But the whole point of writing one
 * identity is that it is one.
 *
 * A request nobody's client wrote has no block. That is the case the learned version exists
 * for, and it gets our own entrypoint with it; `withBillingSystem` then writes a block
 * saying exactly what the header says.
 *
 * Learning happens either way, so a newer client still moves the floor forward.
 */
export function identify(body: unknown): ClientIdentity {
  const learned = observe(body);
  const own = versionOf(body);
  if (own === null) return sdkIdentity(learned);
  const first = attributionBlock(body);
  return { version: own, entrypoint: (first && CC_ENTRYPOINT.exec(first)?.[1]) || CLI_ENTRYPOINT };
}

/**
 * What to send today: the newest version seen so far, or the floor if none beat it.
 *
 * The stored value goes through `head` on the way out rather than being returned as it
 * stands. `observe` only ever writes something already normalised, but this is a settings
 * row like any other, and what comes back from it is about to be pasted into a header the
 * upstream parses — so the guarantee is made here, where the value leaves the store, rather
 * than assumed of everything that could have written it.
 */
export function current(): string {
  const stored = read();
  const v = stored === undefined ? null : head(stored);
  return v !== null && newer(v, CLI_VERSION) ? v : CLI_VERSION;
}

/**
 * Take this request's version if it beats ours, and answer with the one to send.
 *
 * Returning the value rather than making the caller ask again keeps this to one settings
 * read per relayed request. `getStringFresh` warns against frequent reads and this is a
 * request path, so: it is a point lookup on the primary key of a table with tens of rows,
 * `quota.boundsOf` already spends two of them on the same request, and the request it sits
 * in is about to wait seconds on a network call to Anthropic. Caching it would buy
 * microseconds and cost a staleness window in the one place — two containers, one
 * database — the fresh read exists to close.
 *
 * The write is the rare half: only when a version arrives that beats everything seen before,
 * which is once per client upgrade rather than once per request.
 */
export function observe(body: unknown): string {
  const mine = current();
  const seen = versionOf(body);
  if (seen === null || !newer(seen, mine)) return mine;
  try {
    setSetting(SETTING, seen);
  } catch {
    /*
     * A read-only or busy database must not take the request down with it. This one call
     * still gets the better number; the next client to send it teaches us again.
     */
  }
  return seen;
}

function read(): string | undefined {
  try {
    return getStringFresh(SETTING);
  } catch {
    // Before initDb, or a database that will not answer: the floor is still a real version
    return undefined;
  }
}

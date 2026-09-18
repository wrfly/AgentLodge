import crypto from 'node:crypto';
import type { ChatMessage } from './request.js';

/**
 * Cursor's side of a conversation, across the requests it is made of.
 *
 * Cursor's agent keeps the history on its own side and hands this end a **checkpoint** as it
 * goes — `conversation_checkpoint_update`, a structure of opaque bytes — which the next turn of
 * the same conversation sends back as `conversation_state`. That is what its own client does,
 * and it is the only prompt cache this upstream has: Cursor caches the conversation, not the
 * `cache_control` markers an Anthropic client puts on a request.
 *
 * Without it every request starts a conversation. The whole transcript is flattened into one
 * prompt and sent again, which is correct and expensive: a fifty-turn thread re-sends fifty
 * turns of text as fresh input, on every turn, and is billed for it. With it, a turn sends the
 * state and **only what is new** — which is the difference the counts show as a cache read.
 *
 * ## What a lane is, and why the model is part of it
 *
 * A lane is one Cursor conversation. It is keyed by the conversation the request belongs to and
 * by the model configuration it is running under, because server-side state belongs to a model:
 * a thread that switches from Sonnet to Opus, or from one context window to another, cannot
 * hand its checkpoint to the other one. A subagent on a different model gets its own lane for
 * the same reason.
 *
 * ## Three things a request can be
 *
 * The transcript is what says which, because it is the only evidence there is — the client does
 * not tell us whether it is continuing or starting over:
 *
 *   **a continuation**  everything held is still at the front of what arrived, so the
 *                       difference is what to send, and the state carries the rest
 *   **an aside**        a short exchange under a different system prompt beside a long thread,
 *                       which is what a classifier or a title-generator looks like. It gets a
 *                       conversation of its own and the lane keeps the thread's state
 *   **a rewrite**       neither: compaction rewrote the history, or the client started again.
 *                       The lane is replaced
 *
 * Getting the aside wrong is the costly one: treating it as a rewrite throws away the main
 * thread's state, so the next real turn re-sends the whole transcript and pays for it.
 *
 * ## Why this is bounded
 *
 * A lane holds the state and the blobs of a live server-side conversation, so it is memory that
 * outlives the request that filled it. Both bounds are deliberate: a TTL, because a conversation
 * nobody is continuing is one nobody will ask for again, and a count, oldest first, so no number
 * of abandoned threads can grow this without limit. Losing a lane costs a cache read and never
 * an answer — the transcript is still the whole conversation.
 */

/** How long a lane stands with nothing arriving on it */
const TTL_MS = 60 * 60_000;

/** At most this many conversations held at once, across every provider */
const MAX_LANES = 64;

/** One message, reduced to what "is this the same conversation" needs to compare */
export interface Turn {
  role: string;
  text: string;
}

/**
 * What a lane holds between two turns.
 *
 * No conversation id: it is derived from the lane — see identify() — so a continuation arrives
 * at the same value without having had to keep it, and one fewer thing can drift out of step
 * with the key it is filed under.
 */
export interface Conversation {
  /**
   * The server's own state, as the bytes it last handed over.
   *
   * Opaque deliberately: `ConversationStateStructure` is not in the schema tables, so it decodes
   * as bytes and is written back byte for byte. Nothing here has to understand it, and a
   * structure this end does not parse cannot be half-understood after a Cursor release.
   */
  state: Uint8Array;
  /** The blobs the server asked this side to hold; it asks for them again on later turns */
  blobs: Map<string, Uint8Array>;
  /** The transcript as of the last turn, which is what tells an extension from a rewrite */
  messages: Turn[];
  /** The system prompt it was running under. A different one is a different conversation. */
  system: string;
}

interface Held extends Conversation {
  at: number;
}

const lanes = new Map<string, Held>();

/* ---------------- Reading a transcript ---------------- */

const textOf = (content: ChatMessage['content']): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p.type === 'text' || p.type === undefined ? (p.text ?? '') : p.image_url ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
};

/**
 * The messages that are the conversation, which is everything but the system prompt.
 *
 * The one place the filter lives, because two things index into the result and have to agree:
 * `canonical` below, which says how far a held transcript still matches, and the caller that
 * slices the new messages off the end using that answer. A filter written twice is a delta
 * that starts one message off as soon as a system prompt arrives.
 */
export const spoken = (messages: ChatMessage[]): ChatMessage[] =>
  messages.filter((m) => {
    const role = (m.role ?? 'user').toLowerCase();
    return role !== 'system' && role !== 'developer';
  });

/**
 * The transcript in the form two of them can be compared in.
 *
 * Tool traffic is included rather than skipped: a call and its result are turns of the
 * conversation, and a comparison that ignored them would read the request that answers a tool
 * call as the same transcript as the one that asked for it.
 */
export function canonical(messages: ChatMessage[]): Turn[] {
  const out: Turn[] = [];
  for (const m of spoken(messages)) {
    const calls = (m.tool_calls ?? [])
      .map((c) => `[tool_use ${c.function?.name ?? ''}]${c.function?.arguments ?? '{}'}`)
      .join('\n');
    const text = [textOf(m.content), calls].filter(Boolean).join('\n');
    out.push({ role: (m.role ?? 'user').toLowerCase(), text });
  }
  return out;
}

/** The system prompt a request is carrying, which travels apart from the transcript */
export function systemOf(messages: ChatMessage[]): string {
  return messages
    .filter((m) => (m.role ?? 'user') === 'system' || (m.role ?? 'user') === 'developer')
    .map((m) => textOf(m.content))
    .filter(Boolean)
    .join('\n\n');
}

const same = (a: Turn, b: Turn): boolean => a.role === b.role && a.text === b.text;

/** Whether everything in `held` is still at the front of `now`, unchanged */
const continues = (held: Turn[], now: Turn[]): boolean =>
  now.length >= held.length && held.every((turn, at) => same(turn, now[at]!));

/* ---------------- What a request is ---------------- */

export type Plan =
  /** Start a conversation: the whole transcript, no state, and this lane becomes it */
  | { kind: 'fresh' }
  /** The same conversation: its state, and only the messages from `from` onwards */
  | { kind: 'continue'; from: number; held: Conversation }
  /** Something else entirely: its own conversation, and the lane is left alone */
  | { kind: 'aside' };

/**
 * A short exchange that happens beside a thread rather than in it.
 *
 * Claude Code interleaves the conversation with utility calls of its own — classifying what the
 * user asked for, naming the thread, deciding whether a command is safe — each one a request on
 * the same conversation with a system prompt and a transcript of its own. They are not
 * continuations, and if they were treated as rewrites the thread's state would be thrown away
 * and rebuilt several times per turn.
 *
 * Two signals, and neither is conclusive alone: a system prompt that is not the thread's, and a
 * transcript far shorter than the one held. A request that is genuinely a fresh start on the
 * same conversation looks like an aside by these rules and is answered as one — which costs it
 * the cache and nothing else, because an aside is still the whole transcript.
 */
function isAside(held: Conversation, now: Turn[], system: string): boolean {
  if (held.system && system && held.system !== system) return true;
  if (now.length <= 4 && held.messages.length > 8) return true;
  return held.messages.length >= 16 && now.length * 2 < held.messages.length;
}

/**
 * What to do with this request, given what the lane is holding.
 *
 * An identical transcript is read as a retry rather than as a continuation: after a turn that
 * finished, a client's next request carries the answer it received, so a transcript that has not
 * grown is one whose previous attempt produced nothing. Sending "here is no new message, carry
 * on" against state from a turn that failed is how a retry gets answered with silence; starting
 * it again is what the client is asking for.
 */
export function planFor(held: Conversation | undefined, now: Turn[], system: string): Plan {
  if (!held || !held.state.length) return { kind: 'fresh' };
  if (continues(held.messages, now)) {
    /*
     * A system prompt that changed ends the conversation even where the transcript did not. The
     * instructions went out inside the first turn's prompt and are part of the state now, so a
     * continuation cannot replace them — only starting again can.
     */
    if (held.system !== system) return { kind: 'fresh' };
    return now.length > held.messages.length
      ? { kind: 'continue', from: held.messages.length, held }
      : { kind: 'fresh' };
  }
  return isAside(held, now, system) ? { kind: 'aside' } : { kind: 'fresh' };
}

/* ---------------- The lanes ---------------- */

/** The model configuration, which is part of the lane because server-side state belongs to one */
const configuration = (model: { id: string; parameters: { [k: string]: unknown }[]; max: boolean }): string => {
  const parameters = model.parameters
    .map((p) => `${String(p['id'])}=${String(p['value'])}`)
    .sort()
    .join(',');
  return `${model.id}${model.max ? '+max' : ''}${parameters ? `[${parameters}]` : ''}`;
};

/**
 * A uuid derived from a name rather than minted.
 *
 * Deterministic so a continuation carries the same conversation id without having had to keep
 * it, and so two requests racing on a cold lane arrive at one conversation rather than two.
 * Uuid-shaped because everything else that identifies anything on this wire is.
 */
function idFrom(name: string): string {
  const h = crypto.createHash('sha256').update(name).digest('hex');
  // The version and variant nibbles, so what goes out is well-formed rather than merely hex
  const version = `5${h.slice(13, 16)}`;
  const variant = `${((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}`;
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${version}-${variant}-${h.slice(20, 32)}`;
}

export interface Identity {
  /** Which lane holds this request's conversation */
  lane: string;
  /** What Cursor is told to call the conversation */
  id: string;
  /**
   * And the group it belongs to, which is **not** per model.
   *
   * One thread's subagents run on models of their own and so hold lanes of their own, but they
   * are one piece of work, and the group is where Cursor's own accounting says so.
   */
  groupId: string;
}

/**
 * Which conversation this request is, as far as this end can tell.
 *
 * The thread is the gateway's own conversation id, out of the runtime token: the one identifier
 * that actually says "these requests belong together". Traffic from a plain API key carries
 * none, and there the opening of the transcript stands in — stable for as long as the thread
 * keeps its first exchange, which is exactly as long as its state is worth anything.
 */
export function identify(opts: {
  conversationId?: string;
  model: { id: string; parameters: { [k: string]: unknown }[]; max: boolean };
  messages: Turn[];
}): Identity {
  const thread = opts.conversationId
    ? `cid:${opts.conversationId}`
    : `open:${crypto
        .createHash('sha256')
        .update(JSON.stringify(opts.messages.slice(0, 2)))
        .digest('hex')
        .slice(0, 20)}`;
  const lane = `${thread}::${configuration(opts.model)}`;
  return { lane, id: idFrom(`cursor-conversation:${lane}`), groupId: idFrom(`cursor-group:${thread}`) };
}

/**
 * What a turn in flight has to carry in order to keep its lane when it ends.
 *
 * The state is not worth keeping until the turn produces one — Cursor sends the checkpoint part
 * way through — so a turn travels with this and the lane is written at the end, from whatever
 * the session turned out to be holding. A turn that never got that far leaves the lane as it
 * was, which is the right answer: an attempt that failed has no conversation to continue.
 */
export interface Sticky {
  /**
   * Which lane this turn's state belongs to.
   *
   * The only identifier worth carrying: the conversation id and its group are derived from the
   * lane — see identify() — so the next turn arrives at the same values without this one having
   * had to hand them over, and there is nothing to drift out of step with the key it is under.
   */
  lane: string;
  /** The transcript this turn was asked with, which is what the next one is compared against */
  messages: Turn[];
  system: string;
}

/**
 * Keep what a finished turn left behind, if there is anything to keep.
 *
 * An empty state is skipped rather than stored: the lane would then hold a conversation id with
 * nothing behind it, and `planFor` would read it as a conversation to continue — sending Cursor
 * a delta against a conversation it has no memory of.
 */
export function keep(sticky: Sticky | undefined, carried: { state: Uint8Array; blobs: Map<string, Uint8Array> }): void {
  if (!sticky || !carried.state.length) return;
  remember(sticky.lane, {
    state: carried.state,
    blobs: carried.blobs,
    messages: sticky.messages,
    system: sticky.system,
  });
}

/** What this lane is holding, if it is still held */
export function recall(lane: string): Conversation | undefined {
  expire();
  const held = lanes.get(lane);
  if (!held) return undefined;
  // Copied on the way out: the caller hands these to a session, which goes on writing to its
  // own copy for the length of the turn
  return { ...held, blobs: new Map(held.blobs) };
}

/** Keep what a turn left behind, so the next turn of the same conversation can continue it */
export function remember(lane: string, conversation: Conversation): void {
  expire();
  // Re-inserted rather than updated, so insertion order stays use order and the oldest lane
  // evicted below is the one nobody has come back to
  lanes.delete(lane);
  while (lanes.size >= MAX_LANES) {
    const oldest = lanes.keys().next().value;
    if (oldest === undefined) break;
    lanes.delete(oldest);
  }
  lanes.set(lane, { ...conversation, blobs: new Map(conversation.blobs), at: Date.now() });
}

function expire(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [lane, held] of lanes) {
    if (held.at < cutoff) lanes.delete(lane);
  }
}

/** How many conversations are held, for a test and for anything watching this grow */
export const laneCount = (): number => lanes.size;

/** For tests, which must not inherit another test's conversations */
export function clear(): void {
  lanes.clear();
}

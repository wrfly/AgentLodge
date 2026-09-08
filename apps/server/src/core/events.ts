import { config } from './config.js';
import type { ServerEvent } from './protocol.js';

export interface SeqEvent {
  seq: number;
  event: ServerEvent;
}

type Listener = (e: SeqEvent) => void;

interface Channel {
  seq: number;
  buffer: SeqEvent[];
  listeners: Set<Listener>;
  /** The last time anything happened here, for the sweep below */
  touchedAt: number;
}

const channels = new Map<string, Channel>();

/**
 * How long a conversation's buffer outlives its last event when nobody is listening.
 *
 * Long enough for a browser that dropped mid-turn to come back with a Last-Event-ID and be
 * handed the tail it missed — stream.ts reconnects within ten seconds — and short enough
 * that this process is not carrying every conversation of the month. The map used to grow
 * for as long as the process ran: each conversation kept its last 4000 events, tool results
 * included, and nothing ever let go of them.
 *
 * A channel dropped and later needed again is made afresh, and its sequence restarts. The
 * stream route knows to treat a Last-Event-ID beyond the current sequence as a fresh
 * connection rather than a resume.
 */
const IDLE_MS = 10 * 60_000;

function channel(conversationId: string): Channel {
  let ch = channels.get(conversationId);
  if (!ch) {
    ch = { seq: 0, buffer: [], listeners: new Set(), touchedAt: Date.now() };
    channels.set(conversationId, ch);
  }
  return ch;
}

export function publish(conversationId: string, event: ServerEvent): void {
  const ch = channel(conversationId);
  const item: SeqEvent = { seq: ++ch.seq, event };
  ch.buffer.push(item);
  ch.touchedAt = Date.now();
  if (ch.buffer.length > config.eventBufferSize) {
    ch.buffer.splice(0, ch.buffer.length - config.eventBufferSize);
  }
  for (const fn of ch.listeners) {
    try {
      fn(item);
    } catch (err) {
      console.error('[events] a listener threw:', err);
    }
  }
}

/**
 * Subscribe to a conversation's event stream.
 *
 * afterSeq replays what was missed across a reconnect; it is SSE's Last-Event-ID.
 */
export function subscribe(
  conversationId: string,
  afterSeq: number,
  listener: Listener,
): () => void {
  const ch = channel(conversationId);
  ch.touchedAt = Date.now();
  for (const item of ch.buffer) {
    if (item.seq > afterSeq) listener(item);
  }
  ch.listeners.add(listener);
  return () => {
    ch.listeners.delete(listener);
    ch.touchedAt = Date.now();
  };
}

/** Whether anybody would receive an event published here right now */
export function hasListeners(conversationId: string): boolean {
  return (channels.get(conversationId)?.listeners.size ?? 0) > 0;
}

/** The newest sequence number handed out, or 0 for a conversation with no channel */
export function currentSeq(conversationId: string): number {
  return channels.get(conversationId)?.seq ?? 0;
}

/** Whether the last turn.* event in the buffer says a turn is still running */
function turnInProgress(ch: Channel): boolean {
  for (let i = ch.buffer.length - 1; i >= 0; i--) {
    const t = ch.buffer[i]!.event.type;
    if (t === 'turn.started') return true;
    if (t === 'turn.completed' || t === 'turn.error' || t === 'turn.aborted') return false;
  }
  return false;
}

/**
 * Where replay should start on a first connection, when there is no Last-Event-ID.
 *
 * The client has already fetched persisted history with GET /conversations/:id, so a
 * finished turn must not be replayed on top of it or messages appear twice. The rule:
 *  - if a turn is in progress (the last turn.* event is turn.started), start just before
 *    it, so the client sees everything that turn has produced so far;
 *  - otherwise replay nothing and take new events only.
 */
export function liveStartSeq(conversationId: string): number {
  const ch = channels.get(conversationId);
  if (!ch) return 0;
  for (let i = ch.buffer.length - 1; i >= 0; i--) {
    const item = ch.buffer[i]!;
    const t = item.event.type;
    if (t === 'turn.started') return item.seq - 1;
    if (t === 'turn.completed' || t === 'turn.error' || t === 'turn.aborted') break;
  }
  return ch.seq;
}

export function dropChannel(conversationId: string): void {
  channels.delete(conversationId);
}

/**
 * Let go of channels nobody has touched in a while. A turn still running keeps its
 * channel whatever the clock says: its events are what a reconnecting client comes for.
 */
export function sweep(now = Date.now(), idleMs = IDLE_MS): number {
  let dropped = 0;
  for (const [id, ch] of channels) {
    if (ch.listeners.size > 0 || now - ch.touchedAt <= idleMs || turnInProgress(ch)) continue;
    channels.delete(id);
    dropped += 1;
  }
  return dropped;
}

/** How many conversations are held in memory right now */
export function channelCount(): number {
  return channels.size;
}

setInterval(() => sweep(), 60_000).unref();

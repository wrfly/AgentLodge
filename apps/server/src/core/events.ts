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
}

const channels = new Map<string, Channel>();

function channel(conversationId: string): Channel {
  let ch = channels.get(conversationId);
  if (!ch) {
    ch = { seq: 0, buffer: [], listeners: new Set() };
    channels.set(conversationId, ch);
  }
  return ch;
}

export function publish(conversationId: string, event: ServerEvent): void {
  const ch = channel(conversationId);
  const item: SeqEvent = { seq: ++ch.seq, event };
  ch.buffer.push(item);
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
  for (const item of ch.buffer) {
    if (item.seq > afterSeq) listener(item);
  }
  ch.listeners.add(listener);
  return () => {
    ch.listeners.delete(listener);
  };
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

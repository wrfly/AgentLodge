import { get, run } from './index.js';

/**
 * Cursor conversation checkpoints, on disk.
 *
 * The in-process map in conversation.ts is a cache. A gateway restart — `tsx watch` on
 * every save, a container recycle — used to empty it, and the next Claude Code turn of an
 * API-key session resent the whole transcript as fresh input. These rows are that map
 * surviving the process.
 */

export interface StoredLane {
  state: Uint8Array;
  blobs: Map<string, Uint8Array>;
  messages: { role: string; text: string }[];
  system: string;
}

interface Row {
  lane: string;
  state: Uint8Array;
  blobs: string;
  messages: string;
  system: string;
  updated_at: number;
}

const bytes = (v: unknown): Uint8Array => {
  if (v instanceof Uint8Array) return v;
  if (Buffer.isBuffer(v)) return new Uint8Array(v);
  return new Uint8Array(0);
};

const encodeBlobs = (blobs: Map<string, Uint8Array>): string => {
  const o: Record<string, string> = {};
  for (const [id, data] of blobs) o[id] = Buffer.from(data).toString('base64');
  return JSON.stringify(o);
};

const decodeBlobs = (raw: string): Map<string, Uint8Array> => {
  const blobs = new Map<string, Uint8Array>();
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    for (const [id, data] of Object.entries(o)) {
      if (typeof data === 'string') blobs.set(id, Buffer.from(data, 'base64'));
    }
  } catch {
    /* A row we cannot read is the same as a missing one: the next turn starts again */
  }
  return blobs;
};

export function save(lane: string, conversation: StoredLane): void {
  run(
    `insert into cursor_lanes (lane, state, blobs, messages, system, updated_at)
     values (?, ?, ?, ?, ?, ?)
     on conflict(lane) do update set
       state = excluded.state,
       blobs = excluded.blobs,
       messages = excluded.messages,
       system = excluded.system,
       updated_at = excluded.updated_at`,
    lane,
    conversation.state,
    encodeBlobs(conversation.blobs),
    JSON.stringify(conversation.messages),
    conversation.system,
    Date.now(),
  );
}

export function load(lane: string): StoredLane | undefined {
  const row = get<Row>('select lane, state, blobs, messages, system, updated_at from cursor_lanes where lane = ?', lane);
  if (!row) return undefined;
  let messages: StoredLane['messages'] = [];
  try {
    messages = JSON.parse(row.messages) as StoredLane['messages'];
  } catch {
    return undefined;
  }
  return {
    state: bytes(row.state),
    blobs: decodeBlobs(row.blobs),
    messages,
    system: row.system,
  };
}

export function drop(lane: string): void {
  run('delete from cursor_lanes where lane = ?', lane);
}

export function dropOlderThan(cutoff: number): void {
  run('delete from cursor_lanes where updated_at < ?', cutoff);
}

export function dropOldest(): string | undefined {
  const row = get<{ lane: string }>('select lane from cursor_lanes order by updated_at asc limit 1');
  if (!row) return undefined;
  drop(row.lane);
  return row.lane;
}

export function dropAll(): void {
  run('delete from cursor_lanes');
}

export function count(): number {
  return get<{ n: number }>('select count(*) as n from cursor_lanes')?.n ?? 0;
}

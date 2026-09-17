import zlib from 'node:zlib';

/**
 * Connect-RPC's envelope framing, which is what Cursor's streaming endpoints speak.
 *
 * Two shapes travel on this protocol and only one of them is framed:
 *
 *   unary      `content-type: application/proto`, body is the bare message, errors are
 *              JSON under a non-200 status
 *   streaming  `content-type: application/connect+proto`, body is a run of envelopes —
 *              one flag byte, a big-endian uint32 length, then that many bytes
 *
 * The last envelope of a stream carries flag 0x02 and a **JSON** payload rather than a
 * protobuf one: `{}` or `{"metadata":…}` when it ended cleanly, `{"error":{"code":…}}`
 * when it did not. That frame is the only place a mid-stream failure is reported — the
 * status was 200 long before it happened — so a reader that stops at the last protobuf
 * message reports a refusal as an answer that happens to be empty.
 */

export const FLAG_COMPRESSED = 0b1;
export const FLAG_END_STREAM = 0b10;

export interface Frame {
  flags: number;
  payload: Uint8Array;
}

/** One message, wrapped for the wire */
export function envelope(payload: Uint8Array, flags = 0): Uint8Array {
  const out = new Uint8Array(5 + payload.length);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length, false);
  out.set(payload, 5);
  return out;
}

/**
 * The end-of-stream frame, as the server writes it.
 *
 * `error` is absent when the stream finished; when it is there, `code` is a Connect error
 * code (`resource_exhausted`, `unauthenticated`, …) and `message` is the upstream's own
 * wording, which is the sentence worth showing the user.
 */
export interface EndOfStream {
  error?: { code?: string; message?: string };
  metadata?: Record<string, string[]>;
}

/**
 * Envelopes out of a byte stream that arrives in whatever pieces TCP chose.
 *
 * Holds back a partial frame rather than guessing: a length prefix split across two reads
 * is the ordinary case on a long response, and a decoder that treated the first four bytes
 * it had as the length would desynchronise for the rest of the stream.
 */
export class FrameReader {
  private buf: Uint8Array = new Uint8Array(0);

  push(chunk: Uint8Array): Frame[] {
    if (this.buf.length) {
      const merged = new Uint8Array(this.buf.length + chunk.length);
      merged.set(this.buf, 0);
      merged.set(chunk, this.buf.length);
      this.buf = merged;
    } else {
      this.buf = chunk;
    }

    const out: Frame[] = [];
    let at = 0;
    for (;;) {
      if (this.buf.length - at < 5) break;
      const view = new DataView(this.buf.buffer, this.buf.byteOffset + at, 5);
      const flags = view.getUint8(0);
      const length = view.getUint32(1, false);
      if (this.buf.length - at - 5 < length) break;
      const raw = this.buf.subarray(at + 5, at + 5 + length);
      at += 5 + length;
      out.push({
        flags,
        // Per-message compression is negotiated separately from HTTP's, so undici's own
        // gzip handling does not cover it and a compressed frame would reach the decoder
        // as noise
        payload: flags & FLAG_COMPRESSED ? new Uint8Array(zlib.gunzipSync(raw)) : raw,
      });
    }
    // subarray keeps the whole original buffer alive; slice copies the tail we still need
    this.buf = at ? this.buf.slice(at) : this.buf;
    return out;
  }

  /** Anything held back when the stream ended — a truncated frame, which is a fault worth naming */
  get pending(): number {
    return this.buf.length;
  }
}

/** The trailing frame's JSON, or undefined if it is not one */
export function endOfStream(frame: Frame): EndOfStream | undefined {
  if (!(frame.flags & FLAG_END_STREAM)) return undefined;
  try {
    const text = new TextDecoder().decode(frame.payload).trim();
    return text ? (JSON.parse(text) as EndOfStream) : {};
  } catch {
    // A trailer that is not JSON still means the stream ended; saying so is more useful
    // than throwing on the last frame of an otherwise complete answer
    return {};
  }
}

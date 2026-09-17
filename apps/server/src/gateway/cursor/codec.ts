import { type FieldDesc, MESSAGES, type MessageDesc, SCALAR } from './schema.generated.js';

/**
 * Protobuf on the wire, driven by the tables in schema.generated.ts.
 *
 * Hand-written rather than pulled from a library, for the same reason the rest of this
 * server has four dependencies: what is needed here is one page of varints, and the
 * generated-code route would mean a build step, a code generator and a `.proto` this
 * project does not have — the schema is read out of Cursor's own bundle instead.
 *
 * Two properties matter more than completeness:
 *
 * **Unknown fields are skipped, not failed on.** Cursor sends far more than this gateway
 * asks about, and adds to it every release. A decoder that threw on an unrecognised field
 * number would break on a Tuesday for no reason; protobuf makes stepping over a field by
 * its wire type cheap, so that is what happens. The same goes for message-typed fields whose
 * target is not in the tables: they come back as raw bytes.
 *
 * **Nothing is guessed.** Every field number and wire kind comes from the generated tables.
 * Where a field is absent from them, the value is carried opaquely rather than interpreted.
 */

/** A decoded message: field name to value. Unknown fields are collected under `$unknown`. */
export type Message = Record<string, unknown>;

/** What a message-typed field decodes to when its type is not in the tables */
export type Opaque = Uint8Array;

const WIRE = { VARINT: 0, FIXED64: 1, LENGTH: 2, FIXED32: 5 } as const;

/* ---------------- Writing ---------------- */

class Writer {
  private chunks: Uint8Array[] = [];
  private buf: number[] = [];

  private flush(): void {
    if (this.buf.length) {
      this.chunks.push(Uint8Array.from(this.buf));
      this.buf = [];
    }
  }

  byte(b: number): void {
    this.buf.push(b & 0xff);
  }

  varint(value: number | bigint): void {
    let v = typeof value === 'bigint' ? value : BigInt(Math.trunc(value));
    // Negative int32/int64 are sign-extended to 64 bits, which is what makes -1 ten bytes
    if (v < 0n) v += 1n << 64n;
    do {
      const byte = Number(v & 0x7fn);
      v >>= 7n;
      this.buf.push(v > 0n ? byte | 0x80 : byte);
    } while (v > 0n);
  }

  tag(no: number, wire: number): void {
    this.varint((no << 3) | wire);
  }

  bytes(b: Uint8Array): void {
    this.varint(b.length);
    this.flush();
    this.chunks.push(b);
  }

  fixed32(value: number, float: boolean): void {
    const view = new DataView(new ArrayBuffer(4));
    if (float) view.setFloat32(0, value, true);
    else view.setUint32(0, value >>> 0, true);
    this.flush();
    this.chunks.push(new Uint8Array(view.buffer));
  }

  fixed64(value: number | bigint, double: boolean): void {
    const view = new DataView(new ArrayBuffer(8));
    if (double) view.setFloat64(0, Number(value), true);
    else view.setBigUint64(0, BigInt(value) & 0xffffffffffffffffn, true);
    this.flush();
    this.chunks.push(new Uint8Array(view.buffer));
  }

  finish(): Uint8Array {
    this.flush();
    const size = this.chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of this.chunks) {
      out.set(c, at);
      at += c.length;
    }
    return out;
  }
}

const zigzag = (n: number): number => (n << 1) ^ (n >> 31);

/** Which wire type a scalar travels as */
function wireOf(scalar: number): number {
  switch (scalar) {
    case SCALAR.DOUBLE:
    case SCALAR.FIXED64:
    case SCALAR.SFIXED64:
      return WIRE.FIXED64;
    case SCALAR.FLOAT:
    case SCALAR.FIXED32:
    case SCALAR.SFIXED32:
      return WIRE.FIXED32;
    case SCALAR.STRING:
    case SCALAR.BYTES:
      return WIRE.LENGTH;
    default:
      return WIRE.VARINT;
  }
}

function writeScalar(w: Writer, scalar: number, value: unknown): void {
  switch (scalar) {
    case SCALAR.STRING:
      w.bytes(new TextEncoder().encode(String(value)));
      return;
    case SCALAR.BYTES:
      w.bytes(value instanceof Uint8Array ? value : new Uint8Array(0));
      return;
    case SCALAR.BOOL:
      w.varint(value ? 1 : 0);
      return;
    case SCALAR.DOUBLE:
      w.fixed64(Number(value), true);
      return;
    case SCALAR.FLOAT:
      w.fixed32(Number(value), true);
      return;
    case SCALAR.FIXED64:
    case SCALAR.SFIXED64:
      w.fixed64(value as number | bigint, false);
      return;
    case SCALAR.FIXED32:
    case SCALAR.SFIXED32:
      w.fixed32(Number(value), false);
      return;
    case SCALAR.SINT32:
    case SCALAR.SINT64:
      w.varint(zigzag(Number(value)));
      return;
    default:
      w.varint(value as number | bigint);
  }
}

function writeField(w: Writer, f: FieldDesc, value: unknown): void {
  if (f.kind === 'message') {
    const body = value instanceof Uint8Array ? value : encode(f.type ?? '', value as Message);
    w.tag(f.no, WIRE.LENGTH);
    w.bytes(body);
    return;
  }
  if (f.kind === 'enum') {
    w.tag(f.no, WIRE.VARINT);
    w.varint(Number(value));
    return;
  }
  if (f.kind === 'map') {
    // Each entry is its own length-delimited message of key=1, value=2
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const entry = new Writer();
      entry.tag(1, wireOf(f.mapKey ?? SCALAR.STRING));
      writeScalar(entry, f.mapKey ?? SCALAR.STRING, k);
      if (f.mapValueKind === 'scalar') {
        entry.tag(2, wireOf(f.mapValueScalar ?? SCALAR.STRING));
        writeScalar(entry, f.mapValueScalar ?? SCALAR.STRING, v);
      } else {
        entry.tag(2, WIRE.LENGTH);
        entry.bytes(v instanceof Uint8Array ? v : encode(f.type ?? '', v as Message));
      }
      w.tag(f.no, WIRE.LENGTH);
      w.bytes(entry.finish());
    }
    return;
  }
  const scalar = f.scalar ?? SCALAR.STRING;
  w.tag(f.no, wireOf(scalar));
  writeScalar(w, scalar, value);
}

/**
 * Encode a message.
 *
 * **A value that is present is written, including a zero or an empty string.** Proto3 would
 * normally leave those out, and a library would; here the caller decides, because some of
 * what goes to Cursor is chosen to look like what its own client sends rather than to be
 * minimal. Leaving a field out is done by not setting it — `undefined` and `null` are
 * skipped.
 */
export function encode(typeName: string, value: Message): Uint8Array {
  const desc = MESSAGES[typeName] as MessageDesc | undefined;
  if (!desc) throw new Error(`cursor codec: no schema for ${typeName || '(unnamed)'}`);

  const w = new Writer();
  for (const f of desc) {
    const v = value[f.name];
    if (v === undefined || v === null) continue;
    if (f.repeated) {
      // Written one tag per element. Packing is legal for numeric scalars and would be
      // smaller, but both forms are accepted by every parser and this one matches what a
      // capture of Cursor's own client shows.
      for (const item of v as unknown[]) {
        if (item === undefined || item === null) continue;
        writeField(w, f, item);
      }
      continue;
    }
    writeField(w, f, v);
  }
  return w.finish();
}

/* ---------------- Reading ---------------- */

class Reader {
  pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get done(): boolean {
    return this.pos >= this.buf.length;
  }

  varint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (this.pos < this.buf.length) {
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
      if (shift > 63n) throw new Error('cursor codec: varint too long');
    }
    return result;
  }

  bytes(n: number): Uint8Array {
    if (this.pos + n > this.buf.length) throw new Error('cursor codec: truncated');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  fixed32(): DataView {
    return new DataView(this.bytes(4).slice().buffer);
  }

  fixed64(): DataView {
    return new DataView(this.bytes(8).slice().buffer);
  }
}

/** Step over a field nobody asked about, which is how this decoder survives a Cursor release */
function skip(r: Reader, wire: number): Uint8Array | undefined {
  if (wire === WIRE.VARINT) {
    r.varint();
    return undefined;
  }
  if (wire === WIRE.FIXED64) return r.bytes(8);
  if (wire === WIRE.FIXED32) return r.bytes(4);
  if (wire === WIRE.LENGTH) return r.bytes(Number(r.varint()));
  throw new Error(`cursor codec: unknown wire type ${wire}`);
}

const unzigzag = (n: number): number => (n >>> 1) ^ -(n & 1);

/** 64-bit values come back as numbers while they fit, which every field this gateway reads does */
const small = (v: bigint): number | bigint => (v <= Number.MAX_SAFE_INTEGER && v >= -Number.MAX_SAFE_INTEGER ? Number(v) : v);

function readScalar(r: Reader, scalar: number, wire: number): unknown {
  switch (scalar) {
    case SCALAR.STRING:
      return new TextDecoder().decode(r.bytes(Number(r.varint())));
    case SCALAR.BYTES:
      return r.bytes(Number(r.varint())).slice();
    case SCALAR.BOOL:
      return r.varint() !== 0n;
    case SCALAR.DOUBLE:
      return r.fixed64().getFloat64(0, true);
    case SCALAR.FLOAT:
      return r.fixed32().getFloat32(0, true);
    case SCALAR.FIXED64:
      return small(r.fixed64().getBigUint64(0, true));
    case SCALAR.SFIXED64:
      return small(r.fixed64().getBigInt64(0, true));
    case SCALAR.FIXED32:
      return r.fixed32().getUint32(0, true);
    case SCALAR.SFIXED32:
      return r.fixed32().getInt32(0, true);
    case SCALAR.SINT32:
    case SCALAR.SINT64:
      return unzigzag(Number(r.varint()));
    case SCALAR.INT32:
    case SCALAR.SFIXED32 as number:
      return Number(BigInt.asIntN(32, r.varint()));
    case SCALAR.INT64:
      return small(BigInt.asIntN(64, r.varint()));
    default: {
      void wire;
      return small(r.varint());
    }
  }
}

function readField(r: Reader, f: FieldDesc, wire: number): unknown {
  if (f.kind === 'message') {
    const body = r.bytes(Number(r.varint())).slice();
    // A type the tables do not carry is kept as bytes rather than interpreted
    return f.type && MESSAGES[f.type] ? decode(f.type, body) : body;
  }
  if (f.kind === 'enum') return Number(r.varint());
  if (f.kind === 'map') {
    const entry = new Reader(r.bytes(Number(r.varint())));
    let key: unknown;
    let value: unknown;
    while (!entry.done) {
      const tag = Number(entry.varint());
      const no = tag >> 3;
      const w = tag & 0x7;
      if (no === 1) key = readScalar(entry, f.mapKey ?? SCALAR.STRING, w);
      else if (no === 2) {
        value =
          f.mapValueKind === 'scalar'
            ? readScalar(entry, f.mapValueScalar ?? SCALAR.STRING, w)
            : readField(entry, { ...f, kind: 'message' }, w);
      } else skip(entry, w);
    }
    return [key, value];
  }
  return readScalar(r, f.scalar ?? SCALAR.STRING, wire);
}

/**
 * Decode a message.
 *
 * Repeated fields come back as arrays, maps as objects, and anything the schema does not
 * name is collected under `$unknown` — kept rather than dropped, because when a response
 * stops containing what it used to, the fields that turned up instead are the answer.
 */
export function decode(typeName: string, buf: Uint8Array): Message {
  const desc = MESSAGES[typeName] as MessageDesc | undefined;
  if (!desc) throw new Error(`cursor codec: no schema for ${typeName || '(unnamed)'}`);
  const byNo = new Map<number, FieldDesc>(desc.map((f) => [f.no, f]));

  const out: Message = {};
  const unknown: Record<number, unknown[]> = {};
  const r = new Reader(buf);

  while (!r.done) {
    const tag = Number(r.varint());
    const no = tag >> 3;
    const wire = tag & 0x7;
    const f = byNo.get(no);

    if (!f) {
      const raw = skip(r, wire);
      (unknown[no] ??= []).push(raw ?? null);
      continue;
    }

    // A repeated numeric field may arrive packed — one length-delimited run of values —
    // even though this encoder does not write them that way.
    if (f.repeated && wire === WIRE.LENGTH && f.kind !== 'message' && f.kind !== 'map'
      && wireOf(f.scalar ?? SCALAR.STRING) !== WIRE.LENGTH) {
      const packed = new Reader(r.bytes(Number(r.varint())));
      const list = (out[f.name] as unknown[]) ?? [];
      while (!packed.done) list.push(readScalar(packed, f.scalar ?? SCALAR.STRING, WIRE.VARINT));
      out[f.name] = list;
      continue;
    }
    if (f.repeated && f.kind === 'enum' && wire === WIRE.LENGTH) {
      const packed = new Reader(r.bytes(Number(r.varint())));
      const list = (out[f.name] as unknown[]) ?? [];
      while (!packed.done) list.push(Number(packed.varint()));
      out[f.name] = list;
      continue;
    }

    const value = readField(r, f, wire);

    if (f.kind === 'map') {
      const [k, v] = value as [unknown, unknown];
      const map = (out[f.name] as Record<string, unknown>) ?? {};
      map[String(k)] = v;
      out[f.name] = map;
      continue;
    }
    if (f.repeated) {
      const list = (out[f.name] as unknown[]) ?? [];
      list.push(value);
      out[f.name] = list;
      continue;
    }
    out[f.name] = value;
  }

  if (Object.keys(unknown).length) out.$unknown = unknown;
  return out;
}

/**
 * Which member of a oneof is set, if any.
 *
 * The responses this gateway reads are oneofs — a frame is a tool call, or text, or a
 * summary — so asking "which arm" is the first thing done with every decoded frame.
 */
export function oneofOf(typeName: string, msg: Message, group: string): { name: string; value: unknown } | undefined {
  const desc = MESSAGES[typeName] as MessageDesc | undefined;
  if (!desc) return undefined;
  for (const f of desc) {
    if (f.oneof !== group) continue;
    const v = msg[f.name];
    if (v !== undefined && v !== null) return { name: f.name, value: v };
  }
  return undefined;
}

/**
 * Read Cursor's protobuf schema out of the `cursor-agent` bundle.
 *
 * The Cursor upstream speaks Connect-RPC with protobuf bodies and there is no published
 * `.proto` for it. What there is: the CLI ships `@bufbuild/protobuf` v1 runtime descriptors
 * inline, so every message it knows carries its own field table —
 *
 *     Pe.typeName="aiserver.v1.StreamUnifiedChatResponseWithTools",
 *     Pe.fields=s.C.util.newFieldList((()=>[{no:1,name:"client_side_tool_v2_call",…}]))
 *
 * — names, numbers, wire kinds, oneof membership and all. That is the schema, and reading
 * it is the difference between a decoder and a guess: the proof of concept this work
 * started from scraped every string out of the response bytes and then picked whichever one
 * looked most like an answer, because it never knew the reply text is field 1 of field 2.
 *
 * **Re-run this after a Cursor upgrade.** A moved field number is silent — the request is
 * accepted and means something else — so the output is committed, sorted and stable, and
 * the diff is the alarm.
 *
 *   node scripts/extract-cursor-schema.mjs                 regenerate the committed file
 *   node scripts/extract-cursor-schema.mjs --report        print the tables, write nothing
 *   node scripts/extract-cursor-schema.mjs --show X,Y      print any message, by type name
 *   node scripts/extract-cursor-schema.mjs --bundle <dir>  read a CLI other than the newest
 *
 * ## How the bundle is read
 *
 * Minified webpack, so nothing can be resolved by looking at a name alone: `Qn` is four
 * unrelated messages and `Y1` is exported by two modules. The structure that makes it exact
 * is still all there —
 *
 *     "../proto/dist/generated/aiserver/v1/chat_pb.js"(e,t,n){"use strict";
 *       n.d(t,{O9:()=>x, KR:()=>je, …});              ← what this module exports
 *       var s=n("…/proto3.js"), l=n("…/tools_pb.js"); ← what it imports, and as what
 *       … Pe.typeName="aiserver.v1.…"                 ← what its locals are
 *
 * — so a field reading `T:l.TE4` is resolved by following `l` to tools_pb.js and asking
 * that module what it exports as `TE4`. Nothing is matched by proximity or by guessing
 * which definition is nearest.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The messages the gateway builds or reads, and nothing else.
 *
 * Not the reachable closure: `StreamUnifiedChatRequest` alone reaches ~480 messages, almost
 * all of them describing an IDE this deployment is not — an editor's open tabs, its lint
 * results, its git panel. Emitting them would bury the diff that matters under one that
 * never does, and the decoder does not need them: protobuf is self-describing enough to
 * step over a field by its wire type, so anything absent here is skipped rather than
 * mis-read.
 *
 * A message-typed field pointing outside this list keeps its `type` for documentation and
 * is treated as opaque bytes.
 */
const ROOTS = [
  // The request side
  'aiserver.v1.StreamUnifiedChatRequestWithTools',
  'aiserver.v1.StreamUnifiedChatRequest',
  'aiserver.v1.ConversationMessage',
  'aiserver.v1.ConversationMessage.ToolResult',
  'aiserver.v1.ConversationMessage.CodeChunk',
  'aiserver.v1.ExplicitContext',
  'aiserver.v1.ModelDetails',
  'aiserver.v1.MCPParams',
  'aiserver.v1.MCPParams.Tool',
  'aiserver.v1.ImageProto',
  // The response side
  'aiserver.v1.StreamUnifiedChatResponseWithTools',
  'aiserver.v1.StreamUnifiedChatResponse',
  'aiserver.v1.ConversationMessage.Thinking',
  'aiserver.v1.StreamStart',
  'aiserver.v1.ClientSideToolV2Call',
  'aiserver.v1.ClientSideToolV2Result',
  'aiserver.v1.StreamedBackToolCall',
  'aiserver.v1.StreamedBackPartialToolCall',
  'aiserver.v1.MCPResult',
  'aiserver.v1.ToolResultError',
  /*
   * The bidi emulation. The tool-capable chat RPC is bidirectional, which needs HTTP/2
   * request streaming; Cursor's own answer to that is a pair of ordinary calls — post the
   * request through BidiAppend, then read it back over the server-streaming `…SSE`
   * variant, which takes nothing but the id.
   */
  'aiserver.v1.BidiAppendRequest',
  'aiserver.v1.BidiRequestId',
  // The model list
  'aiserver.v1.AvailableModelsRequest',
  'aiserver.v1.AvailableModelsResponse',
  'aiserver.v1.AvailableModelsResponse.AvailableModel',
];

/** Enums whose values the bridge names. Others are carried as plain numbers. */
const ROOT_ENUMS = [
  'aiserver.v1.ClientSideToolV2',
  'aiserver.v1.ConversationMessage.MessageType',
  'aiserver.v1.StreamUnifiedChatRequest.UnifiedMode',
  'aiserver.v1.StreamUnifiedChatRequest.ThinkingLevel',
];

/* ---------------- Arguments ---------------- */

function parseArgs(argv) {
  const out = { bundle: undefined, out: undefined, report: false, show: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') out.report = true;
    else if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--show') out.show = (argv[++i] ?? '').split(',').filter(Boolean);
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return out;
}

/** The newest `cursor-agent` the host has unpacked, or nothing if it has none */
function defaultBundle() {
  const dir = path.join(os.homedir(), '.local/share/cursor-agent/versions');
  if (!fs.existsSync(dir)) return undefined;
  const versions = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(dir, e.name, 'index.js')))
    .map((e) => e.name)
    .sort();
  const newest = versions[versions.length - 1];
  return newest && path.join(dir, newest);
}

/* ---------------- Reading one module ---------------- */

/** Take the bracketed run starting at or after `from`, counting depth so nesting cannot end it early */
function bracketed(src, from, open = '[', close = ']') {
  const start = src.indexOf(open, from);
  if (start < 0) return undefined;
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return { text: src.slice(start, i + 1), end: i + 1 };
    }
  }
  return undefined;
}

/** `"<source path>"(e,t,n){"use strict"` — one per module, in source order */
function segmentModules(src) {
  const starts = [];
  for (const m of src.matchAll(/"([^"\n]{1,300})"\(\w+,\w+,\w+\)\{"use strict"/g)) {
    starts.push({ path: m[1], start: m.index });
  }
  return starts.map((s, i) => ({
    path: s.path,
    start: s.start,
    end: i + 1 < starts.length ? starts[i + 1].start : src.length,
  }));
}

function readModule(src, mod) {
  const body = src.slice(mod.start, mod.end);

  /** exportName -> local identifier, from `n.d(t,{NAME:()=>ident,…})` */
  const exports = new Map();
  const d = /\.d\(\w+,\{/.exec(body);
  if (d) {
    const map = bracketed(body, d.index + d[0].length - 1, '{', '}');
    if (map) for (const e of map.text.matchAll(/([\w$]+):\(\)=>([\w$]+)/g)) exports.set(e[1], e[2]);
  }

  /** local alias -> the module path it was imported from, from `x=n("…")` */
  const aliases = new Map();
  for (const m of body.matchAll(/([\w$]+)=\w+\("([^"]+)"\)/g)) aliases.set(m[1], m[2]);

  /** local identifier -> the type it names */
  const locals = new Map();
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\.typeName="(aiserver\.v1\.[\w.]+)"/g)) {
    locals.set(m[1], m[2]);
  }
  for (const m of body.matchAll(/setEnumType\(([A-Za-z_$][\w$]*),"(aiserver\.v1\.[\w.]+)"/g)) {
    locals.set(m[1], m[2]);
  }

  /** typeName -> the text of its field list */
  const fieldLists = new Map();
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\.fields=[^;]{0,80}?newFieldList\(/g)) {
    const typeName = locals.get(m[1]);
    if (!typeName || fieldLists.has(typeName)) continue;
    const list = bracketed(body, m.index + m[0].length);
    if (list) fieldLists.set(typeName, list.text);
  }

  /** typeName -> { NAME: number } */
  const enums = new Map();
  for (const m of body.matchAll(/setEnumType\([A-Za-z_$][\w$]*,"(aiserver\.v1\.[\w.]+)",/g)) {
    const list = bracketed(body, m.index + m[0].length);
    if (!list) continue;
    const values = {};
    for (const v of list.text.matchAll(/no:(-?\d+),name:"(\w+)"/g)) values[v[2]] = Number(v[1]);
    if (Object.keys(values).length && !enums.has(m[1])) enums.set(m[1], values);
  }

  return { path: mod.path, exports, aliases, locals, fieldLists, enums };
}

/* ---------------- Parsing one field table ---------------- */

/** Split a field list into its top-level `{…}` entries, so a nested descriptor is not read as a sibling */
function splitEntries(text) {
  const out = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(text.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}

/**
 * Turn one descriptor into a field.
 *
 * A reference this script cannot name keeps its field number with no type: the number is
 * still spoken for and must not be reused, and an unnamed target is one the decoder steps
 * over like any other it was not asked about.
 */
function parseField(entry, resolve) {
  const no = /\bno:(\d+)/.exec(entry);
  const name = /\bname:"([^"]+)"/.exec(entry);
  const kind = /\bkind:"(\w+)"/.exec(entry);
  if (!no || !name || !kind) return undefined;

  const field = { no: Number(no[1]), name: name[1], kind: kind[1] };

  if (field.kind === 'scalar') {
    const t = /\bT:(\d+)/.exec(entry);
    if (t) field.scalar = Number(t[1]);
  } else if (field.kind === 'enum') {
    const t = /getEnumType\(([\w$.]+)\)/.exec(entry);
    if (t) field.type = resolve(t[1]);
  } else if (field.kind === 'message') {
    const t = /\bT:([\w$.]+)/.exec(entry);
    if (t) field.type = resolve(t[1]);
  } else if (field.kind === 'map') {
    const k = /\bK:(\d+)/.exec(entry);
    if (k) field.mapKey = Number(k[1]);
    const v = /\bV:\{kind:"(\w+)",T:([\w$.]+)\}/.exec(entry);
    if (v) {
      field.mapValueKind = v[1];
      if (v[1] === 'scalar') field.mapValueScalar = Number(v[2]);
      else field.type = resolve(v[2]);
    }
  }

  if (/\brepeated:!0/.test(entry)) field.repeated = true;
  if (/\bopt:!0/.test(entry)) field.opt = true;
  const oneof = /\boneof:"([^"]+)"/.exec(entry);
  if (oneof) field.oneof = oneof[1];
  return field;
}

/* ---------------- Assembly ---------------- */

function build(bundleDir) {
  const modules = [];
  for (const file of fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(bundleDir, file), 'utf8');
    if (!src.includes('typeName="aiserver.v1.')) continue;
    for (const mod of segmentModules(src)) {
      const read = readModule(src, mod);
      if (read.fieldLists.size || read.enums.size || read.exports.size) modules.push(read);
    }
  }

  /** module path -> what it exports, by type name */
  const exported = new Map();
  for (const m of modules) {
    const table = exported.get(m.path) ?? new Map();
    for (const [exportName, ident] of m.exports) {
      const typeName = m.locals.get(ident);
      if (typeName && !table.has(exportName)) table.set(exportName, typeName);
    }
    exported.set(m.path, table);
  }

  const messages = new Map();
  const enums = new Map();
  const unresolved = new Set();

  for (const m of modules) {
    for (const [typeName, values] of m.enums) if (!enums.has(typeName)) enums.set(typeName, values);

    /** `l.TE4` follows the alias to its module and asks what that module exports; a bare name is local */
    const resolve = (ref) => {
      if (!ref.includes('.')) return m.locals.get(ref);
      const parts = ref.split('.');
      const target = exported.get(m.aliases.get(parts[0]) ?? '')?.get(parts[parts.length - 1]);
      if (!target) unresolved.add(`${m.path}: ${ref}`);
      return target;
    };

    for (const [typeName, text] of m.fieldLists) {
      if (messages.has(typeName)) continue;
      const fields = [];
      for (const entry of splitEntries(text)) {
        const f = parseField(entry, resolve);
        if (f) fields.push(f);
      }
      messages.set(typeName, fields);
    }
  }

  return { modules, messages, enums, unresolved };
}

/* ---------------- Output ---------------- */

const HEADER = `/**
 * Cursor's protobuf schema, as the \`cursor-agent\` CLI carries it.
 *
 * Generated by scripts/extract-cursor-schema.mjs — do not edit by hand. Re-run it after a
 * Cursor upgrade and read the diff: a field that moved is otherwise silent, because the
 * request is still accepted and simply means something else.
 *
 * Only the messages this gateway builds or reads are here. Everything else Cursor defines
 * is skipped by wire type, which is what protobuf makes cheap.
 */

/** Scalar types, as \`@bufbuild/protobuf\` numbers them */
export const SCALAR = {
  DOUBLE: 1, FLOAT: 2, INT64: 3, UINT64: 4, INT32: 5, FIXED64: 6, FIXED32: 7,
  BOOL: 8, STRING: 9, BYTES: 12, UINT32: 13, SFIXED32: 15, SFIXED64: 16,
  SINT32: 17, SINT64: 18,
} as const;

export interface FieldDesc {
  no: number;
  name: string;
  kind: 'scalar' | 'message' | 'enum' | 'map';
  /** For message and enum fields: what it points at. Absent from MESSAGES means opaque here. */
  type?: string;
  /** For scalar fields: which SCALAR above */
  scalar?: number;
  repeated?: boolean;
  opt?: boolean;
  /** The oneof this belongs to — at most one of the group is ever set */
  oneof?: string;
  mapKey?: number;
  mapValueKind?: string;
  mapValueScalar?: number;
}

export type MessageDesc = readonly FieldDesc[];
`;

function emit(messages, enums, meta) {
  const lines = [HEADER];
  lines.push(`/** The CLI these tables were read out of */`);
  lines.push(`export const BUNDLE_VERSION = ${JSON.stringify(meta.version)};\n`);

  lines.push('export const MESSAGES: Record<string, MessageDesc> = {');
  for (const name of [...messages.keys()].sort()) {
    lines.push(`  ${JSON.stringify(name)}: [`);
    for (const f of [...messages.get(name)].sort((a, b) => a.no - b.no)) {
      lines.push(`    ${JSON.stringify(f)},`);
    }
    lines.push('  ],');
  }
  lines.push('};\n');

  lines.push('export const ENUMS: Record<string, Record<string, number>> = {');
  for (const name of [...enums.keys()].sort()) {
    lines.push(`  ${JSON.stringify(name)}: {`);
    for (const [k, v] of Object.entries(enums.get(name)).sort((a, b) => a[1] - b[1])) {
      lines.push(`    ${JSON.stringify(k)}: ${v},`);
    }
    lines.push('  },');
  }
  lines.push('};');

  return `${lines.join('\n')}\n`;
}

function describe(name, fields, known) {
  const out = [name];
  if (!fields) return `${name}\n  (not in this bundle)`;
  for (const f of [...fields].sort((a, b) => a.no - b.no)) {
    let t = f.kind === 'scalar' ? `scalar:${f.scalar}` : (f.type ?? '?');
    if (f.kind === 'message' && f.type && !known.has(f.type)) t += '  (opaque)';
    out.push(`  ${String(f.no).padStart(3)} ${f.name.padEnd(38)} ${f.kind}${f.repeated ? '[]' : ''} ${t}`);
  }
  return out.join('\n');
}

/* ---------------- Main ---------------- */

const args = parseArgs(process.argv.slice(2));
const bundle = args.bundle ?? defaultBundle();
if (!bundle) {
  console.error(
    'No cursor-agent bundle found.\n'
      + '  Install one with:  curl https://cursor.com/install -fsS | bash\n'
      + '  Or point at one:   node scripts/extract-cursor-schema.mjs --bundle <dir>',
  );
  process.exit(1);
}
if (!fs.existsSync(path.join(bundle, 'index.js'))) {
  console.error(`✗ no index.js in ${bundle}`);
  process.exit(1);
}

const version = path.basename(bundle);
const { modules, messages, enums, unresolved } = build(bundle);

const missing = ROOTS.filter((r) => !messages.has(r)).concat(ROOT_ENUMS.filter((e) => !enums.has(e)));
if (missing.length) {
  console.error(
    `✗ cursor-agent ${version} does not define:\n    ${missing.join('\n    ')}\n`
      + '  The bundle moved or was renamed. Run with --show to look for the new name.',
  );
  process.exit(1);
}

const wanted = new Map(ROOTS.map((r) => [r, messages.get(r)]));
const wantedEnums = new Map(ROOT_ENUMS.map((e) => [e, enums.get(e)]));

console.log(
  `cursor-agent ${version}: ${modules.length} modules, ${messages.size} messages, ${enums.size} enums`,
);
console.log(`emitting ${wanted.size} messages and ${wantedEnums.size} enums`);
if (unresolved.size) console.log(`${unresolved.size} unresolved references (skipped by the decoder)`);

if (args.show.length) {
  for (const name of args.show) console.log(`\n${describe(name, messages.get(name), wanted)}`);
  if (args.show.some((n) => enums.has(n))) {
    for (const name of args.show) {
      if (enums.has(name)) console.log(`\n${name}\n  ${JSON.stringify(enums.get(name), null, 2).replace(/\n/g, '\n  ')}`);
    }
  }
  process.exit(0);
}

if (args.report) {
  for (const [name, fields] of wanted) console.log(`\n${describe(name, fields, wanted)}`);
  process.exit(0);
}

const out = args.out ?? path.join(ROOT, 'apps/server/src/gateway/cursor/schema.generated.ts');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, emit(wanted, wantedEnums, { version }));
console.log(`✓ wrote ${path.relative(ROOT, out)}`);

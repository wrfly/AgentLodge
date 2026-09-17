/**
 * Read Cursor's protobuf schema out of the `cursor-agent` bundle.
 *
 * The Cursor upstream speaks Connect-RPC with protobuf bodies and there is no published
 * `.proto` for it. What there is: the CLI ships its own message descriptors inline, so every
 * message it knows carries its own field table, and reading it is the difference between a
 * decoder and a guess — the proof of concept this work started from scraped every string out
 * of the response bytes and picked whichever one looked most like an answer, because it never
 * knew the reply text is field 1 of field 2.
 *
 * **Re-run this after a Cursor upgrade.** A moved field number is silent — the request is
 * accepted and means something else — so the output is committed, sorted and stable, and
 * the diff is the alarm.
 *
 *   node scripts/extract-cursor-schema.mjs                 regenerate the committed file
 *   node scripts/extract-cursor-schema.mjs --report        print the tables, write nothing
 *   node scripts/extract-cursor-schema.mjs --show X,Y      print any message, by type name
 *   node scripts/extract-cursor-schema.mjs --closure X     print what X reaches, and how far
 *   node scripts/extract-cursor-schema.mjs --bundle <dir>  read a CLI other than the newest
 *
 * ## Two bundle formats
 *
 * Cursor changed how it ships descriptors between 2026.08 and 2026.09, and both forms are
 * read here — a deployment pinned to an older CLI still regenerates, and the diff across an
 * upgrade stays readable instead of turning into "everything changed".
 *
 * **Descriptors** (`@bufbuild/protobuf` v1 runtime, the older form, and still how the
 * well-known types are declared):
 *
 *     a.typeName="google.protobuf.Value",
 *     a.fields=s.C.util.newFieldList((()=>[{no:1,name:"null_value",kind:"enum",…}]))
 *
 * **Compact** (Cursor's own, the current form). The field table is one string and the
 * message-typed fields index a dependency array, so a name is never spelled twice:
 *
 *     class o extends i.HL{ static $p(){return"agent.v1."} }        ← the package
 *     class m extends o{ static $(){return[
 *       "KvServerMessage|1 id 13|2 get_blob_args #0 message|…", c, l, s.Kg]}}
 *
 * — where `13` is a protobuf scalar type, `#0` is the first dependency, a trailing `?` marks
 * optional and `*` repeated, and a fourth token names the oneof the field belongs to.
 *
 * ## How a bundle is read
 *
 * Minified webpack, so nothing can be resolved by looking at a name alone: `Qn` is four
 * unrelated messages and `Y1` is exported by two modules. The structure that makes it exact
 * is still all there —
 *
 *     "../proto/dist/generated/agent/v1/kv_pb.js"(e,t,r){"use strict";
 *       r.d(t,{gm:()=>p, km:()=>m});                  ← what this module exports
 *       var s=r("…/exec_pb.js");                      ← what it imports, and as what
 *       … class m extends o{ static $(){…} }          ← what its locals are
 *
 * — so a dependency reading `s.Kg` is resolved by following `s` to exec_pb.js and asking that
 * module what it exports as `Kg`. Nothing is matched by proximity or by guessing which
 * definition is nearest.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The messages the gateway builds or reads, and nothing else.
 *
 * Not the reachable closure: `AgentClientMessage` and `AgentServerMessage` between them reach
 * ~900 messages, almost all of them describing an IDE this deployment is not — an editor's
 * open tabs, its lint results, its git panel. Emitting them would bury the diff that matters
 * under one that never does, and the decoder does not need them: protobuf is self-describing
 * enough to step over a field by its wire type, so anything absent here is skipped rather
 * than mis-read.
 *
 * A message-typed field pointing outside this list keeps its `type` for documentation and is
 * treated as opaque bytes. **Anything the bridge has to encode must be here**, though —
 * an opaque field can be read past, but not written.
 */
const ROOTS = [
  // The turn. One oneof each way: what the client can say, and what the server can say back.
  'agent.v1.AgentClientMessage',
  'agent.v1.AgentServerMessage',

  // -- Starting a turn --
  'agent.v1.AgentRunRequest',
  'agent.v1.ConversationAction',
  'agent.v1.UserMessageAction',
  'agent.v1.UserMessage',
  'agent.v1.McpTools',
  'agent.v1.McpToolDefinition',
  'agent.v1.RequestedModel',
  'agent.v1.RequestedModel.ModelParameterValue',

  // -- What comes back while it runs --
  'agent.v1.InteractionUpdate',
  'agent.v1.TextDeltaUpdate',
  'agent.v1.ThinkingDeltaUpdate',
  'agent.v1.TurnEndedUpdate',

  /*
   * Conversation state, which the server keeps on the client rather than its own side.
   * Answering these is not optional: a turn stops when a blob it asked for does not come back.
   */
  'agent.v1.KvServerMessage',
  'agent.v1.KvClientMessage',
  'agent.v1.GetBlobArgs',
  'agent.v1.GetBlobResult',
  'agent.v1.SetBlobArgs',
  'agent.v1.SetBlobResult',
  'agent.v1.Error',

  /*
   * Tool execution: the server asks, the client answers. Both directions of every request
   * gateway/cursor/exec-bridge.ts knows how to bridge, and the ones it answers itself.
   */
  'agent.v1.ExecServerMessage',
  'agent.v1.ExecClientMessage',
  'agent.v1.ExecClientControlMessage',
  'agent.v1.ExecClientStreamClose',
  'agent.v1.ExecClientThrow',

  // The caller's own tools, which travel as MCP ones
  'agent.v1.McpArgs',
  'agent.v1.McpResult',
  'agent.v1.McpSuccess',
  'agent.v1.McpError',
  'agent.v1.McpToolResultContentItem',
  'agent.v1.McpTextContent',

  // Where we are and what we are, which the server asks for before anything else
  'agent.v1.RequestContextArgs',
  'agent.v1.RequestContextResult',
  'agent.v1.RequestContextSuccess',
  'agent.v1.RequestContext',
  'agent.v1.RequestContextEnv',

  // A shell command, which streams rather than answering once
  'agent.v1.ShellArgs',
  'agent.v1.ShellStream',
  'agent.v1.ShellStreamStart',
  'agent.v1.ShellStreamStdout',
  'agent.v1.ShellStreamStderr',
  'agent.v1.ShellStreamExit',
  'agent.v1.ShellResult',
  'agent.v1.ShellSuccess',
  'agent.v1.ShellFailure',

  // Reading and writing a file, in the older pair of shapes
  'agent.v1.ReadArgs',
  'agent.v1.ReadResult',
  'agent.v1.ReadSuccess',
  'agent.v1.ReadError',
  'agent.v1.WriteArgs',
  'agent.v1.WriteResult',
  'agent.v1.WriteSuccess',
  'agent.v1.WriteError',

  /*
   * And in the newer `pi_*` ones, which are what current models actually ask for. Every one of
   * these answers with a single `output` string, which is also all a client's tool_result has.
   */
  'agent.v1.PiReadExecArgs',
  'agent.v1.PiReadExecResult',
  'agent.v1.PiReadExecSuccess',
  'agent.v1.PiReadExecError',
  'agent.v1.PiBashExecArgs',
  'agent.v1.PiBashExecResult',
  'agent.v1.PiBashExecSuccess',
  'agent.v1.PiBashExecError',
  'agent.v1.PiEditExecArgs',
  'agent.v1.PiEditReplacement',
  'agent.v1.PiEditExecResult',
  'agent.v1.PiEditExecSuccess',
  'agent.v1.PiEditExecError',
  'agent.v1.PiWriteExecArgs',
  'agent.v1.PiWriteExecResult',
  'agent.v1.PiWriteExecSuccess',
  'agent.v1.PiWriteExecError',
  'agent.v1.PiGrepExecArgs',
  'agent.v1.PiGrepExecResult',
  'agent.v1.PiGrepExecSuccess',
  'agent.v1.PiGrepExecError',
  'agent.v1.PiFindExecArgs',
  'agent.v1.PiFindExecResult',
  'agent.v1.PiFindExecSuccess',
  'agent.v1.PiFindExecError',
  'agent.v1.PiLsExecArgs',
  'agent.v1.PiLsExecResult',
  'agent.v1.PiLsExecSuccess',
  'agent.v1.PiLsExecError',

  /*
   * The bidi emulation. `Run` is bidirectional, which needs HTTP/2 request streaming; Cursor's
   * own answer to that is a pair of ordinary calls — post each client message through
   * BidiAppend, and read the turn back over the server-streaming `RunSSE`, which takes nothing
   * but the id they share.
   */
  'aiserver.v1.BidiRequestId',
  'aiserver.v1.BidiAppendRequest',
  'aiserver.v1.BidiAppendResponse',

  // The model list
  'aiserver.v1.AvailableModelsRequest',
  'aiserver.v1.AvailableModelsResponse',
  'aiserver.v1.AvailableModelsResponse.AvailableModel',

  /*
   * `google.protobuf.Value`, because the MCP arm carries a tool's arguments as one rather than
   * as JSON text. Declared in the bundle the descriptor way even now, which is half of why both
   * formats are still read.
   */
  'google.protobuf.Value',
  'google.protobuf.Struct',
  'google.protobuf.ListValue',
];

/** Enums whose values the bridge names. Others are carried as plain numbers. */
const ROOT_ENUMS = ['agent.v1.AgentMode'];

/* ---------------- Arguments ---------------- */

function parseArgs(argv) {
  const out = { bundle: undefined, out: undefined, report: false, show: [], closure: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--report') out.report = true;
    else if (a === '--bundle') out.bundle = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (a === '--show') out.show = (argv[++i] ?? '').split(',').filter(Boolean);
    else if (a === '--closure') out.closure = argv[++i];
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
  let quote;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === open) depth++;
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

/** A string literal, or the local variable minification left holding one */
function literal(body, expr) {
  const trimmed = expr.trim();
  const direct = /^"([^"]*)"$/.exec(trimmed);
  if (direct) return direct[1];
  const assigned = new RegExp(`\\b${trimmed.replace(/[$]/g, '\\$')}\\s*=\\s*"([^"]*)"`).exec(body);
  return assigned ? assigned[1] : undefined;
}

function readModule(src, mod) {
  const body = src.slice(mod.start, mod.end);

  /** exportName -> local identifier, from `n.d(t,{NAME:()=>ident,…})` */
  const exports = new Map();
  for (const d of body.matchAll(/\.d\(\w+,\{/g)) {
    const map = bracketed(body, d.index + d[0].length - 1, '{', '}');
    if (map) for (const e of map.text.matchAll(/([\w$]+):\(\)=>([\w$]+)/g)) exports.set(e[1], e[2]);
  }

  /** local alias -> the module path it was imported from, from `x=n("…")` */
  const aliases = new Map();
  for (const m of body.matchAll(/([\w$]+)=\w+\("([^"]+)"\)/g)) aliases.set(m[1], m[2]);

  /** `class X extends Y{`, in source order, so the owner of a static member can be found */
  const classes = [];
  for (const m of body.matchAll(/class ([\w$]+) extends ([\w$.]+)\s*\{/g)) {
    classes.push({ ident: m[1], base: m[2], at: m.index });
  }
  const ownerOf = (at) => {
    let found;
    for (const c of classes) {
      if (c.at > at) break;
      found = c;
    }
    return found;
  };

  /** base class identifier -> the proto package its subclasses are in, from `static $p(){return"…"}` */
  const packages = new Map();
  for (const m of body.matchAll(/static \$p\(\)\{return ?([^}]{1,60})\}/g)) {
    const owner = ownerOf(m.index);
    const pkg = literal(body, m[1]);
    if (owner && pkg) packages.set(owner.ident, pkg);
  }
  const only = new Set(packages.values());
  const packageFor = (base) => packages.get(base) ?? (only.size === 1 ? [...only][0] : undefined);

  /** local identifier -> the type it names */
  const locals = new Map();
  /** typeName -> the text of its field list, for the descriptor form */
  const fieldLists = new Map();
  /** typeName -> { compact: string, deps: string[] }, for the compact form */
  const compact = new Map();
  /** typeName -> { NAME: number } */
  const enums = new Map();

  // -- The descriptor form --
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\.typeName="([\w.]+\.[\w.]+)"/g)) {
    locals.set(m[1], m[2]);
  }
  for (const m of body.matchAll(/setEnumType\(([A-Za-z_$][\w$]*),"([\w.]+\.[\w.]+)"/g)) {
    locals.set(m[1], m[2]);
  }
  for (const m of body.matchAll(/([A-Za-z_$][\w$]*)\.fields=[^;]{0,80}?newFieldList\(/g)) {
    const typeName = locals.get(m[1]);
    if (!typeName || fieldLists.has(typeName)) continue;
    const list = bracketed(body, m.index + m[0].length);
    if (list) fieldLists.set(typeName, list.text);
  }
  for (const m of body.matchAll(/setEnumType\([A-Za-z_$][\w$]*,"([\w.]+\.[\w.]+)",/g)) {
    const list = bracketed(body, m.index + m[0].length);
    if (!list) continue;
    const values = {};
    for (const v of list.text.matchAll(/no:(-?\d+),name:"(\w+)"/g)) values[v[2]] = Number(v[1]);
    if (Object.keys(values).length && !enums.has(m[1])) enums.set(m[1], values);
  }

  // -- The compact form --
  for (const m of body.matchAll(/static \$\(\)\{return\[/g)) {
    const owner = ownerOf(m.index);
    const list = bracketed(body, m.index + m[0].length - 1);
    if (!owner || !list) continue;
    const args = splitArgs(list.text.slice(1, -1));
    const table = /^"([^"]*)"$/.exec(args[0]?.trim() ?? '')?.[1];
    if (!table) continue;
    const pkg = packageFor(owner.base);
    if (pkg === undefined) continue;
    const typeName = pkg + table.split('|')[0];
    locals.set(owner.ident, typeName);
    if (!compact.has(typeName)) compact.set(typeName, { table, deps: args.slice(1) });
  }
  // `l=(0,a.QT)(runtime, pkg, "Name", [[0,"UNSPECIFIED"],…], 1)`
  for (const m of body.matchAll(/([\w$]+)=\(0,[\w$]+\.[\w$]+\)\([\w$]+\.[\w$]+,([\w$]+|"[^"]*"),"([\w.]+)",\[/g)) {
    const pkg = literal(body, m[2]);
    if (!pkg) continue;
    const list = bracketed(body, m.index + m[0].length - 1);
    if (!list) continue;
    const values = {};
    for (const v of list.text.matchAll(/\[(-?\d+),"(\w+)"\]/g)) values[v[2]] = Number(v[1]);
    if (!Object.keys(values).length) continue;
    const typeName = pkg + m[3];
    locals.set(m[1], typeName);
    if (!enums.has(typeName)) enums.set(typeName, values);
  }

  return { path: mod.path, exports, aliases, locals, fieldLists, compact, enums };
}

/* ---------------- Parsing field tables ---------------- */

/** Split a JS argument list on commas that are not inside brackets or a string */
function splitArgs(text) {
  const out = [];
  let depth = 0;
  let quote;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if ('([{'.includes(c)) depth++;
    else if (')]}'.includes(c)) depth--;
    else if (c === ',' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter((s) => s.length);
}

/** Split a descriptor field list into its top-level `{…}` entries, so a nested one is not read as a sibling */
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
function parseDescriptorField(entry, resolve) {
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

/** Protobuf's own type number for an enum field, which the compact form uses for a bare one */
const TYPE_ENUM = 14;

/**
 * One segment of a compact table: `<no> <name> <type><modifier> [oneof]`.
 *
 * `#N` indexes the dependency array — a message or an enum, told apart by which of the two
 * tables the resolved name lands in, since the wire form differs and nothing in the string
 * says which it is.
 */
function parseCompactField(segment, deps, isEnum) {
  const [no, name, spec, oneof] = segment.split(' ');
  if (!no || !name || !spec) return undefined;

  const field = { no: Number(no), name, kind: 'scalar' };
  let type = spec;
  if (type.endsWith('?')) {
    field.opt = true;
    type = type.slice(0, -1);
  } else if (type.endsWith('*')) {
    field.repeated = true;
    type = type.slice(0, -1);
  }

  const point = (spec) => {
    if (spec.startsWith('#')) {
      const dep = deps[Number(spec.slice(1))];
      return { kind: isEnum(dep) ? 'enum' : 'message', type: dep };
    }
    const scalar = Number(spec);
    return scalar === TYPE_ENUM ? { kind: 'enum' } : { kind: 'scalar', scalar };
  };

  if (type.includes(',')) {
    const [key, value] = type.split(',');
    const at = point(value);
    field.kind = 'map';
    field.mapKey = Number(key);
    field.mapValueKind = at.kind === 'scalar' ? 'scalar' : 'message';
    if (at.kind === 'scalar') field.mapValueScalar = at.scalar;
    else field.type = at.type;
  } else {
    Object.assign(field, point(type));
  }

  // The fourth token is only ever a oneof name: protobuf does not allow a repeated field in
  // a oneof, and no table in the bundle has a repeated field carrying one
  if (oneof) field.oneof = oneof;
  return field;
}

/* ---------------- Assembly ---------------- */

function build(bundleDir) {
  const modules = [];
  for (const file of fs.readdirSync(bundleDir).filter((f) => f.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(bundleDir, file), 'utf8');
    if (!src.includes('.typeName="') && !src.includes('static $(){return[')) continue;
    for (const mod of segmentModules(src)) {
      const read = readModule(src, mod);
      if (read.fieldLists.size || read.compact.size || read.enums.size || read.exports.size) {
        modules.push(read);
      }
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

  const enums = new Map();
  for (const m of modules) {
    for (const [typeName, values] of m.enums) if (!enums.has(typeName)) enums.set(typeName, values);
  }

  const messages = new Map();
  const unresolved = new Set();

  for (const m of modules) {
    /** `s.Kg` follows the alias to its module and asks what that module exports; a bare name is local */
    const resolve = (ref) => {
      if (!ref.includes('.')) return m.locals.get(ref);
      const parts = ref.split('.');
      const target = exported.get(m.aliases.get(parts[0]) ?? '')?.get(parts[parts.length - 1]);
      if (!target) unresolved.add(`${m.path}: ${ref}`);
      return target;
    };
    const isEnum = (name) => name !== undefined && enums.has(name);

    for (const [typeName, text] of m.fieldLists) {
      if (messages.has(typeName)) continue;
      const fields = [];
      for (const entry of splitEntries(text)) {
        const f = parseDescriptorField(entry, resolve);
        if (f) fields.push(f);
      }
      messages.set(typeName, fields);
    }

    for (const [typeName, { table, deps }] of m.compact) {
      if (messages.has(typeName)) continue;
      const resolved = deps.map(resolve);
      const fields = [];
      for (const segment of table.split('|').slice(1)) {
        const f = parseCompactField(segment, resolved, isEnum);
        if (f) fields.push(f);
      }
      messages.set(typeName, fields);
    }
  }

  return { modules, messages, enums, unresolved };
}

/** Every message `roots` can reach, and the shortest path that gets there */
function closure(roots, messages) {
  const depth = new Map(roots.map((r) => [r, 0]));
  const queue = [...roots];
  while (queue.length) {
    const name = queue.shift();
    for (const f of messages.get(name) ?? []) {
      if (f.kind !== 'message' || !f.type || depth.has(f.type)) continue;
      depth.set(f.type, depth.get(name) + 1);
      queue.push(f.type);
    }
  }
  return depth;
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

/** Scalar types, as protobuf itself numbers them */
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
    out.push(
      `  ${String(f.no).padStart(3)} ${f.name.padEnd(38)} ${f.kind}${f.repeated ? '[]' : ''}`
      + `${f.oneof ? ` oneof:${f.oneof}` : ''} ${t}`,
    );
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

console.log(
  `cursor-agent ${version}: ${modules.length} modules, ${messages.size} messages, ${enums.size} enums`,
);

if (args.show.length) {
  for (const name of args.show) {
    if (enums.has(name)) console.log(`\n${name}\n  ${JSON.stringify(enums.get(name), null, 2).replace(/\n/g, '\n  ')}`);
    else console.log(`\n${describe(name, messages.get(name), messages)}`);
  }
  process.exit(0);
}

if (args.closure) {
  const reached = closure([args.closure], messages);
  console.log(`${args.closure} reaches ${reached.size} messages`);
  for (const [name, at] of [...reached].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))) {
    console.log(`  ${at} ${name}`);
  }
  process.exit(0);
}

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

console.log(`emitting ${wanted.size} messages and ${wantedEnums.size} enums`);
if (unresolved.size) console.log(`${unresolved.size} unresolved references (skipped by the decoder)`);

if (args.report) {
  for (const [name, fields] of wanted) console.log(`\n${describe(name, fields, wanted)}`);
  process.exit(0);
}

const out = args.out ?? path.join(ROOT, 'apps/server/src/gateway/cursor/schema.generated.ts');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, emit(wanted, wantedEnums, { version }));
console.log(`✓ wrote ${path.relative(ROOT, out)}`);

import type { Message } from './codec.js';

/**
 * The caller's own tools, in the one slot Cursor's agent has for tools it does not implement.
 *
 * Everything else in `ExecServerMessage` is a fixed catalogue Cursor's own clients implement
 * against a workspace — read a file, run a command, grep a tree. A caller's tools are not in
 * that catalogue and never will be, so they travel as MCP definitions: a name, a description
 * and a JSON schema. Cursor then calls them natively, as tools, rather than being coaxed into
 * emitting a JSON blob by a prompt, which is the difference between a tool loop that works
 * and one that works most of the time.
 *
 * Arguments come back as `map<string, google.protobuf.Value>` rather than as JSON text, so
 * converting between that and plain values is here too.
 */

/** Who these tools belong to, as far as Cursor is concerned */
export const PROVIDER = 'agentlodge';

/**
 * Cursor's model provider already has tools called `Read`, `Write`, `WebFetch` and
 * `WebSearch` registered, and re-registering one of those names makes it reject the whole
 * request with a 400 — which surfaces as `ERROR_PROVIDER_ERROR` and looks like the bridge
 * being wrong rather than a name collision. Claude Code's built-ins are exactly those names,
 * so every client tool goes out prefixed and is renamed back before the caller sees it.
 *
 * `WebSearch` and `WebFetch` are the exception: Cursor can run those itself, after this
 * end approves the `interaction_query` it sends. Offering them as MCP tools makes Cursor
 * call *us* instead, Claude Code then tries to execute a search it cannot, and the turn
 * sits on Shimmying with nothing coming back.
 */
const PREFIX = 'client__';

/** Tools Cursor already implements; offering them as MCP is how a web search hangs */
const NATIVE = new Set(['websearch', 'webfetch']);

export const wireName = (name: string): string => `${PREFIX}${name}`;
export const clientName = (name: string): string => (name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name);

/* ---------------- google.protobuf.Value ---------------- */

/** A plain value as a `Value`, which is a oneof over the six JSON shapes */
export function toValue(value: unknown): Message {
  if (value === null || value === undefined) return { null_value: 0 };
  if (typeof value === 'boolean') return { bool_value: value };
  if (typeof value === 'number') return { number_value: value };
  if (typeof value === 'string') return { string_value: value };
  if (Array.isArray(value)) return { list_value: { values: value.map(toValue) } };
  if (typeof value === 'object') {
    const fields: Record<string, Message> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) fields[k] = toValue(v);
    return { struct_value: { fields } };
  }
  return { string_value: String(value) };
}

/** And back. An arm nobody set reads as null, which is what an absent `Value` means. */
export function fromValue(value: unknown): unknown {
  if (!value || typeof value !== 'object' || value instanceof Uint8Array) return null;
  const v = value as Message;
  if (typeof v['string_value'] === 'string') return v['string_value'];
  if (typeof v['bool_value'] === 'boolean') return v['bool_value'];
  if (typeof v['number_value'] === 'number') return v['number_value'];
  if (v['struct_value'] !== undefined) {
    const fields = (v['struct_value'] as Message)?.['fields'];
    const out: Record<string, unknown> = {};
    for (const [k, item] of Object.entries((fields as Record<string, unknown>) ?? {})) out[k] = fromValue(item);
    return out;
  }
  if (v['list_value'] !== undefined) {
    const items = (v['list_value'] as Message)?.['values'];
    return Array.isArray(items) ? items.map(fromValue) : [];
  }
  return null;
}

/** `McpArgs.args` as the object a tool call's `arguments` has to be */
export function argsOf(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args as Record<string, unknown>)) out[k] = fromValue(v);
  return out;
}

/* ---------------- Declarations ---------------- */

export interface ClientTool {
  name?: string;
  description?: string;
  parameters?: unknown;
}

/**
 * The tools a caller declared, as `McpToolDefinition`s.
 *
 * The schema is sent twice on purpose: `input_schema` as a `Value` and `input_schema_json` as
 * text. Cursor's own client sends both, and which one the server reads is not something this
 * end can see — sending one and guessing right is the same amount of work as sending both.
 */
export function toDefinitions(tools: ClientTool[] | undefined): Message[] {
  const out: Message[] = [];
  for (const tool of tools ?? []) {
    if (!tool.name) continue;
    if (NATIVE.has(tool.name.replace(/[_-]/g, '').toLowerCase())) continue;
    const schema = (tool.parameters as Record<string, unknown>) ?? { type: 'object', properties: {} };
    const name = wireName(tool.name);
    out.push({
      name,
      tool_name: name,
      provider_identifier: PROVIDER,
      description: tool.description ?? '',
      input_schema: toValue(schema),
      input_schema_json: JSON.stringify(schema),
    });
  }
  return out;
}

/** A caller's tool result, as the one-text-block `McpResult` the agent is waiting for */
export function mcpResult(text: string, isError = false): Message {
  return { success: { content: [{ text: { text } }], is_error: isError } };
}

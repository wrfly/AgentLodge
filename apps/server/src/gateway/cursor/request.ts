import crypto from 'node:crypto';
import type { Message } from './codec.js';
import { toDefinitions, type ClientTool } from './mcp.js';
import { ENUMS } from './schema.generated.js';

/**
 * A Chat Completions request, as Cursor's agent wants it.
 *
 * The pivot is deliberate. Everything reaching this gateway is already turned into Chat
 * Completions by gateway/translate.ts — Claude Code's Messages on one side, Codex's Responses
 * on the other — so writing the bridge against that one shape gives both CLIs the Cursor
 * upstream, and leaves exactly one thing here to get right instead of two.
 *
 * What does not survive, because Cursor's protocol has nowhere to put it: sampling parameters
 * (temperature, top_p, stop sequences) and token ceilings. Cursor's server builds the model
 * call itself and takes a conversation and a model, not a decoding configuration. A request
 * carrying them is answered rather than refused — the alternative is failing every Claude Code
 * request, since it always sends max_tokens.
 */

const MODE = ENUMS['agent.v1.AgentMode'] ?? {};

/** A turn that can call tools, versus one that can only answer */
const MODE_AGENT = MODE['AGENT'] ?? 1;
const MODE_ASK = MODE['ASK'] ?? 2;

export interface ChatPart {
  type?: string;
  text?: string;
  image_url?: { url?: string };
}

export interface ChatToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface ChatMessage {
  role?: string;
  content?: string | ChatPart[] | null;
  tool_calls?: ChatToolCall[];
  tool_call_id?: string;
}

export interface ChatRequest {
  model?: string;
  messages?: ChatMessage[];
  tools?: { function?: { name?: string; description?: string; parameters?: unknown } }[];
}

const textOf = (content: ChatMessage['content']): string => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p.type === 'text' || p.type === undefined ? (p.text ?? '') : p.image_url ? '[image]' : ''))
    .filter(Boolean)
    .join('\n');
};

/**
 * The transcript as one prompt.
 *
 * Cursor's agent takes a single user message and keeps the history on its own side, which is
 * exactly right for a turn it is already in the middle of — and no help at all for the first
 * turn, or for one restarted because its parked turn was lost. So the whole conversation is
 * rendered, tool traffic included: a transcript with the calls but not their results makes the
 * model call the same tools over again.
 */
export function flatten(messages: ChatMessage[]): { prompt: string; system: string } {
  const system: string[] = [];
  const parts: string[] = [];
  /*
   * The labels are for a transcript with more than one turn in it. A first question is one
   * user message and nothing else, and a capture of the real client shows it sending exactly
   * the words — so labelling that one would be this bridge putting `User:` into the prompt
   * the model reads, on the most common request there is.
   */
  const conversation = messages.filter((m) => (m.role ?? 'user') !== 'system' && (m.role ?? 'user') !== 'developer');
  const single =
    conversation.length === 1 && (conversation[0]!.role ?? 'user') === 'user' && !conversation[0]!.tool_calls?.length;

  for (const m of messages) {
    const role = m.role ?? 'user';
    if (role === 'system' || role === 'developer') {
      const text = textOf(m.content);
      if (text) system.push(text);
      continue;
    }

    if (role === 'tool') {
      const text = textOf(m.content);
      if (text) parts.push(`[tool_result]\n${text}`);
      continue;
    }

    if (role === 'assistant') {
      const text = textOf(m.content);
      if (text) parts.push(`Assistant: ${text}`);
      for (const call of m.tool_calls ?? []) {
        parts.push(`[tool_use ${call.function?.name ?? ''}]\n${call.function?.arguments ?? '{}'}`);
      }
      continue;
    }

    const text = textOf(m.content);
    if (text) parts.push(single ? text : `User: ${text}`);
  }

  return { prompt: parts.join('\n\n').trim(), system: system.join('\n\n') };
}

/**
 * Reading a model's variant off the end of its slug.
 *
 * **The fallback, not the answer.** `claude-opus-5-thinking-high` is the model
 * `claude-opus-5` with thinking on at high effort, and which parameters a slug stands for is
 * something Cursor states in its own catalogue — see catalog.ts, which is what resolves a
 * model when the catalogue can be reached. This is what stands in when it cannot: right for
 * the common slugs, and wrong in two known ways (`-max` may or may not mean max mode, and
 * `-fast` is part of the name on some models) that only the table can settle.
 *
 * A suffix this table does not know is left on the name, where an unknown model is a clearer
 * failure than a silently different one.
 */
const VARIANTS: readonly [string, string, string][] = [
  ['-thinking-xhigh', 'thinking', 'true'],
  ['-thinking-high', 'thinking', 'true'],
  ['-thinking-medium', 'thinking', 'true'],
  ['-thinking-low', 'thinking', 'true'],
  ['-thinking', 'thinking', 'true'],
  ['-fast', 'fast', 'true'],
  ['-xhigh', 'effort', 'xhigh'],
  ['-high', 'effort', 'high'],
  ['-medium', 'effort', 'medium'],
  ['-low', 'effort', 'low'],
];

/** `-max` is the one suffix that may name a mode rather than an effort, and it costs more */
const MAX_SUFFIX = '-max';

export function splitModel(slug: string): { id: string; parameters: Message[]; max: boolean } {
  let id = slug;
  let max = false;
  const parameters = new Map<string, string>();

  for (let again = true; again; ) {
    again = false;
    if (id.endsWith(MAX_SUFFIX) && id.length > MAX_SUFFIX.length) {
      id = id.slice(0, -MAX_SUFFIX.length);
      max = true;
      again = true;
      continue;
    }
    for (const [suffix, key, value] of VARIANTS) {
      if (!id.endsWith(suffix) || id.length <= suffix.length) continue;
      id = id.slice(0, -suffix.length);
      if (!parameters.has(key)) parameters.set(key, value);
      again = true;
      break;
    }
  }

  return { id, max, parameters: [...parameters].map(([k, v]) => ({ id: k, value: v })) };
}

export interface BuildOptions {
  /**
   * The model, already resolved into what the wire carries — see catalog.ts. Resolved by the
   * caller rather than here because it takes a request to Cursor to do properly, and this
   * function is pure.
   */
  model: { id: string; parameters: Message[]; max: boolean };
  /**
   * Groups this turn with the ones before it for Cursor's own accounting. The gateway's
   * conversation id where there is one — an api key's requests have none, and a uuid per
   * request is then the honest answer rather than a shared constant.
   */
  conversationId?: string;
  /**
   * This turn's id. Shared with the `x-original-request-id` header the calls carry, because
   * the real client uses one value for both — see bidi.ts.
   */
  runId?: string;
}

/** The run request, ready for the codec */
export function buildRunRequest(body: ChatRequest, opts: BuildOptions): { request: Message; delegate: boolean } {
  const { prompt, system } = flatten(body.messages ?? []);
  const tools: ClientTool[] = (body.tools ?? [])
    .map((t) => t.function)
    .filter((f): f is NonNullable<typeof f> => Boolean(f?.name));
  const definitions = toDefinitions(tools);
  /*
   * A caller with no tools has no loop to run one in, so this turn is asked rather than
   * agentic. The alternative was an agent mode turn that asks a client with nothing to answer
   * with to read a file, and then waits.
   */
  const delegate = definitions.length > 0;
  const conversationId = opts.conversationId || crypto.randomUUID();
  const model = opts.model;

  return {
    delegate,
    request: {
      run_request: {
        // Empty rather than absent: a first turn has no state, and the server fills this in
        // from here on by asking for blobs
        conversation_state: new Uint8Array(0),
        action: {
          user_message_action: {
            user_message: {
              text: prompt,
              message_id: crypto.randomUUID(),
              selected_context: new Uint8Array(0),
              mode: delegate ? MODE_AGENT : MODE_ASK,
            },
          },
        },
        // Sent even when it is empty, which is what the real client does
        mcp_tools: definitions.length ? { mcp_tools: definitions } : {},
        conversation_id: conversationId,
        conversation_group_id: conversationId,
        requested_model: {
          model_id: model.id,
          max_mode: model.max,
          ...(model.parameters.length ? { parameters: model.parameters } : {}),
        },
        ...(system ? { custom_system_prompt: system } : {}),
        // There is no workspace on this side to index, and saying so stops the agent asking
        exclude_workspace_context: true,
        run_id: opts.runId || crypto.randomUUID(),
      },
    },
  };
}

/**
 * The tool results a request is carrying, if it is answering a call rather than asking
 * something new.
 *
 * On the Chat Completions side each result is its own `role: "tool"` message, keyed by the id
 * of the call it answers — which is the id a suspended turn was parked under.
 */
export function toolResults(messages: ChatMessage[]): { callId: string; text: string }[] {
  const out: { callId: string; text: string }[] = [];
  for (const m of messages) {
    if (m.role !== 'tool' || !m.tool_call_id) continue;
    out.push({ callId: m.tool_call_id, text: textOf(m.content) });
  }
  return out;
}

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
const MODE_PLAN = MODE['PLAN'] ?? 3;

/**
 * Claude Code writes this into the system prompt when Shift+Tab is on Plan. It is the
 * one marker that survives the Messages → Chat translation; there is no permission-mode
 * header on the request.
 */
const PLAN_ACTIVE = /Plan mode is active/;

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

export function toolName(name: string): string {
  return name.replace(/^client__/i, '').replace(/[_-]/g, '').toLowerCase();
}

/**
 * The caller's tools, by the name an exec request would be handed over under.
 *
 * `delegate` says the caller has *a* loop; this says which tools that loop actually has. The
 * two are not the same thing, and the difference is a turn that stops dead: Claude Code's
 * web-search subrequest declares one tool, the server-side `web_search`, and nothing else —
 * no Bash, no Read, no Write. Cursor, told it is talking to an editor, answered one of those
 * turns by asking the client to `Write` its search results to a scratch file. Claude Code has
 * no tool of that name in that request, so it never replied, and the turn sat parked until the
 * idle timeout turned it into a 504 five and a half minutes later.
 *
 * An exec request is only handed over when this set has the name, so a request Cursor makes
 * for a tool the caller did not bring is refused on the spot — which the agent recovers from —
 * rather than asked of a client that cannot answer it.
 */
export function clientTools(body: ChatRequest): Set<string> {
  return new Set(
    (body.tools ?? [])
      .map((t) => toolName(t.function?.name ?? ''))
      .filter(Boolean),
  );
}

/**
 * Cursor's AgentMode for this request, read off what Claude Code actually sends.
 *
 * Claude Code's Shift+Tab cycle is default / acceptEdits / plan / auto / … — a permission
 * toggle, not a wire field. The API request carries no `permissionMode`. What it does carry:
 *
 *   PLAN   the system prompt contains "Plan mode is active", or the tool list has
 *          ExitPlanMode and not EnterPlanMode (the pair Claude Code swaps when cycling)
 *   AGENT  the caller declared tools and is not planning — default, auto, acceptEdits,
 *          bypassPermissions all land here; Cursor has no counterpart for those
 *   ASK    no tools. A /model probe or a title-generator has no loop, so this rather
 *          than AGENT: otherwise Cursor asks to read a file and waits forever
 *
 * Thinking (the model's) is a `requested_model.parameters` entry, not a mode.
 */
export function agentMode(body: ChatRequest, system = '', prompt = ''): { mode: number; delegate: boolean } {
  const names = (body.tools ?? []).map((t) => toolName(t.function?.name ?? '')).filter(Boolean);
  const planning =
    PLAN_ACTIVE.test(system) ||
    PLAN_ACTIVE.test(prompt) ||
    (names.some((n) => n.includes('exitplanmode')) && !names.some((n) => n.includes('enterplanmode')));
  const delegate = names.length > 0;
  if (planning) return { mode: MODE_PLAN, delegate };
  return { mode: delegate ? MODE_AGENT : MODE_ASK, delegate };
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
 *
 * The system prompt comes back apart from the words because that is how it travels: on the
 * first turn of a conversation it is rendered in front of them, and on the turns after it
 * Cursor already has it. See withSystem().
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
 * The transcript with the system prompt in front of it, which is the only place it fits.
 *
 * `AgentRunRequest` has a `custom_system_prompt` field and it cannot be used: the server maps
 * it onto the CLI's `--system-prompt`, which current builds of Agent Run refuse outright with
 * `invalid_argument`. Sending it failed every request that carried a system prompt, which is
 * every Claude Code request. So it is rendered as the first block of the prompt instead,
 * labelled the way the transcript labels its own turns.
 */
export const withSystem = (prompt: string, system: string): string =>
  system ? `System: ${system}\n\n${prompt}` : prompt;

/**
 * A parameter a caller named in brackets: `claude-opus-5[1m]`, `claude-sonnet-5[context=300k]`.
 *
 * Not a syntax of our own — it is how Claude Code names itself. The model id it reports carries
 * the window it is running with, so the bracket arrives on ordinary requests, and a slug that
 * keeps it is a model name Cursor has never heard of.
 *
 * The window is the one parameter with no variant of its own: `-thinking-high` is a slug
 * Cursor lists and `1m` is not, so it cannot be resolved by lookup and has to travel as a
 * parameter. Which parameters a model takes is something its catalogue entry states — see
 * catalog.ts, which checks these against it rather than sending them on trust.
 *
 * A value with no key is read as the context window, because that is what a client writing one
 * on its own means.
 */
export function parseSlug(slug: string): { base: string; parameters: Map<string, string> } {
  const parameters = new Map<string, string>();
  const bracketed = /^([^[]+)\[([^\]]*)\]$/.exec(slug.trim());
  if (!bracketed) return { base: slug.trim(), parameters };

  for (const part of bracketed[2]!.split(',')) {
    const [left, right] = part.split('=');
    const key = (right === undefined ? 'context' : left)?.trim().toLowerCase() ?? '';
    const value = (right ?? left)?.trim() ?? '';
    if (key && value) parameters.set(key, value);
  }
  return { base: bracketed[1]!.trim(), parameters };
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
   * What Cursor groups this conversation under, when that is not the conversation itself.
   *
   * A thread whose state was replaced continues under the group it started in, so the turns
   * before and after the reset still read as one piece of work on Cursor's side.
   */
  conversationGroupId?: string;
  /**
   * This turn's id. Shared with the `x-original-request-id` header the calls carry, because
   * the real client uses one value for both — see bidi.ts.
   */
  runId?: string;
  /**
   * The state a previous turn of this conversation left behind — see conversation.ts.
   *
   * Absent starts a conversation, which is what a first turn wants and what every turn used to
   * do. Present is what makes this one a continuation: Cursor keeps the history against this
   * state, so the prompt below only has to carry what is new.
   */
  state?: Uint8Array;
  /**
   * The messages that become the prompt, when that is not the whole transcript.
   *
   * A continuation sends the difference rather than the conversation: the rest is already on
   * Cursor's side, behind the state above, and sending it again is what this exists to stop.
   */
  messages?: ChatMessage[];
}

/** The run request, ready for the codec */
export function buildRunRequest(body: ChatRequest, opts: BuildOptions): { request: Message; delegate: boolean } {
  const { prompt, system } = flatten(opts.messages ?? body.messages ?? []);
  const tools: ClientTool[] = (body.tools ?? [])
    .map((t) => t.function)
    .filter((f): f is NonNullable<typeof f> => Boolean(f?.name));
  const definitions = toDefinitions(tools);
  /*
   * Mode is read off the whole request, not the continuation slice. A later turn of a
   * conversation sends only what is new as the prompt, and that slice no longer has the
   * system block Claude Code puts "Plan mode is active" in — see agentMode().
   */
  const whole = flatten(body.messages ?? []);
  const { mode, delegate } = agentMode(body, whole.system, whole.prompt);
  const conversationId = opts.conversationId || crypto.randomUUID();
  const model = opts.model;

  return {
    delegate,
    request: {
      run_request: {
        /*
         * The server's own state, as bytes it handed over on an earlier turn of this
         * conversation — see conversation.ts. Empty rather than absent on a first turn, which
         * is what the real client sends and what tells the server to start one.
         */
        conversation_state: opts.state ?? new Uint8Array(0),
        action: {
          user_message_action: {
            user_message: {
              text: withSystem(prompt, system),
              message_id: crypto.randomUUID(),
              selected_context: new Uint8Array(0),
              mode,
            },
          },
        },
        // Sent even when it is empty, which is what the real client does
        mcp_tools: definitions.length ? { mcp_tools: definitions } : {},
        conversation_id: conversationId,
        conversation_group_id: opts.conversationGroupId || conversationId,
        requested_model: {
          model_id: model.id,
          max_mode: model.max,
          ...(model.parameters.length ? { parameters: model.parameters } : {}),
        },
        /*
         * There is no workspace on this side to index, and the field for saying so cannot be
         * used: `exclude_workspace_context: true` is refused — "Workspace context exclusion is
         * not allowed" — and the turn ends as a 502 before a token of it arrives. Sent as
         * false, explicitly, because the field has presence and absent is not the same answer.
         * What the agent then asks for, session.ts answers.
         */
        exclude_workspace_context: false,
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

import crypto from 'node:crypto';
import type { Message } from './codec.js';
import { ENUMS } from './schema.generated.js';

/**
 * A Chat Completions request, as Cursor's chat RPC wants it.
 *
 * The pivot is deliberate. Everything reaching this gateway is already turned into Chat
 * Completions by gateway/translate.ts — Claude Code's Messages on one side, Codex's
 * Responses on the other — so writing the bridge against that one shape gives both CLIs
 * the Cursor upstream, and leaves exactly one thing here to get right instead of two.
 *
 * What does not survive, because Cursor's protocol has nowhere to put it: sampling
 * parameters (temperature, top_p, stop sequences) and token ceilings. Cursor's server
 * builds the model call itself and takes a model name and a conversation, not a decoding
 * configuration. A request carrying them is answered rather than refused — the alternative
 * is failing every Claude Code request, since it always sends max_tokens.
 */

const MESSAGE_TYPE = ENUMS['aiserver.v1.ConversationMessage.MessageType'] ?? {};
const UNIFIED_MODE = ENUMS['aiserver.v1.StreamUnifiedChatRequest.UnifiedMode'] ?? {};
const TOOL = ENUMS['aiserver.v1.ClientSideToolV2'] ?? {};

const HUMAN = MESSAGE_TYPE['MESSAGE_TYPE_HUMAN'] ?? 1;
const AI = MESSAGE_TYPE['MESSAGE_TYPE_AI'] ?? 2;
const MODE_CHAT = UNIFIED_MODE['UNIFIED_MODE_CHAT'] ?? 1;
const MODE_AGENT = UNIFIED_MODE['UNIFIED_MODE_AGENT'] ?? 2;

/**
 * Which of Cursor's client-side tools this bridge can actually run: the MCP one, and only
 * it.
 *
 * `supported_tools` is a fixed catalogue — read_file, edit_file, run_terminal_command and
 * the rest — that the IDE implements against a workspace this gateway does not have. The
 * MCP arm is the one that carries an arbitrary name and a JSON schema, which is what a
 * caller's own tools have to travel as. Listing anything else would invite a call nobody
 * here can answer, and the turn would hang waiting for a result that is never coming.
 */
const TOOL_MCP = TOOL['CLIENT_SIDE_TOOL_V2_MCP'] ?? 19;

/** What a tool declared by the caller is called on Cursor's side */
const MCP_SERVER_NAME = 'agentlodge';

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
  return content.filter((p) => p.type === 'text' && p.text).map((p) => p.text).join('\n');
};

/**
 * The pictures in one message, as bytes.
 *
 * A data URL is decoded; an ordinary `https://` one is dropped. Cursor's ImageProto holds
 * the image itself and has no field for an address, and fetching it here would mean this
 * process making a request to wherever a client's message pointed — which is an SSRF with
 * extra steps.
 */
function imagesOf(content: ChatMessage['content']): Message[] {
  if (!Array.isArray(content)) return [];
  const out: Message[] = [];
  for (const part of content) {
    const url = part.image_url?.url ?? '';
    const comma = url.startsWith('data:') ? url.indexOf(',') : -1;
    if (comma < 0) continue;
    out.push({ data: new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64')), uuid: crypto.randomUUID() });
  }
  return out;
}

/** One entry of the transcript, with the fields every message carries filled in */
function bubble(type: number, text: string, extra: Message = {}): Message {
  return { text, type, bubble_id: crypto.randomUUID(), ...extra };
}

/**
 * The transcript, as Cursor keeps it.
 *
 * The shapes differ in where a tool call lives. On the Chat Completions side an assistant
 * message carries `tool_calls` and each result arrives as a later `role: "tool"` message
 * of its own; on Cursor's side the call **and** its result hang off the assistant message
 * that made it, in `tool_results`. So a result is walked forward onto the message that
 * asked for it, matched by id.
 *
 * A result whose call is nowhere in the transcript — a client that compacted its history,
 * or the first turn after a restart — becomes a human message instead of being dropped.
 * The model asked for something and what came back is part of the conversation; leaving it
 * out leaves a question with no answer in it.
 */
function conversationOf(messages: ChatMessage[]): { conversation: Message[]; system: string } {
  const conversation: Message[] = [];
  const system: string[] = [];
  /** tool_call_id to the tool_results array of the message that made the call */
  const awaiting = new Map<string, Message>();

  for (const m of messages) {
    const role = m.role ?? 'user';

    if (role === 'system' || role === 'developer') {
      const text = textOf(m.content);
      if (text) system.push(text);
      continue;
    }

    if (role === 'tool') {
      const result = awaiting.get(m.tool_call_id ?? '');
      if (result) {
        result['content'] = textOf(m.content);
        continue;
      }
      conversation.push(bubble(HUMAN, textOf(m.content)));
      continue;
    }

    if (role === 'assistant') {
      const calls = m.tool_calls ?? [];
      const results: Message[] = [];
      for (const call of calls) {
        const id = call.id ?? crypto.randomUUID();
        const name = call.function?.name ?? '';
        const rawArgs = call.function?.arguments ?? '{}';
        const result: Message = {
          tool_call_id: id,
          tool_name: name,
          raw_args: rawArgs,
          content: '',
          tool_call: { tool: TOOL_MCP, tool_call_id: id, name, raw_args: rawArgs },
        };
        results.push(result);
        awaiting.set(id, result);
      }
      conversation.push(
        bubble(AI, textOf(m.content), {
          ...(results.length ? { tool_results: results, is_agentic: true } : {}),
        }),
      );
      continue;
    }

    const images = imagesOf(m.content);
    conversation.push(bubble(HUMAN, textOf(m.content), images.length ? { images } : {}));
  }

  return { conversation, system: system.join('\n\n') };
}

/**
 * The caller's tools, as MCP tools.
 *
 * `parameters` is a **JSON string** on this side rather than a nested message, which is
 * what makes an arbitrary schema expressible at all — Cursor's own tools each have a typed
 * params message, and a caller's do not exist in that catalogue.
 */
function mcpToolsOf(tools: ChatRequest['tools']): Message[] {
  return (tools ?? [])
    .filter((t) => t.function?.name)
    .map((t) => ({
      name: t.function!.name!,
      description: t.function!.description ?? '',
      parameters: JSON.stringify(t.function!.parameters ?? { type: 'object', properties: {} }),
      server_name: MCP_SERVER_NAME,
    }));
}

export interface BuildOptions {
  /** What the upstream calls this model; the name has already been resolved by the models table */
  model: string;
  /**
   * Groups this turn with the ones before it for Cursor's own accounting. The gateway's
   * conversation id where there is one — an api key's requests have none, and a uuid per
   * request is then the honest answer rather than a shared constant.
   */
  conversationId?: string;
}

/** The request message, ready for the codec */
export function buildChatRequest(body: ChatRequest, opts: BuildOptions): Message {
  const { conversation, system } = conversationOf(body.messages ?? []);
  const mcpTools = mcpToolsOf(body.tools);
  const agentic = mcpTools.length > 0;

  return {
    conversation,
    model_details: { model_name: opts.model, max_mode: false },
    // Empty rather than absent: the field is how the server learns the prompt has no
    // workspace behind it, and an absent one reads as "the client forgot", not "there is none"
    explicit_context: { context: system, repo_context: '' },
    is_chat: !agentic,
    is_agentic: agentic,
    conversation_id: opts.conversationId || crypto.randomUUID(),
    unified_mode: agentic ? MODE_AGENT : MODE_CHAT,
    use_unified_chat_prompt: true,
    should_cache: true,
    ...(agentic
      ? { mcp_tools: mcpTools, supported_tools: [TOOL_MCP] }
      : // Said explicitly, because the alternative is the server offering its own tools to a
        // client that has no way to run them and then waiting for results that never come
        { should_disable_tools: true }),
  };
}

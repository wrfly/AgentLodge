import { decode, oneofOf, type Message } from './codec.js';
import { endOfStream, FrameReader, type Frame } from './connect.js';

/**
 * Cursor's answer, as a Chat Completions stream.
 *
 * The other direction of the bridge: frames in, the SSE a Chat Completions client expects
 * out, so that gateway/translate.ts can carry it the rest of the way to whichever CLI
 * asked — Claude Code's Messages or Codex's Responses. Nothing downstream of here knows
 * the upstream was Cursor.
 *
 * ## What is not carried
 *
 * **Thinking.** Cursor streams it (`thinking.text`), Chat Completions has no field for it,
 * and the shapes vendors invented for one are not read by the translator on the other
 * side. Folding it into `content` was the alternative and is worse: the reasoning would
 * arrive as part of the answer, in the answer's own voice, with nothing marking where it
 * stopped.
 *
 * **Token counts.** Cursor bills its own way and reports no usage at all — see estimate()
 * below for what is booked instead, and why that matters for a deployment that meters.
 */

/** Roughly what a character costs, between ~1.5 per token for Chinese and ~4 for English */
const CHARS_PER_TOKEN = 3;

/** The plain server-streaming RPC's frames */
export const PLAIN = 'aiserver.v1.StreamUnifiedChatResponse';
/** The tool-capable RPC's frames, which wrap the above in a oneof */
export const WITH_TOOLS = 'aiserver.v1.StreamUnifiedChatResponseWithTools';

export interface CursorToChatOptions {
  /** The name to echo back, which is the one the caller asked for */
  model: string;
  /** How much text went out, for the estimate that stands in for a token count */
  promptChars: number;
  /**
   * Which message the frames carry, which follows from the RPC that was called. The two
   * differ only in the wrapper: `…WithTools` is a oneof whose interesting arm is the plain
   * response, so everything after unwrapping is shared.
   */
  responseType?: typeof PLAIN | typeof WITH_TOOLS;
}

interface PendingCall {
  index: number;
  id: string;
  name: string;
  args: string;
}

export class CursorToChat {
  private readonly frames = new FrameReader();
  private readonly model: string;
  private readonly promptChars: number;
  private readonly responseType: string;
  private readonly calls = new Map<string, PendingCall>();
  private outputChars = 0;
  private finished = false;
  /** Set once the upstream has said no; nothing after it is worth relaying */
  private failed = false;

  constructor(opts: CursorToChatOptions) {
    this.model = opts.model;
    this.promptChars = opts.promptChars;
    this.responseType = opts.responseType ?? PLAIN;
  }

  private chunk(delta: unknown, finish: string | null = null): string {
    return `data: ${JSON.stringify({
      id: 'chatcmpl_cursor',
      object: 'chat.completion.chunk',
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  }

  /**
   * A refusal, in the shape the translator recognises as one.
   *
   * `choices` is absent deliberately: that is what isErrorBody() tests for, and it is what
   * turns this into an `event: error` carrying Cursor's own wording rather than an empty
   * answer under a 200. See gateway/translate.ts.
   */
  private error(message: string): string {
    this.failed = true;
    return `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`;
  }

  /** Upstream bytes in, Chat Completions SSE out */
  push(bytes: Uint8Array): string {
    if (this.failed) return '';
    let out = '';
    for (const frame of this.frames.push(bytes)) {
      out += this.absorb(frame);
      if (this.failed) break;
    }
    return out;
  }

  private absorb(frame: Frame): string {
    const trailer = endOfStream(frame);
    if (trailer) {
      this.finished = true;
      if (trailer.error) {
        // Both halves are worth keeping: the code is what a client retries on, the message
        // is the only sentence a person can act on
        const code = trailer.error.code ? `${trailer.error.code}: ` : '';
        return this.error(`${code}${trailer.error.message ?? 'the upstream ended the stream with an error'}`);
      }
      return '';
    }

    let msg: Message;
    try {
      msg = decode(this.responseType, frame.payload);
    } catch {
      // A frame the tables cannot walk. Skipping it loses one event; throwing loses the
      // answer, and a schema that has drifted is exactly when the rest still arrives
      return '';
    }

    let body = msg;
    if (this.responseType === WITH_TOOLS) {
      const arm = oneofOf(WITH_TOOLS, msg, 'response');
      if (!arm) return '';
      // A tool call as its own arm of the wrapper — the plain response carries the same
      // thing in a field instead, and both are handled below
      if (arm.name === 'client_side_tool_v2_call') {
        this.note(arm.value as Message);
        return '';
      }
      if (arm.name !== 'stream_unified_chat_response') return '';
      body = arm.value as Message;
    }

    let out = '';

    const text = typeof body['text'] === 'string' ? body['text'] : '';
    if (text) {
      this.outputChars += text.length;
      out += this.chunk({ content: text });
    }

    // The same call, arriving on the response rather than as its own arm. Both shapes are
    // in use — which one depends on the model — and they carry the same three fields.
    for (const key of ['tool_call', 'tool_call_v2', 'partial_tool_call']) {
      const call = body[key];
      if (call && typeof call === 'object' && !(call instanceof Uint8Array)) this.note(call as Message);
    }

    return out;
  }

  /**
   * Remember a tool call, rather than emitting it now.
   *
   * Cursor sends a call several times as its arguments fill in, and the last one is the
   * whole thing. A client reading Chat Completions concatenates what it is given, so
   * relaying each frame would hand it the arguments repeated with growing prefixes —
   * invalid JSON, and a tool invoked with nothing usable. They go out complete, at end().
   */
  private note(call: Message): void {
    const id = String(call['tool_call_id'] ?? call['model_call_id'] ?? `call_${this.calls.size}`);
    const name = typeof call['name'] === 'string' ? call['name'] : '';
    const args = typeof call['raw_args'] === 'string' ? call['raw_args'] : '';
    const existing = this.calls.get(id);
    if (!existing) {
      this.calls.set(id, { index: this.calls.size, id, name, args });
      return;
    }
    // A later frame only ever adds: a partial call carries the name before the arguments
    // exist, and an empty field there means "nothing new", not "cleared"
    if (name) existing.name = name;
    if (args) existing.args = args;
  }

  /**
   * How much this turn cost, since the upstream will not say.
   *
   * ⚠️ These are **estimates**, and a deployment metering a Cursor upstream is metering
   * estimates — the quota gate, the usage report and every price derived from them. Cursor
   * bills by request against its own plan and its chat protocol carries no token counts at
   * all (`debugging_only_token_count` is what its name says). The alternative was booking
   * zero, which reads as a free upstream and lets one user's traffic run without ever
   * moving a window.
   */
  private estimate(): { prompt_tokens: number; completion_tokens: number; total_tokens: number } {
    const prompt = Math.max(Math.round(this.promptChars / CHARS_PER_TOKEN), 1);
    const toolChars = [...this.calls.values()].reduce((n, c) => n + c.name.length + c.args.length, 0);
    const completion = Math.max(Math.round((this.outputChars + toolChars) / CHARS_PER_TOKEN), 1);
    return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion };
  }

  /** The stream ended; close the message off the way a Chat Completions upstream would */
  end(): string {
    if (this.failed) return '';
    let out = '';

    if (this.calls.size) {
      out += this.chunk({
        tool_calls: [...this.calls.values()].map((c) => ({
          index: c.index,
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: c.args || '{}' },
        })),
      });
    }

    /*
     * A stream that stopped without its trailer. The bytes simply ran out mid-answer —
     * a dropped connection, or an upstream that gave up — and saying `stop` there tells
     * the client the model finished, which is the one reading that gets no retry.
     */
    if (!this.finished) return out + this.error('the upstream stream ended without finishing');

    out += this.chunk({}, this.calls.size ? 'tool_calls' : 'stop');
    out += `data: ${JSON.stringify({
      id: 'chatcmpl_cursor',
      object: 'chat.completion.chunk',
      model: this.model,
      choices: [],
      usage: this.estimate(),
    })}\n\n`;
    return `${out}data: [DONE]\n\n`;
  }
}

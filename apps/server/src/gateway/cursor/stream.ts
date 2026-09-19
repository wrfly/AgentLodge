import type { Usage } from './session.js';

/**
 * Cursor's answer, as a Chat Completions stream.
 *
 * The other direction of the bridge: the events a turn produces in, the SSE a Chat Completions
 * client expects out, so gateway/translate.ts can carry it the rest of the way to whichever
 * CLI asked. Nothing downstream of here knows the upstream was Cursor.
 *
 * ## What is not carried
 *
 * **Thinking.** Cursor streams it on its own channel and Chat Completions has no field for it;
 * the shapes vendors invented for one are not read by the translator on the other side. It is
 * dropped in session.ts rather than folded into `content`, which would deliver the reasoning
 * as part of the answer, in the answer's voice, with nothing marking where it stopped.
 *
 * **Several tool calls at once.** A turn hands over one call and waits, because resuming it
 * needs exactly one answer to match against. A model that wanted two gets asked twice.
 */

const OBJECT = 'chat.completion.chunk';

export class ChatStream {
  private wroteToolCall = false;

  constructor(private readonly model: string) {}

  private chunk(delta: unknown, finish: string | null = null): string {
    return `data: ${JSON.stringify({
      id: 'chatcmpl_cursor',
      object: OBJECT,
      model: this.model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`;
  }

  text(text: string): string {
    return text ? this.chunk({ content: text }) : '';
  }

  /**
   * One tool call, complete.
   *
   * Sent in a single delta rather than streamed in pieces: the arguments are already whole by
   * the time Cursor asks for the call, and a client reading Chat Completions concatenates
   * what it is given — so splitting them would only create a window where the JSON is invalid.
   */
  tool(callId: string, name: string, input: Record<string, unknown>): string {
    this.wroteToolCall = true;
    return this.chunk({
      tool_calls: [
        { index: 0, id: callId, type: 'function', function: { name, arguments: JSON.stringify(input) } },
      ],
    });
  }

  /**
   * A refusal, in the shape the translator recognises as one.
   *
   * `choices` is absent deliberately: that is what isErrorBody() tests for, and it is what
   * turns this into an `event: error` carrying Cursor's own wording rather than an empty
   * answer under a 200. See gateway/translate.ts.
   */
  error(message: string): string {
    return `data: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`;
  }

  /** The turn ended; close the message off the way a Chat Completions upstream would */
  done(usage?: Usage): string {
    let out = this.chunk({}, this.wroteToolCall ? 'tool_calls' : 'stop');
    out += `data: ${JSON.stringify({
      id: 'chatcmpl_cursor',
      object: OBJECT,
      model: this.model,
      choices: [],
      usage: chatUsage(usage),
    })}\n\n`;
    return `${out}data: [DONE]\n\n`;
  }
}

/**
 * The turn's cost, as Cursor reported it.
 *
 * Agent mode ends every turn with the real counts, which is the difference between metering
 * this upstream and guessing at it. Cursor's `input_tokens` is the size of the prompt, and
 * `cache_read_tokens` / `cache_write_tokens` say how much of that prompt was served from a
 * checkpoint or stored into one — they are not extra tokens on top. Chat Completions has
 * fewer places to put numbers, so they travel like this:
 *
 *   **cache reads** sit in `prompt_tokens_details.cached_tokens`, the field this wire already
 *   has. The translator turns that into Anthropic's `cache_read_input_tokens`.
 *
 *   **cache writes** sit next to them as `cache_write_tokens`. The field is not on the OpenAI
 *   schema; without it they vanished into ordinary input and Claude Code never saw a write.
 *
 *   **reasoning** is reported but not added to the total. Whether `output_tokens` already
 *   counts it is not something this end can see, and charging twice for the same tokens is
 *   the worse of the two mistakes — so a thinking model may be under-counted here.
 */
function chatUsage(usage?: Usage): Record<string, unknown> {
  const cached = usage?.cacheRead ?? 0;
  const wrote = usage?.cacheWrite ?? 0;
  const prompt = usage?.input ?? 0;
  const completion = usage?.output ?? 0;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    prompt_tokens_details: { cached_tokens: cached, cache_write_tokens: wrote },
    ...(usage?.reasoning ? { completion_tokens_details: { reasoning_tokens: usage.reasoning } } : {}),
  };
}

import crypto from 'node:crypto';
import os from 'node:os';
import { BidiStream, type BidiOptions, BidiError } from './bidi.js';
import { decode, oneofOf, type Message } from './codec.js';
import { endOfStream, statusOf } from './connect.js';
import { EXEC_TOOLS, shellStream, toolFor } from './exec-bridge.js';
import { argsOf, clientName, mcpResult } from './mcp.js';

/**
 * One turn of Cursor's agent, as a run of events.
 *
 * Cursor's agent protocol is not a request and a reply: during a turn the server asks the
 * client for things, and the turn does not progress until it gets them. Three kinds of
 * asking, handled three ways:
 *
 *   conversation state  the server keeps its own state on the client, as opaque blobs. Held
 *                       in memory for the turn and handed back when asked. Not optional — a
 *                       turn stops where a blob it asked for does not come back
 *   workspace context   what OS, what shell, which directory. Answered from here
 *   tool execution      a file read, a command, a search. Handed to the caller, because this
 *                       process has no workspace and no business running the model's commands
 *
 * What comes out is text, tool calls for the caller, and — at the end — the token counts the
 * turn actually cost, which the server reports and nothing here has to estimate.
 */

/** Cursor's own figures for the turn, which is what makes this upstream meterable */
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}

export type AgentEvent =
  | { kind: 'text'; text: string }
  /** The caller has to run this and come back with the result */
  | { kind: 'tool'; callId: string; name: string; input: Record<string, unknown> }
  | { kind: 'done'; usage?: Usage }
  | { kind: 'error'; message: string; status?: number };

const SERVER_MESSAGE = 'agent.v1.AgentServerMessage';

/** A request handed to the caller, waiting for what it answers with */
interface Pending {
  /** The exec id the answer has to carry back */
  id: number;
  execId: string;
  args: Message;
  /** Which bridge answers it, or absent when this was one of the caller's own tools */
  tool?: (typeof EXEC_TOOLS)[number];
}

export interface SessionOptions extends BidiOptions {
  /**
   * The directory reported to Cursor as the workspace.
   *
   * A name, not a path this process has: the caller runs the tools, in its own checkout,
   * which this end never sees. It is reported because the field is not optional and because
   * an agent told nothing about where it is asks for less.
   */
  workspace: string;
  /**
   * Whether the caller brought tools of its own.
   *
   * When it did not, it has no loop to run one in and no way to answer — so a tool request
   * that arrives anyway is refused rather than handed over, and the turn carries on without
   * it. See run().
   */
  delegate: boolean;
}

export class AgentSession {
  private readonly stream: BidiStream;
  private readonly blobs = new Map<string, Uint8Array>();
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly opts: SessionOptions) {
    this.stream = new BidiStream(opts);
  }

  /** What Cursor is calling this conversation, for a caller that wants to log it */
  get requestId(): string {
    return this.stream.requestId;
  }

  /**
   * Drive the turn.
   *
   * Yields until the turn ends or until it needs the caller: a `tool` event leaves the
   * generator suspended exactly where it is, so submit() and another turn of the loop pick up
   * the same conversation rather than starting a new one.
   */
  async *run(request: Message): AsyncGenerator<AgentEvent> {
    try {
      await this.stream.open(request);
    } catch (e) {
      yield {
        kind: 'error',
        message: e instanceof BidiError ? e.message : `Could not reach Cursor: ${(e as Error).message}`,
        status: e instanceof BidiError ? e.status : 502,
      };
      return;
    }

    try {
      for await (const frame of this.stream.read()) {
        const trailer = endOfStream(frame);
        if (trailer) {
          if (trailer.error) {
            // Both halves are worth keeping: the code is what a client and the gate retry on,
            // the message is the only sentence a person can act on
            const code = trailer.error.code ? `${trailer.error.code}: ` : '';
            yield {
              kind: 'error',
              message: `${code}${trailer.error.message ?? 'the upstream ended the stream with an error'}`,
              status: statusOf(trailer.error.code),
            };
            return;
          }
          yield { kind: 'done' };
          return;
        }

        let message: Message;
        try {
          message = decode(SERVER_MESSAGE, frame.payload);
        } catch {
          // One frame the tables cannot walk. Skipping it loses an event; throwing loses the
          // answer, and drifted tables are exactly when the rest of the turn still arrives.
          continue;
        }

        for await (const event of this.handle(message)) {
          /*
           * A tool event suspends this generator exactly here and does not end it: the consumer
           * stops pulling, the response it was driving ends at the tool call, and the next
           * request submits the result and pulls again — picking the same turn up at this line
           * rather than starting another one. Returning here instead is the mistake that makes
           * a resumed turn look like an upstream that hung up.
           */
          yield event;
          if (event.kind === 'done' || event.kind === 'error') return;
        }
      }
      // The bytes ran out with no trailer: a dropped connection, or an upstream that gave up
      yield { kind: 'error', message: 'the upstream stream ended without finishing' };
    } catch (e) {
      yield { kind: 'error', message: `Cursor stopped answering: ${(e as Error).message}` };
    }
  }

  /** One server message: answered here, or turned into an event */
  private async *handle(message: Message): AsyncGenerator<AgentEvent> {
    const kv = message['kv_server_message'];
    if (isMessage(kv)) {
      await this.stream.send({ kv_client_message: this.blobReply(kv) });
      return;
    }

    const exec = message['exec_server_message'];
    if (isMessage(exec)) {
      yield* this.exec(exec);
      return;
    }

    const update = message['interaction_update'];
    if (!isMessage(update)) return;

    const text = update['text_delta'];
    if (isMessage(text) && typeof text['text'] === 'string' && text['text']) {
      yield { kind: 'text', text: text['text'] };
      return;
    }

    /*
     * Thinking arrives on its own channel here, which is the one thing agent mode gets right
     * that the chat RPC did not: it is dropped rather than mixed into the answer, because Chat
     * Completions has nowhere to put it and folding it into `content` would deliver the
     * reasoning as part of the reply, in the reply's voice, with nothing marking where it
     * stopped.
     */
    if (update['thinking_delta'] !== undefined) return;

    const ended = update['turn_ended'];
    if (isMessage(ended)) {
      yield {
        kind: 'done',
        usage: {
          input: Number(ended['input_tokens'] ?? 0),
          output: Number(ended['output_tokens'] ?? 0),
          cacheRead: Number(ended['cache_read_tokens'] ?? 0),
          cacheWrite: Number(ended['cache_write_tokens'] ?? 0),
          reasoning: Number(ended['reasoning_tokens'] ?? 0),
        },
      };
    }
  }

  /** The server's own conversation state, kept here for the length of the turn */
  private blobReply(message: Message): Message {
    const id = Number(message['id'] ?? 0);

    const set = message['set_blob_args'];
    if (isMessage(set)) {
      this.blobs.set(keyOf(set['blob_id']), asBytes(set['blob_data']));
      return { id, set_blob_result: {} };
    }

    const get = message['get_blob_args'];
    const blob = isMessage(get) ? this.blobs.get(keyOf(get['blob_id'])) : undefined;
    return {
      id,
      get_blob_result: blob ? { blob_data: blob } : { error: { message: 'no such blob' } },
    };
  }

  private async *exec(message: Message): AsyncGenerator<AgentEvent> {
    const id = Number(message['id'] ?? 0);
    const execId = String(message['exec_id'] ?? '');

    if (message['request_context_args'] !== undefined) {
      await this.stream.send({ exec_client_message: { id, exec_id: execId, request_context_result: this.context() } });
      return;
    }

    // One of the caller's own tools, coming back under the name it was registered with
    const mcp = message['mcp_args'];
    if (isMessage(mcp)) {
      const callId = String(mcp['tool_call_id'] ?? '') || `mcp_${id}`;
      this.pending.set(callId, { id, execId, args: mcp });
      yield {
        kind: 'tool',
        callId,
        name: clientName(String(mcp['tool_name'] ?? mcp['name'] ?? '')),
        input: argsOf(mcp['args']),
      };
      return;
    }

    const tool = toolFor(message);
    /*
     * Nothing to hand this to. Both cases end the same way: the exec is thrown rather than
     * left unanswered, because a request with no reply does not fail the turn — it stops it,
     * with the client still waiting and nothing to say why.
     *
     * The unbridged ones are `ls_args` and `grep_args`, whose results are a directory tree and
     * a per-file match map; a caller's tool answers with text, which is neither. Current
     * models ask for the `pi_` variants of both, which are bridged.
     */
    if (!tool || !this.opts.delegate) {
      await this.stream.send({
        exec_client_control_message: {
          throw: {
            id,
            error: tool
              ? 'this client has no tools of its own to run, so tool execution is not available'
              : 'this client cannot run that tool',
            error_code: 'unsupported',
          },
        },
      });
      return;
    }

    const args = (message[tool.args] as Message) ?? {};
    const input = tool.input(args);
    // A request this bridge understands but cannot express as one call on the caller's side
    if ('error' in input && typeof input.error === 'string') {
      await this.answer({ id, execId, args, tool }, input.error, true);
      return;
    }

    const callId = String(args['tool_call_id'] ?? '') || `${tool.args}_${id}`;
    this.pending.set(callId, { id, execId, args, tool });
    yield { kind: 'tool', callId, name: tool.name, input: input as Record<string, unknown> };
  }

  /** Where the caller says it is, which is all this end can honestly report */
  private context(): Message {
    return {
      success: {
        request_context: {
          env: {
            os_version: `${os.type()} ${os.release()}`,
            workspace_paths: [this.opts.workspace],
            project_folder: this.opts.workspace,
            shell: '/bin/bash',
            sandbox_enabled: false,
            time_zone: process.env['TZ'] || 'UTC',
          },
        },
      },
    };
  }

  /** The caller came back with a result for a request that was handed to it */
  async submit(callId: string, text: string, isError = false): Promise<boolean> {
    const pending = this.pending.get(callId);
    if (!pending) return false;
    this.pending.delete(callId);
    await this.answer(pending, text, isError);
    return true;
  }

  /** Which tool call ids this turn is waiting on */
  get waiting(): string[] {
    return [...this.pending.keys()];
  }

  private async answer(pending: Pending, text: string, isError: boolean): Promise<void> {
    const { id, execId, args, tool } = pending;

    if (!tool) {
      await this.stream.send({ exec_client_message: { id, exec_id: execId, mcp_result: mcpResult(text, isError) } });
      return;
    }

    if (tool.streaming) {
      const cwd = String(args['working_directory'] ?? '') || this.opts.workspace;
      for (const event of shellStream(text, isError, cwd)) {
        await this.stream.send({ exec_client_message: { id, exec_id: execId, [tool.result]: event } });
      }
      // A streaming exec is not finished until it is closed; without this the turn waits for
      // output that is never coming
      await this.stream.send({ exec_client_control_message: { stream_close: { id } } });
      return;
    }

    await this.stream.send({
      exec_client_message: { id, exec_id: execId, [tool.result]: tool.output(args, text, isError) },
    });
  }

  async close(): Promise<void> {
    await this.stream.close();
  }
}

const isMessage = (v: unknown): v is Message =>
  Boolean(v) && typeof v === 'object' && !(v instanceof Uint8Array) && !Array.isArray(v);

/** A blob id is bytes; a Map needs something comparable */
const keyOf = (v: unknown): string => Buffer.from(asBytes(v)).toString('base64');

const asBytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(0));

/** For a probe that wants to name what it saw without decoding it twice */
export const armOf = (message: Message, group: string): string =>
  oneofOf(SERVER_MESSAGE, message, group)?.name ?? '';

export const newCallId = (): string => `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

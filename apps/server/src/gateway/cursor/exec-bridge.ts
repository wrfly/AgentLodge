import type { Message } from './codec.js';

/**
 * Cursor's own tool requests, handed to the caller to run.
 *
 * This is the half of agent mode that is not obvious. Cursor's agent expects to be driving an
 * editor: during a turn it asks the client to read a file, run a command, search a tree, and
 * waits. This gateway has no workspace and must not run model-authored commands on the
 * server, so each request is turned into a tool call on the **caller's** side — Claude Code's
 * own `Bash`, `Read`, `Write`, `Edit`, `Grep` and `Glob`, executed in the caller's checkout
 * under the caller's own permission prompts — and the plain text that comes back is turned
 * into whatever protobuf result the agent was waiting for.
 *
 * So the names here are Claude Code's, deliberately. A caller with no tool of that name
 * answers with an error, which reaches the model as a failed tool call and is recoverable;
 * that is why a request is only ever delegated when the caller declared tools of its own and
 * therefore has a loop to run them in. See session.ts.
 *
 * Two shapes exist for most of these because Cursor kept the old ones: `read_args` answers
 * with a structured `ReadSuccess`, while `pi_read_args` answers with one `output` string.
 * Both are bridged — which a model asks for depends on the model.
 */

export interface ExecTool {
  /** What the caller's tool is called */
  name: string;
  /** The `ExecServerMessage` field that carries the request */
  args: string;
  /** The `ExecClientMessage` field that carries the answer */
  result: string;
  /** Answered with a run of `ShellStream` events rather than one result message */
  streaming?: boolean;
  /** The request, as that tool's input */
  input(args: Message): Record<string, unknown> | { error: string };
  /** The caller's text, as the result the agent is waiting for */
  output(args: Message, text: string, isError: boolean): Message;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | undefined => (typeof v === 'number' && v > 0 ? v : undefined);
const lines = (text: string): number => (text ? text.split('\n').length : 0);
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

/** The `pi_*` family's shared answer: one string, or one error */
const output = (_args: Message, text: string, isError: boolean): Message =>
  isError ? { error: { error: text } } : { success: { output: text } };

const shellInput = (args: Message): Record<string, unknown> => {
  const out: Record<string, unknown> = { command: str(args['command']) };
  const description = str(args['description']);
  if (description) out['description'] = description;
  return out;
};

/** What a shell command produced, in the shape a one-shot shell exec answers with */
const shellOutput = (args: Message, text: string, isError: boolean): Message => {
  const state = {
    command: str(args['command']),
    working_directory: str(args['working_directory']),
    exit_code: isError ? 1 : 0,
    signal: '',
    stdout: isError ? '' : text,
    stderr: isError ? text : '',
    execution_time: 0,
  };
  return isError ? { failure: state } : { success: state };
};

const readInput = (args: Message): Record<string, unknown> => {
  const out: Record<string, unknown> = { file_path: str(args['path']) };
  const offset = num(args['offset']);
  const limit = num(args['limit']);
  if (offset !== undefined) out['offset'] = offset;
  if (limit !== undefined) out['limit'] = limit;
  return out;
};

const readOutput = (args: Message, text: string, isError: boolean): Message => {
  const path = str(args['path']);
  if (isError) return { error: { path, error: text } };
  return {
    success: {
      path,
      content: text,
      total_lines: lines(text),
      file_size: bytes(text),
      truncated: false,
      range_applied: Boolean(num(args['offset']) ?? num(args['limit'])),
    },
  };
};

const writeOutput = (args: Message, text: string, isError: boolean): Message => {
  const path = str(args['path']);
  if (isError) return { error: { path, error: text } };
  const content = str(args['file_text']);
  return { success: { path, lines_created: lines(content), file_size: bytes(content) } };
};

/**
 * A replacement, if there is exactly one.
 *
 * Cursor can batch several into one request and the caller's `Edit` takes one. Forwarding the
 * first and dropping the rest would apply a partial edit and report success, so this refuses
 * instead: the model sees the error, and edits one at a time.
 */
const editInput = (args: Message): Record<string, unknown> | { error: string } => {
  const edits = Array.isArray(args['edits']) ? (args['edits'] as Message[]) : [];
  if (edits.length !== 1) {
    return { error: `this client applies one replacement per edit, and ${edits.length} were requested` };
  }
  return {
    file_path: str(args['path']),
    old_string: str(edits[0]!['old_text']),
    new_string: str(edits[0]!['new_text']),
  };
};

const grepInput = (args: Message): Record<string, unknown> => {
  const out: Record<string, unknown> = { pattern: str(args['pattern']) };
  if (str(args['path'])) out['path'] = str(args['path']);
  if (str(args['glob'])) out['glob'] = str(args['glob']);
  if (args['ignore_case'] === true) out['-i'] = true;
  return out;
};

const findInput = (args: Message): Record<string, unknown> => {
  const out: Record<string, unknown> = { pattern: str(args['pattern']) };
  if (str(args['path'])) out['path'] = str(args['path']);
  return out;
};

/** The caller has no directory-listing tool, so this borrows its shell */
const lsInput = (args: Message): Record<string, unknown> => {
  const path = str(args['path']) || '.';
  return { command: `ls -la ${JSON.stringify(path)}`, description: `List ${path}` };
};

export const EXEC_TOOLS: readonly ExecTool[] = [
  // A shell command, streamed. This is the one current models actually ask for.
  { name: 'Bash', args: 'shell_stream_args', result: 'shell_stream', streaming: true, input: shellInput, output: shellOutput },
  { name: 'Bash', args: 'shell_args', result: 'shell_result', input: shellInput, output: shellOutput },
  { name: 'Bash', args: 'mini_swe_agent_bash_args', result: 'mini_swe_agent_bash_result', input: shellInput, output: shellOutput },
  { name: 'Bash', args: 'pi_bash_args', result: 'pi_bash_result', input: shellInput, output },
  { name: 'Bash', args: 'pi_ls_args', result: 'pi_ls_result', input: lsInput, output },

  { name: 'Read', args: 'read_args', result: 'read_result', input: readInput, output: readOutput },
  { name: 'Read', args: 'redacted_read_args', result: 'redacted_read_result', input: readInput, output: readOutput },
  { name: 'Read', args: 'pi_read_args', result: 'pi_read_result', input: readInput, output },

  { name: 'Write', args: 'write_args', result: 'write_result', input: (a) => ({ file_path: str(a['path']), content: str(a['file_text']) }), output: writeOutput },
  { name: 'Write', args: 'pi_write_args', result: 'pi_write_result', input: (a) => ({ file_path: str(a['path']), content: str(a['content']) }), output },

  { name: 'Edit', args: 'pi_edit_args', result: 'pi_edit_result', input: editInput, output: (_a, text, isError) => (isError ? { error: { error: text } } : { success: { output: text, diff: '', patch: '' } }) },

  { name: 'Grep', args: 'pi_grep_args', result: 'pi_grep_result', input: grepInput, output },
  { name: 'Glob', args: 'pi_find_args', result: 'pi_find_result', input: findInput, output },
];

const BY_ARGS = new Map(EXEC_TOOLS.map((t) => [t.args, t]));

/** Whichever `*_args` field this request carries, and what to do with it */
export function toolFor(message: Message): ExecTool | undefined {
  for (const [field, tool] of BY_ARGS) if (message[field] !== undefined) return tool;
  return undefined;
}

/**
 * The events that answer a streaming shell request.
 *
 * A streaming exec stays open until the client closes it explicitly — without the
 * `stream_close` the turn sits waiting for output that is not coming — so the close is part
 * of answering, not cleanup.
 */
export function shellStream(text: string, isError: boolean, cwd: string): Message[] {
  const events: Message[] = [{ start: {} }];
  if (text) events.push(isError ? { stderr: { data: text } } : { stdout: { data: text } });
  events.push({ exit: { code: isError ? 1 : 0, cwd, aborted: false } });
  return events;
}

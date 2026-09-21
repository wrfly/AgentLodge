import type { MessageBlock, StoredMessage } from '../../../core/protocol.js';

export interface NativeMessage {
  role: 'user' | 'assistant';
  content: Array<Record<string, unknown>>;
}

const text = (blocks: MessageBlock[]): Array<Record<string, unknown>> =>
  blocks.flatMap((block) => block.kind === 'text' && block.text.trim()
    ? [{ type: 'text', text: block.text }]
    : []);

/**
 * Rebuild the API transcript from the database instead of resuming an opaque CLI session.
 * Thinking is not replayed because Anthropic requires its signature, which the app's
 * persisted display block intentionally does not contain.
 */
export function nativeHistory(stored: StoredMessage[]): NativeMessage[] {
  const out: NativeMessage[] = [];

  const push = (role: NativeMessage['role'], content: Array<Record<string, unknown>>) => {
    if (!content.length) return;
    const last = out.at(-1);
    if (last?.role === role) last.content.push(...content);
    else out.push({ role, content });
  };

  for (const message of stored) {
    if (message.role === 'user') {
      push('user', text(message.blocks));
      continue;
    }

    const assistant: Array<Record<string, unknown>> = [];
    const clientResults: Array<Record<string, unknown>> = [];
    for (const block of message.blocks) {
      if (block.kind === 'text' && block.text.trim()) {
        assistant.push({ type: 'text', text: block.text });
      } else if (block.kind === 'tool_use') {
        assistant.push({
          type: block.server ? 'server_tool_use' : 'tool_use',
          id: block.toolId,
          name: block.toolName,
          input: block.input,
        });
        if (block.server && block.serverResult) {
          assistant.push(block.serverResult);
        } else if (block.result) {
          clientResults.push({
            type: 'tool_result',
            tool_use_id: block.toolId,
            is_error: block.result.isError,
            content: block.result.content,
          });
        }
      }
    }
    push('assistant', assistant);
    push('user', clientResults);
  }

  return out;
}

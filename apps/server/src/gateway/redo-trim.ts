/**
 * Drop answers a user asked to replace from a request body.
 *
 * Editing the newest question, or retrying the newest answer, deletes the answer from our
 * records — and cannot delete it from the CLI's transcript, which lives in the agent's own
 * session and is not something we can write to. So `--resume` keeps sending the discarded
 * reply on every later request, and a model with its own answer still in front of it tends
 * to repeat it or refer back to it.
 *
 * This is the other half of that fix: the routes keep the discarded answer's text
 * (core/db/trims.ts), and the gateway matches it in each request body and cuts the message.
 *
 * The cut runs from the discarded assistant message up to — but not including — the next user
 * message, and backwards over anything the wire requires to stay attached to it. Never a
 * single block out of the middle: a tool-using answer carries `tool_use` blocks whose results
 * arrive in the following message, and the Responses wire puts the `reasoning` item in front
 * of the message it reasoned into. Either orphan is a 400, and a trim rule never expires, so
 * one would wedge the conversation for good.
 *
 * It goes no wider than that. Tool calls from earlier in the same turn are left standing —
 * they are a complete pair, and they record work that actually happened: files the model
 * edited are still edited, whatever we do to the answer describing them.
 *
 * Everything here degrades to "forward unchanged":
 *   - a rule that no longer matches — compaction rewrote the text, say — changes nothing
 *   - a conversation with no rules costs one indexed query and no rewriting
 *   - a body with no messages array (a tool continuation, an internal call) is left alone
 */
export function trimRedoAnswers(body: unknown, matches: string[]): unknown {
  if (!matches.length || !body || typeof body !== 'object') return body;
  const b = body as { messages?: unknown[]; input?: unknown[] };

  if (Array.isArray(b.messages)) {
    const next = dropSegment(b.messages, isUserMessage, isAssistantMessage, messageText, matches);
    return next === b.messages ? body : { ...b, messages: next };
  }
  if (Array.isArray(b.input)) {
    const next = dropSegment(b.input, isUserItem, isAssistantItem, itemText, matches, isReasoningItem);
    return next === b.input ? body : { ...b, input: next };
  }
  return body;
}

/**
 * Remove every segment [assistant, next-user) whose assistant message matches a rule, plus
 * whatever `isBoundToNext` says cannot be separated from its start.
 *
 * Returns the original array when nothing matched, so the caller can tell "rewritten" from
 * "untouched" by identity — a body that changed nothing is forwarded as it stood.
 */
function dropSegment<T>(
  arr: T[],
  isUser: (m: unknown) => boolean,
  isAssistant: (m: unknown) => boolean,
  textOf: (m: unknown) => string,
  matches: string[],
  isBoundToNext: (m: unknown) => boolean = () => false,
): T[] {
  let out: T[] = arr;
  /*
   * One cut per rule, and it is the earliest match that gets it.
   *
   * A rule is exact text and never expires, so an answer the model gives again later —
   * "Done." after a step, which a coding agent says often — matched the rule written for a
   * different turn and had its whole segment cut, tool calls and all. The user saw that turn
   * on screen; the model never saw it again, and nothing said so. The discarded answer is
   * always earlier in the transcript than any later twin, so spending the rule on the first
   * match takes the right one. Retried three times to the same words? Three rules, three
   * cuts.
   */
  const unspent = [...matches];
  for (let i = 0; i < out.length; i++) {
    const maybe = out[i];
    if (!maybe || !isAssistant(maybe)) continue;
    const text = textOf(maybe).trim();
    const rule = text ? unspent.indexOf(text) : -1;
    if (rule === -1) continue;

    let j = i + 1;
    while (j < out.length && !isUser(out[j])) j++;
    // No user message after it — nothing to define the cut by, so the rule is skipped.
    // A request always ends in a user message, so this is a guard rather than a case.
    if (j >= out.length) continue;

    // And backwards over whatever has to stay attached to it
    let start = i;
    while (start > 0 && isBoundToNext(out[start - 1])) start--;

    unspent.splice(rule, 1);
    if (out === arr) out = arr.slice();
    out.splice(start, j - start);
    i = start - 1; // the element that slid into `start` is the next one to inspect
  }
  return out;
}

/* ---------------- Anthropic Messages (Claude Code) ---------------- */

type WireMessage = { role?: string; content?: unknown };

/**
 * A user message that is somebody speaking, rather than a tool handing back a result.
 *
 * On the Anthropic wire a `tool_result` is carried in a message with `role: 'user'`, so a
 * scan looking for "the next thing the user said" stops on one — and a cut that ends there
 * removes the `tool_use` while leaving its result behind. The API rejects the orphan with a
 * 400, and since a trim rule never expires, every later request in that conversation is
 * rejected too: the conversation is wedged for good with nothing to undo it.
 */
function isUserMessage(m: unknown): boolean {
  if ((m as WireMessage)?.role !== 'user') return false;
  const c = (m as WireMessage).content;
  if (!Array.isArray(c)) return true;                  // a plain string is somebody talking
  return !c.every((p) => (p as { type?: string })?.type === 'tool_result');
}
function isAssistantMessage(m: unknown): boolean {
  return (m as WireMessage)?.role === 'assistant';
}

/** What a message says on the Anthropic wire: a string, or text blocks */
function messageText(m: unknown): string {
  const c = (m as WireMessage)?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c
    .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text'
      ? String((p as { text?: unknown }).text ?? '')
      : ''))
    .join('');
}

/* ---------------- Responses (Codex) ---------------- */

type WireItem = { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> };

/**
 * The Responses wire keeps tool output in its own item type rather than inside a user
 * message, so the `type === 'message'` test already walks past it. Spelled out because the
 * Anthropic side needs a deliberate exclusion and the two should read as the same rule.
 */
function isUserItem(m: unknown): boolean {
  const i = m as WireItem;
  return i?.type === 'message' && i.role === 'user';
}
function isAssistantItem(m: unknown): boolean {
  const i = m as WireItem;
  return i?.type === 'message' && i.role === 'assistant';
}

/**
 * A `reasoning` item, which the API requires to be immediately followed by the item it
 * reasoned into — the assistant message here, a `function_call` elsewhere. Cutting the message
 * and leaving this behind is rejected with "type 'reasoning' was provided without its required
 * following item", and since the rule that made the cut never expires, so is every request
 * after it. The Anthropic wire has no equivalent: thinking rides inside the message.
 */
function isReasoningItem(m: unknown): boolean {
  return (m as WireItem)?.type === 'reasoning';
}

/** What a message says on the Responses wire: its input/output text parts */
function itemText(m: unknown): string {
  const i = m as WireItem;
  return (i?.content ?? [])
    .filter((p) => p.type === 'input_text' || p.type === 'output_text')
    .map((p) => p.text ?? '')
    .join('');
}

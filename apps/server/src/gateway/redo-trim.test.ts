/**
 * The gateway's answer-dropping for edited/retried questions.
 *
 * The CLI's transcript cannot be edited, so after a redo it keeps sending the discarded
 * reply on every later request; the gateway matches the discarded text and cuts the message.
 * What is checked here is that the cut is the right segment — the assistant message up to
 * but not including the next user message, so tool results travel with their tool calls —
 * and that everything unmatched passes through byte for byte.
 *
 * Run: npm -w @agentlodge/server run test:redo-trim
 */
import { trimRedoAnswers } from './redo-trim.js';

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** The measured shape of a --resume request after an edit: the old answer sits in front of the new question */
function redoBody(answerText: string, question: string) {
  return {
    model: 'sonnet',
    max_tokens: 32000,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.224;' }],
    messages: [
      { role: 'user', content: '<system-reminder>…</system-reminder> the original question' },
      { role: 'system', content: [{ type: 'text', text: '<system-reminder> agent types…' }] },
      { role: 'assistant', content: [{ type: 'text', text: answerText }] },
      { role: 'user', content: [{ type: 'text', text: question }] },
      { role: 'system', content: '<system-reminder> tokens left' },
    ],
  };
}

console.log('\n=== The discarded answer is cut, the rest stays ===');
{
  const body = redoBody('sort.py is done', 'make it quicksort');
  const out = trimRedoAnswers(body, ['sort.py is done']) as typeof body;
  ok('the answer is gone', !out.messages.some((m) => m.role === 'assistant'));
  ok('the new question is still there',
    out.messages.some((m) => m.role === 'user' && JSON.stringify(m).includes('make it quicksort')));
  ok('the system reminders around it stay',
    out.messages.length === 4 && out.messages[3]!.role === 'system',
    JSON.stringify(out.messages.map((m) => m.role)));
  ok('everything else is untouched', out.model === 'sonnet' && Array.isArray(out.system) && out.max_tokens === 32000);
}

console.log('\n=== A rule that matches nothing changes nothing ===');
{
  const body = redoBody('sort.py is done', 'make it quicksort');
  ok('no rules at all returns the same object', trimRedoAnswers(body, []) === body);
  const out = trimRedoAnswers(body, ['a different answer']);
  ok('an unmatched rule leaves the body alone', out === body);
  const compacted = trimRedoAnswers(body, ['the answer after compaction rewrote it']);
  ok('compaction-era text degrades to passthrough', compacted === body);
}

console.log('\n=== The cut is the whole segment, not one message ===');
{
  // The realistic shape of a tool-using turn: tool_use, its result, then the final answer
  const body = {
    messages: [
      { role: 'user', content: 'read the file' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'the answer to drop' }] },
      { role: 'user', content: 'the next question' },
    ],
  };
  const out = trimRedoAnswers(body, ['the answer to drop']) as typeof body;
  ok('the discarded answer is gone', !out.messages.some((m) => JSON.stringify(m).includes('the answer to drop')));
  ok('the previous turn\'s tool exchange survives intact',
    out.messages.some((m) => JSON.stringify(m).includes('tool_use')) && out.messages.some((m) => JSON.stringify(m).includes('tool_result')));
  ok('the segment was removed whole',
    out.messages.length === 4 && out.messages[3]!.role === 'user',
    JSON.stringify(out.messages.map((m) => m.role)));
}

console.log('\n=== The rule is checked against every assistant message, not just the last one ===');
{
  const body = {
    messages: [
      { role: 'user', content: 'sort it' },
      { role: 'assistant', content: [{ type: 'text', text: 'first attempt' }] },
      { role: 'user', content: 'sort it' },
      { role: 'assistant', content: [{ type: 'text', text: 'second attempt' }] },
      { role: 'user', content: 'sort it' },
    ],
  };
  const out = trimRedoAnswers(body, ['second attempt', 'first attempt']) as typeof body;
  ok('both discarded answers are gone', !out.messages.some((m) => JSON.stringify(m).includes('attempt')));
  ok('only the questions remain', out.messages.length === 3 && out.messages.every((m) => m.role === 'user'));
}

console.log('\n=== The Responses wire is trimmed the same way ===');
{
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sort it' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'old answer' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'sort it again' }] },
    ],
  };
  const out = trimRedoAnswers(body, ['old answer']) as typeof body;
  ok('the old answer is gone', !out.input.some((i) => JSON.stringify(i).includes('old answer')));
  ok('the current question stays', out.input.some((i) => JSON.stringify(i).includes('sort it again')));
  ok('unmatched rules leave the Responses body alone', trimRedoAnswers(body, ['nope']) === body);
}

console.log('\n=== A body with no user after the assistant is left alone ===');
{
  const body = {
    input: [
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'do the thing' }] },
      { type: 'function_call', name: 'Bash', arguments: 'ls' },
      { type: 'function_call_output', call_id: 'c1', output: 'file.txt' },
    ],
  };
  const out = trimRedoAnswers(body, ['anything']) as typeof body;
  ok('a tool continuation is not mistaken for an answer', out === body);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * What the administrator's console is told about the shared plan.
 *
 * The failures worth catching are quiet ones: a window parsed under the wrong name shows an
 * empty card, a reset left as unix seconds prints as 1787485541, and a response that carries
 * no limit headers at all — a mock upstream, a 429 from our own gate — must not erase the
 * last real reading.
 *
 * Run: npm -w @agentlodge/server run test:upstream-allowance
 */
import { record, recordCodex, reset, snapshot } from './upstream-allowance.js';

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

/** A real capture, taken through the audit proxy against the official endpoint */
const CAPTURED: Record<string, string> = {
  'anthropic-ratelimit-unified-status': 'allowed',
  'anthropic-ratelimit-unified-5h-status': 'allowed',
  'anthropic-ratelimit-unified-5h-reset': '1787331600',
  'anthropic-ratelimit-unified-5h-utilization': '0.22',
  'anthropic-ratelimit-unified-7d-status': 'allowed',
  'anthropic-ratelimit-unified-7d-reset': '1787547600',
  'anthropic-ratelimit-unified-7d-utilization': '0.59',
  'anthropic-ratelimit-unified-representative-claim': 'five_hour',
  'anthropic-ratelimit-unified-fallback-percentage': '0.5',
  'anthropic-ratelimit-unified-reset': '1787331600',
  'anthropic-ratelimit-unified-overage-disabled-reason': 'org_level_disabled',
  'anthropic-ratelimit-unified-overage-status': 'rejected',
  'content-type': 'text/event-stream',
  'request-id': 'req_011',
};

const headers = (o: Record<string, string>): Headers => new Headers(o);

console.log('\n=== A real header set, parsed ===');
{
  reset();
  record('anthropic-official', 'anthropic', headers(CAPTURED));
  const a = snapshot()!;
  ok('it recorded something', a !== null);
  ok('the provider is named', a.provider === 'anthropic-official');
  ok('the top-level status', a.status === 'allowed');
  ok('the representative window', a.representative === 'five_hour');
  ok('the 5h window is utilization on the header scale', a.windows['5h']?.utilization === 0.22, JSON.stringify(a.windows['5h']));
  ok('the 7d window too', a.windows['7d']?.utilization === 0.59);
  ok(
    'unix seconds became a timestamp',
    a.windows['5h']?.resetsAt === new Date(1787331600_000).toISOString(),
    String(a.windows['5h']?.resetsAt),
  );
  ok('the top-level reset too', a.resetsAt === new Date(1787331600_000).toISOString());
  ok('per-window status is kept', a.windows['5h']?.status === 'allowed');
  ok('overage is a window of its own', a.windows.overage?.status === 'rejected', JSON.stringify(a.windows.overage));
}

console.log('\n=== The raw copy is complete, and only about limits ===');
{
  reset();
  record('p', 'anthropic', headers(CAPTURED));
  const raw = snapshot()!.raw;
  ok('every ratelimit header survives', Object.keys(raw).length === 12, String(Object.keys(raw).length));
  ok('including ones we do not parse', raw['anthropic-ratelimit-unified-fallback-percentage'] === '0.5');
  ok('content-type is not allowance information', raw['content-type'] === undefined);
  ok('nor is the request id', raw['request-id'] === undefined);
}

console.log('\n=== A response that says nothing keeps the last real reading ===');
{
  reset();
  record('p', 'anthropic', headers(CAPTURED));
  record('p', 'anthropic', headers({ 'content-type': 'application/json' }));
  ok('the reading survives', snapshot()?.windows['5h']?.utilization === 0.22);
}

console.log('\n=== Codex reports in the body, not in headers ===');
{
  reset();
  const rl = { primary: { used_percent: 73.4, window_minutes: 300 } };
  recordCodex('codex-sub', 'responses', rl);
  const a = snapshot()!;
  ok('it is kept as sent', JSON.stringify(a.codex) === JSON.stringify(rl));
  ok('the provider is named', a.provider === 'codex-sub');
  ok('with no header windows invented', Object.keys(a.windows).length === 0);
}
{
  reset();
  record('same', 'responses', headers(CAPTURED));
  recordCodex('same', 'responses', { primary: { used_percent: 1 } });
  ok('headers and body figures from one provider coexist', snapshot()?.windows['5h']?.utilization === 0.22 && snapshot()?.codex !== undefined);
}
{
  reset();
  recordCodex('codex-sub', 'responses', { primary: {} });
  record('anthropic-official', 'anthropic', headers(CAPTURED));
  ok(
    "another provider's body figures are not carried over",
    snapshot()?.provider === 'anthropic-official',
  );
}

console.log('\n=== Before anything has come back ===');
{
  reset();
  ok('there is nothing rather than an empty shell', snapshot() === null);
}

console.log('\n=== Junk in a header does not become a number ===');
{
  reset();
  record('p', 'anthropic', headers({
    'anthropic-ratelimit-unified-5h-utilization': 'n/a',
    'anthropic-ratelimit-unified-5h-reset': 'soon',
  }));
  ok('an unparseable utilization is null, not NaN', snapshot()?.windows['5h']?.utilization === null);
  ok('an unparseable reset is null, not Invalid Date', snapshot()?.windows['5h']?.resetsAt === null);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

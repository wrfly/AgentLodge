/**
 * What a CLI is told about its allowance.
 *
 * Every failure here is silent: a wrong scale or a missing field does not throw, it shows
 * the user a number. The cases that matter:
 *   utilization on the wrong scale     → headers clamp at 1, every request looks maxed out
 *   a window with no ceiling reported  → the client shows a limit that cannot run out
 *   rate_limits left in a Codex stream → one user sees the whole platform's consumption
 *
 * Run: npm -w @agentlodge/server run test:quota-report
 */
import type { QuotaScope, QuotaStatus, QuotaWindow } from '../core/protocol.js';
import { RateLimitScrubber, oauthUsage, stripRateLimits, unifiedHeaders } from './quota-report.js';

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

const ENDS: Record<QuotaScope, string> = {
  window: '2026-08-23T19:00:00.000Z',
  week: '2026-08-27T05:00:00.000Z',
  month: '2026-09-01T00:00:00.000Z',
};

function win(scope: QuotaScope, over: Partial<QuotaWindow> = {}): QuotaWindow {
  const limit = over.limit === undefined ? 1000 : over.limit;
  const used = over.used ?? 250;
  return {
    scope,
    limit,
    boost: 0,
    used,
    remaining: limit === null ? null : Math.max(limit - used, 0),
    ratio: limit === null || limit <= 0 ? 0 : Math.min(used / limit, 1),
    startsAt: '2026-08-23T14:00:00.000Z',
    endsAt: ENDS[scope],
    exceeded: limit !== null && used >= limit,
    ...over,
  };
}

/** A quota with everything at a sane default; each test overrides what it is about */
function q(over: Partial<Record<QuotaScope, Partial<QuotaWindow>>> = {}, top: Partial<QuotaStatus> = {}): QuotaStatus {
  const windows = {
    window: win('window', over.window),
    week: win('week', over.week),
    month: win('month', over.month),
  };
  const limited = Object.values(windows).filter((w) => w.limit !== null);
  return {
    limitKind: 'tokens',
    currency: 'CNY',
    hardStop: true,
    windows,
    exceeded: limited.some((w) => w.exceeded),
    warning: limited.some((w) => w.ratio >= 0.9),
    tightest: limited.length ? limited.reduce((a, b) => (b.ratio > a.ratio ? b : a)).scope : null,
    ...top,
  };
}

console.log('\n=== Headers: a fraction, and unix seconds ===');
{
  const h = unifiedHeaders(q({ window: { limit: 1000, used: 250 } }));
  ok('utilization is 0..1, not a percentage', h['anthropic-ratelimit-unified-5h-utilization'] === '0.2500', String(h['anthropic-ratelimit-unified-5h-utilization']));
  ok(
    'reset is the window’s end, in unix seconds',
    h['anthropic-ratelimit-unified-5h-reset'] === String(Date.parse(ENDS.window) / 1000),
    String(h['anthropic-ratelimit-unified-5h-reset']),
  );
  ok('the weekly window is reported too', h['anthropic-ratelimit-unified-7d-reset'] === String(Date.parse(ENDS.week) / 1000));
  ok('the representative is the short window', h['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  ok('the top-level reset matches it', h['anthropic-ratelimit-unified-reset'] === h['anthropic-ratelimit-unified-5h-reset']);
  ok('overage is not claimed', h['anthropic-ratelimit-unified-overage-status'] === undefined);
}

console.log('\n=== Headers: the three states ===');
{
  ok('normal is allowed', unifiedHeaders(q())['anthropic-ratelimit-unified-status'] === 'allowed');
  ok('near the limit warns', unifiedHeaders(q({ window: { used: 950 } }))['anthropic-ratelimit-unified-status'] === 'allowed_warning');
  ok('over it is rejected', unifiedHeaders(q({ window: { used: 1000 } }))['anthropic-ratelimit-unified-status'] === 'rejected');
  ok(
    'a window over its ceiling rejects even when the others are fine',
    unifiedHeaders(q({ week: { used: 5000 } }))['anthropic-ratelimit-unified-status'] === 'rejected',
  );
}

console.log('\n=== A window with no ceiling is left out, not sent as zero ===');
{
  const h = unifiedHeaders(q({ window: { limit: null } }));
  ok('the unlimited one is absent', h['anthropic-ratelimit-unified-5h-utilization'] === undefined);
  ok('the limited one still reports', h['anthropic-ratelimit-unified-7d-utilization'] === '0.2500');
  ok('and becomes the representative', h['anthropic-ratelimit-unified-representative-claim'] === 'seven_day');
}
{
  const h = unifiedHeaders(q({ window: { limit: null }, week: { limit: null }, month: { limit: null } }));
  ok('nothing limited means no headers at all', Object.keys(h).length === 0);
}

console.log('\n=== /api/oauth/usage: a percentage, and ISO 8601 ===');
{
  const u = oauthUsage(q({ window: { limit: 1000, used: 250 } }));
  ok('utilization is 0..100 here, unlike the headers', u.five_hour?.utilization === 25, String(u.five_hour?.utilization));
  ok('resets_at is the window’s end', u.five_hour?.resets_at === ENDS.window, String(u.five_hour?.resets_at));
  ok('the weekly line is the weekly window', u.seven_day?.resets_at === ENDS.week);
  ok('every key the client parses is present', 'cinder_cove' in u && 'extra_usage' in u && 'limits' in u);
  ok('no per-model windows are invented', Array.isArray(u.limits) && u.limits.length === 0);
}
{
  const u = oauthUsage(q({ window: { limit: null } }));
  ok('an unlimited window is null rather than 0%', u.five_hour === null && u.seven_day !== null);
}
{
  // The monthly ceiling has no line in this panel; it is not silently folded into one
  const u = oauthUsage(q({ window: { limit: null }, week: { limit: null }, month: { limit: 1000, used: 900 } }));
  ok('the month does not borrow another window’s line', u.five_hour === null && u.seven_day === null);
}

console.log('\n=== Codex: the shared account never reaches the client ===');
{
  const body = JSON.stringify({
    type: 'response.completed',
    rate_limits: { primary: { used_percent: 73.4, window_minutes: 300, resets_at: 1787331600 } },
    response: { id: 'resp_1' },
  });
  const out = stripRateLimits(body);
  ok('rate_limits is gone', out !== null && !out.includes('rate_limits'), String(out));
  ok('the rest of the event survives', out !== null && JSON.parse(out).response.id === 'resp_1');
}
{
  const nested = JSON.stringify({ type: 'response.completed', response: { id: 'r', rate_limits: { primary: {} } } });
  const out = stripRateLimits(nested);
  ok('the copy on the response object goes too', out !== null && !out.includes('rate_limits'), String(out));
}
ok('an event without it is left alone', stripRateLimits(JSON.stringify({ type: 'response.output_text.delta' })) === null);
ok('a non-JSON payload is left alone', stripRateLimits('[DONE]') === null);

console.log('\n=== Codex: over a stream, split wherever the network split it ===');
{
  const s = new RateLimitScrubber();
  const event = `data: ${JSON.stringify({ type: 'x', rate_limits: { primary: { used_percent: 99 } } })}\n\n`;
  const whole = `event: response.completed\n${event}data: [DONE]\n\n`;

  // One byte at a time is the worst case a chunked upstream can produce
  let out = '';
  for (const ch of whole) out += s.push(ch);
  out += s.end();

  ok('nothing is lost or duplicated', out.replace(/rate_limits.*/, '').length > 0 && out.includes('event: response.completed'));
  ok('the allowance is gone', !out.includes('rate_limits'), out);
  ok('the terminator survives', out.includes('data: [DONE]'));
  ok('blank lines are preserved, or the client sees one event', out.endsWith('\n\n'), JSON.stringify(out.slice(-4)));
}
{
  const s = new RateLimitScrubber();
  const untouched = 'event: ping\ndata: {"type":"ping"}\n\n';
  ok('a stream with nothing to remove comes out identical', s.push(untouched) + s.end() === untouched);
}
{
  const s = new RateLimitScrubber();
  const crlf = `data: ${JSON.stringify({ rate_limits: {} })}\r\n`;
  const out = s.push(crlf) + s.end();
  ok('a CRLF stream keeps its CR', out.endsWith('\r\n'), JSON.stringify(out));
}
{
  const s = new RateLimitScrubber();
  const half = `data: ${JSON.stringify({ rate_limits: { a: 1 } })}`;
  ok('a stream cut mid-line still emits what it had', (s.push(half) + s.end()).length > 0);
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

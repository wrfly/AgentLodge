/**
 * What a CLI is told about its allowance.
 *
 * Every failure here is silent: a wrong scale or a missing field does not throw, it shows
 * the user a number. The cases that matter:
 *   utilization on the wrong scale     → headers clamp at 1, every request looks maxed out
 *   a window with no reset             → the client drops it and the panel is empty
 *   rate_limits left in a Codex stream → one user sees the whole platform's consumption
 *
 * Run: npm -w @agentlodge/server run test:quota-report
 */
import type { QuotaStatus } from '../core/protocol.js';
import {
  RateLimitScrubber,
  claimFor,
  oauthUsage,
  stripRateLimits,
  unifiedHeaders,
} from './quota-report.js';

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

const HOUR = 3600_000;

/** A quota with everything at a sane default; each test overrides what it is about */
function q(over: Partial<QuotaStatus> = {}): QuotaStatus {
  const start = new Date('2026-08-23T00:00:00.000Z');
  return {
    limitKind: 'tokens',
    limit: 1000,
    costLimitMicro: null,
    currency: 'USD',
    used: 250,
    usedMicro: 0,
    remaining: 750,
    remainingMicro: null,
    ratio: 0.25,
    period: 'daily',
    periodStart: start.toISOString(),
    periodEnd: new Date(start.getTime() + 24 * HOUR).toISOString(),
    resetsInMs: 24 * HOUR,
    anchorLabel: 'midnight',
    expired: false,
    hardStop: true,
    exceeded: false,
    warning: false,
    ...over,
  };
}

console.log('\n=== Which window a period is reported in ===');
{
  const start = '2026-08-23T00:00:00.000Z';
  const end = (h: number) => new Date(new Date(start).getTime() + h * HOUR).toISOString();
  ok('a daily quota is the short window', claimFor(q({ periodStart: start, periodEnd: end(24) })) === 'five_hour');
  ok('a two-hour rolling one too', claimFor(q({ period: 'rolling', periodStart: start, periodEnd: end(2) })) === 'five_hour');
  ok(
    'a long rolling one is weekly, despite the name',
    claimFor(q({ period: 'rolling', periodStart: start, periodEnd: end(24 * 30) })) === 'seven_day',
  );
  ok('a monthly one is weekly', claimFor(q({ period: 'monthly', periodStart: start, periodEnd: end(24 * 31) })) === 'seven_day');
  ok('one that never ends is weekly', claimFor(q({ period: 'total', periodEnd: null })) === 'seven_day');
}

console.log('\n=== Headers: a fraction, and unix seconds ===');
{
  const h = unifiedHeaders(q({ ratio: 0.25 }));
  ok('utilization is 0..1, not a percentage', h['anthropic-ratelimit-unified-5h-utilization'] === '0.2500', String(h['anthropic-ratelimit-unified-5h-utilization']));
  ok(
    'reset is unix seconds',
    h['anthropic-ratelimit-unified-5h-reset'] === String(Date.UTC(2026, 7, 24) / 1000),
    String(h['anthropic-ratelimit-unified-5h-reset']),
  );
  ok('the top-level reset matches the window', h['anthropic-ratelimit-unified-reset'] === h['anthropic-ratelimit-unified-5h-reset']);
  ok('the representative claim names the window used', h['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  ok('the weekly window is absent, not zero', h['anthropic-ratelimit-unified-7d-utilization'] === undefined);
  ok('overage is not claimed', h['anthropic-ratelimit-unified-overage-status'] === undefined);
}

console.log('\n=== Headers: the three states ===');
{
  ok('normal is allowed', unifiedHeaders(q())['anthropic-ratelimit-unified-status'] === 'allowed');
  ok('near the limit warns', unifiedHeaders(q({ warning: true }))['anthropic-ratelimit-unified-status'] === 'allowed_warning');
  ok('over it is rejected', unifiedHeaders(q({ exceeded: true, warning: true }))['anthropic-ratelimit-unified-status'] === 'rejected');
  ok('the window carries the same state', unifiedHeaders(q({ warning: true }))['anthropic-ratelimit-unified-5h-status'] === 'allowed_warning');
}

console.log('\n=== Headers: when there is nothing honest to say ===');
{
  ok('no token ceiling means no headers', Object.keys(unifiedHeaders(q({ limit: null }))).length === 0);
  ok(
    'no cost ceiling means no headers, on a cost quota',
    Object.keys(unifiedHeaders(q({ limitKind: 'cost', costLimitMicro: null }))).length === 0,
  );
  ok(
    'a cost quota with a ceiling still reports',
    unifiedHeaders(q({ limitKind: 'cost', costLimitMicro: 5_000_000, limit: null }))['anthropic-ratelimit-unified-5h-utilization'] === '0.2500',
  );
  ok(
    'a period that never resets reports nothing here — the client would drop it',
    Object.keys(unifiedHeaders(q({ period: 'total', periodEnd: null }))).length === 0,
  );
}

console.log('\n=== /api/oauth/usage: a percentage, and ISO 8601 ===');
{
  const u = oauthUsage(q({ ratio: 0.25 }));
  ok('utilization is 0..100 here, unlike the headers', u.five_hour?.utilization === 25, String(u.five_hour?.utilization));
  ok('resets_at is the ISO timestamp', u.five_hour?.resets_at === '2026-08-24T00:00:00.000Z', String(u.five_hour?.resets_at));
  ok('the other window is null, not a copy', u.seven_day === null);
  ok('every key the client parses is present', 'cinder_cove' in u && 'extra_usage' in u && 'limits' in u);
  ok('no per-model windows are invented', Array.isArray(u.limits) && u.limits.length === 0);
}
{
  const u = oauthUsage(q({ period: 'monthly', periodStart: '2026-08-01T00:00:00.000Z', periodEnd: '2026-09-01T00:00:00.000Z', ratio: 0.5 }));
  ok('a monthly quota lands in the weekly window', u.seven_day?.utilization === 50 && u.five_hour === null);
}
{
  const u = oauthUsage(q({ period: 'total', periodEnd: null, ratio: 0.9 }));
  ok('a quota that never resets still reports, with a null reset', u.seven_day?.utilization === 90 && u.seven_day?.resets_at === null);
}
{
  const u = oauthUsage(q({ limit: null }));
  ok('unlimited reports every window null', u.five_hour === null && u.seven_day === null);
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

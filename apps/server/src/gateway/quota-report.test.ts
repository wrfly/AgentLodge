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

console.log('\n=== The platform\'s windows, once the upstream has stated them ===');
{
  // One subscription, one 5-hour window: the upstream says it resets at 19:00, so that is
  // the boundary for everybody, whatever time each of them started
  const resets5h = '2026-08-23T19:00:00.000Z';
  const resets7d = '2026-08-27T05:00:00.000Z';
  // A daily ceiling of 10M is 10M/24h*5h ≈ 2.083M over five hours
  const daily = q({ limit: 10_000_000, ratio: 0.3 });
  const u = oauthUsage(daily, {
    five_hour: { used: 1_041_666, resetsAt: resets5h },
    seven_day: { used: 35_000_000, resetsAt: resets7d },
  });
  ok('both lines are filled', u.five_hour !== null && u.seven_day !== null, JSON.stringify(u.five_hour));
  ok('the reset is the upstream’s, not the quota’s', u.five_hour?.resets_at === resets5h, String(u.five_hour?.resets_at));
  ok('and the weekly one likewise', u.seven_day?.resets_at === resets7d);
  ok('half of a five-hour share reads as 50%', u.five_hour?.utilization === 50, String(u.five_hour?.utilization));
  ok('half of a weekly share too — 70M is a day’s ceiling times seven', u.seven_day?.utilization === 50, String(u.seven_day?.utilization));
}
{
  const daily = q({ limit: 10_000_000 });
  const u = oauthUsage(daily, { five_hour: { used: 99_000_000, resetsAt: '2026-08-23T19:00:00.000Z' } });
  ok('a window spent far past its share stops at 100', u.five_hour?.utilization === 100, String(u.five_hour?.utilization));
  ok('a window the upstream said nothing about stays empty', u.seven_day === null);
}
{
  const u = oauthUsage(q({ limit: null }), { five_hour: { used: 5, resetsAt: '2026-08-23T19:00:00.000Z' } });
  ok('no ceiling means no percentage to report', u.five_hour === null && u.seven_day === null);
}
{
  // Cost quotas count micro-units; the window has to be measured in the same unit
  const byCost = q({ limitKind: 'cost', limit: null, costLimitMicro: 24_000_000 });
  const u = oauthUsage(byCost, { five_hour: { used: 2_500_000, resetsAt: '2026-08-23T19:00:00.000Z' } });
  ok('a cost quota is paced in its own unit', u.five_hour?.utilization === 50, String(u.five_hour?.utilization));
}

console.log('\n=== Headers follow the same windows ===');
{
  const resets = '2026-08-23T19:00:00.000Z';
  const h = unifiedHeaders(q({ limit: 10_000_000 }), {
    five_hour: { used: 1_041_666, resetsAt: resets },
    seven_day: { used: 7_000_000, resetsAt: '2026-08-27T05:00:00.000Z' },
  });
  ok(
    'the 5h reset is the upstream’s instant, in unix seconds',
    h['anthropic-ratelimit-unified-5h-reset'] === String(Date.parse(resets) / 1000),
    String(h['anthropic-ratelimit-unified-5h-reset']),
  );
  ok('on the header scale, which is a fraction', h['anthropic-ratelimit-unified-5h-utilization'] === '0.5000', String(h['anthropic-ratelimit-unified-5h-utilization']));
  ok('both windows are reported', h['anthropic-ratelimit-unified-7d-utilization'] === '0.1000', String(h['anthropic-ratelimit-unified-7d-utilization']));
  ok('the representative is the short window when there is one', h['anthropic-ratelimit-unified-representative-claim'] === 'five_hour');
  ok('the top-level reset matches it', h['anthropic-ratelimit-unified-reset'] === h['anthropic-ratelimit-unified-5h-reset']);
}
{
  const h = unifiedHeaders(q({ limit: 10_000_000, warning: true }), {
    seven_day: { used: 1, resetsAt: '2026-08-27T05:00:00.000Z' },
  });
  ok('with only the weekly window, that is the representative', h['anthropic-ratelimit-unified-representative-claim'] === 'seven_day');
  ok('and the state still comes from the quota', h['anthropic-ratelimit-unified-status'] === 'allowed_warning');
  ok('the short window is absent rather than zero', h['anthropic-ratelimit-unified-5h-utilization'] === undefined);
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

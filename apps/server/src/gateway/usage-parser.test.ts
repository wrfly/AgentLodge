/**
 * Usage that is not a flat token counter must still reach billing.
 *
 * Run: npm -w @agentlodge/server run test:usage-parser
 */
import { strict as assert } from 'node:assert';
import { costOf, type Pricing } from '../core/db/pricing.js';
import { absorbEvent, newUsageAcc } from './usage-parser.js';

const metered = newUsageAcc();
absorbEvent('anthropic', JSON.stringify({
  type: 'message_start',
  message: {
    usage: {
      input_tokens: 10,
      cache_creation: {
        ephemeral_5m_input_tokens: 4,
        ephemeral_1h_input_tokens: 6,
      },
    },
  },
}), metered);
absorbEvent('anthropic', JSON.stringify({
  type: 'message_delta',
  usage: {
    output_tokens: 3,
    server_tool_use: { web_search_requests: 2 },
  },
}), metered);

assert.equal(metered.cacheCreationTokens, 10);
assert.equal(metered.webSearchRequests, 2);

const priced = {
  priceInput: 1_000_000,
  priceCacheRead: 0,
  priceCacheWrite: 0,
  priceOutput: 0,
  priceWebSearch: 10_000_000,
} as Pricing;
assert.equal(costOf(priced, {
  inputTokens: 1,
  cacheReadTokens: 0,
  cacheCreationTokens: 0,
  outputTokens: 0,
  webSearchRequests: 2,
}), 20_001);

console.log('✓ nested cache and server-tool usage');

/**
 * Whose address a request is recorded under, through every proxy shape this is deployed in.
 *
 * This suite exists because the setting has now been wrong twice, and neither time did
 * anything break. It reads the same either way — a number in a list, an address in an audit
 * row — so the only signal is somebody noticing that every visitor appears to live at
 * 172.24.0.1, and both times that took an afternoon.
 *
 *   the first time   TRUST_PROXY was read by the server and forwarded by neither compose
 *                    file, so setting it did nothing
 *   the second time  caddy discarded the upstream X-Forwarded-For before app ever saw it
 *   the third time   fastify 5.12.4 made a numeric trustProxy trust nothing at all, which
 *                    would have put it back exactly where it started
 *
 * The third was caught by this file failing, which is the whole point: a value is asserted
 * against a **built Fastify instance**, not against our own parser. A future upgrade that
 * changes what fastify does with the value goes red here rather than in production.
 *
 * Run: npm -w @agentlodge/server run test:trust-proxy
 */
import Fastify from 'fastify';
import { DEFAULT_TRUST_PROXY, TrustProxyError, trustProxyOption } from './trust-proxy.js';

let pass = 0;
let fail = 0;
const ok = (what: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${what}`);
  } else {
    fail++;
    console.log(`  ✗ ${what}${detail ? `   ${detail}` : ''}`);
  }
};

/** What req.ip comes out as, for a given trust list, socket peer and forwarded chain */
async function seenIp(trust: string, remoteAddress: string, forwardedFor?: string) {
  const app = Fastify({ logger: false, trustProxy: trustProxyOption(trust) });
  app.get('/ip', async (req) => ({ ip: req.ip }));
  const res = await app.inject({
    method: 'GET',
    url: '/ip',
    remoteAddress,
    headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {},
  });
  await app.close();
  return (res.json() as { ip: string }).ip;
}

const CLIENT = '203.0.113.9';
/** A public address standing in for a CDN edge — public is the point, not which CDN */
const EDGE = '198.51.100.7';
/** app's own peer: caddy, on the compose network */
const CADDY = '172.20.0.5';
/** what a container sees when the host connects to a published port */
const BRIDGE = '172.24.0.1';

console.log('\n── Parsing ──');
{
  ok('unset means the private ranges', trustProxyOption('') === DEFAULT_TRUST_PROXY);
  ok('unset and undefined agree', trustProxyOption(undefined) === DEFAULT_TRUST_PROXY);
  ok('a list is passed through', trustProxyOption(' loopback,10.0.0.0/8 ') === 'loopback,10.0.0.0/8');

  let refused: unknown;
  try {
    trustProxyOption('3');
  } catch (e) {
    refused = e;
  }
  ok('a hop count is refused, not converted', refused instanceof TrustProxyError);
  // The message is the whole value of refusing: it has to say what to write instead
  ok(
    'and the refusal names the replacement',
    String((refused as Error)?.message ?? '').includes(DEFAULT_TRUST_PROXY),
  );
}

console.log('\n── The shapes this is deployed in ──');
{
  const d = DEFAULT_TRUST_PROXY;

  // caddy → app, which is the stack as it ships
  ok('one private hop yields the client', (await seenIp(d, CADDY, CLIENT)) === CLIENT);

  // your own nginx on the host → caddy → app. Both hops are private, so both are trusted
  // without naming either.
  ok(
    'two private hops still yield the client',
    (await seenIp(d, CADDY, `${CLIENT}, ${BRIDGE}`)) === CLIENT,
  );

  // A CDN's edge is a public address, so the default does not reach past it. Asserted
  // rather than lamented: this is the documented limitation, and a deployment that gets a
  // Cloudflare address instead of a visitor's is looking at exactly this.
  ok(
    'a CDN that has not been named stops the walk at its edge',
    (await seenIp(d, CADDY, `${CLIENT}, ${EDGE}, ${BRIDGE}`)) === EDGE,
  );

  // ...and naming it is what fixes that
  ok(
    'naming the CDN range reaches the client again',
    (await seenIp(`${d},198.51.100.0/24`, CADDY, `${CLIENT}, ${EDGE}, ${BRIDGE}`)) === CLIENT,
  );
}

console.log('\n── What a client cannot do ──');
{
  const d = DEFAULT_TRUST_PROXY;

  // Reaching the process directly from a public address, claiming to be somebody else.
  // The peer is not a trusted proxy, so nothing it forwarded counts.
  ok(
    'a direct client cannot forge its address',
    (await seenIp(d, EDGE, '1.2.3.4')) === EDGE,
  );

  // A correctly configured proxy appends the peer it saw, so a client's own forged entry
  // ends up to the *left* of the real one and the walk stops before reaching it.
  ok(
    'a forged entry in front of a real one is walked past',
    (await seenIp(d, CADDY, `1.2.3.4, ${CLIENT}, ${BRIDGE}`)) === CLIENT,
  );

  // The limit of the whole scheme, asserted rather than assumed: trusting a range means
  // trusting every machine in it. A host inside the private network that forwards a header
  // nobody appended to is believed, because by naming the range we said it could be a
  // proxy. The answer is a narrower list, not a cleverer walk — which is the argument for
  // naming addresses over counting hops in the first place.
  ok(
    'but anything inside the trusted range is taken at its word',
    (await seenIp(d, CADDY, `1.2.3.4, ${BRIDGE}`)) === '1.2.3.4',
  );
}

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

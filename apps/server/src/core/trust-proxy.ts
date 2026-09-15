/**
 * Which machines in front of this process are allowed to speak for the client's address.
 *
 * This was a **hop count** until fastify 5.12.4, and the upgrade is what forced the change:
 * a numeric `trustProxy` now trusts *nothing*, and `req.ip` silently falls back to the
 * socket peer. Fastify's reasoning is sound and worth repeating here, because it is why
 * this file does not simply paper the change over —
 *
 *   a hop count cannot check **who** the nearest peer is. A client reaching the process
 *   directly can therefore claim any address it likes, by sending enough X-Forwarded-For
 *   entries of its own that the count lands on one it wrote.
 *
 * So the question changes from "how many proxies" to "which ones", and the answer is a
 * list of addresses and CIDR ranges — plus the three names @fastify/proxy-addr understands:
 *
 *   loopback      127.0.0.1/8, ::1/128
 *   linklocal     169.254.0.0/16, fe80::/10
 *   uniquelocal   10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, fc00::/7
 *
 * The default covers the stack as it ships and one layer beyond it: caddy reaches app over
 * the compose network, and a reverse proxy of your own on the host arrives from the bridge
 * — both private. **A CDN does not.** Cloudflare's edge is a public address, so a
 * deployment behind one has to name its ranges here or read the CDN's address instead of
 * the visitor's. That list is the same one such a deployment already keeps for its own
 * nginx, and Cloudflare publishes it at https://www.cloudflare.com/ips/.
 *
 * The address is then resolved from the right of X-Forwarded-For inwards, stopping at the
 * first entry no trusted proxy vouches for — the direction a client cannot write into.
 */

/** What an unset TRUST_PROXY means: this machine, and anything on a private network */
export const DEFAULT_TRUST_PROXY = 'loopback,uniquelocal';

export class TrustProxyError extends Error {}

/**
 * Parse TRUST_PROXY into the form fastify takes.
 *
 * A number is **refused rather than converted**. There is no conversion: "the two nearest
 * proxies" does not name an address, and guessing one would be the same class of mistake
 * this setting exists to prevent. Refusing at startup is also the only way an operator
 * finds out — the failure it replaces is a login list that quietly reads 172.24.0.1 for
 * every visitor, which took an afternoon to track down the once it happened.
 */
export function trustProxyOption(raw = process.env.TRUST_PROXY): string {
  const value = (raw ?? '').trim();
  if (!value) return DEFAULT_TRUST_PROXY;

  if (/^\d+$/.test(value)) {
    throw new TrustProxyError(
      `TRUST_PROXY=${value} is a hop count, and hop counts no longer work: since fastify `
        + '5.12.4 a numeric value trusts nothing at all, so every request would be attributed '
        + 'to the proxy in front of this process.\n'
        + `Name the proxies instead. For the stack as it ships: TRUST_PROXY=${DEFAULT_TRUST_PROXY}\n`
        + 'Behind a CDN, add its ranges — e.g. TRUST_PROXY='
        + `${DEFAULT_TRUST_PROXY},173.245.48.0/20,103.21.244.0/22,... (cloudflare.com/ips)`,
    );
  }

  return value;
}

import type { FastifyRequest } from 'fastify';
import { pickLocale, t as translate, type Locale } from './index.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Resolved once per request from Accept-Language; English when nothing matches */
    locale: Locale;
  }
}

/**
 * Resolve the locale once per request and translate against it.
 *
 * A getter on the request rather than a hook so it costs nothing on the many requests that
 * never produce a message — parsing Accept-Language for every static asset would be waste.
 * The value is memoised per request, since a handler that fails usually produces one
 * message and sometimes several.
 */
export function installLocale(req: FastifyRequest): void {
  let cached: Locale | undefined;
  Object.defineProperty(req, 'locale', {
    configurable: true,
    get(): Locale {
      cached ??= pickLocale(req.headers['accept-language']);
      return cached;
    },
  });
}

/** Translate for this request. The one call error sites make. */
export function tr(
  req: FastifyRequest,
  source: string,
  vars?: Record<string, string | number>,
): string {
  return translate(req.locale, source, vars);
}

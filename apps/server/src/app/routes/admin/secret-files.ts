/**
 * Browsing key files, which is what the console's read-from-a-file field uses.
 *
 * It returns status only — size, time, fingerprint, mask — and **never the contents**. The
 * contents are read by the gateway at the moment of a request and never pass through a
 * browser, which is part of why this feature exists at all.
 *
 * The status is **asked of the gateway** too, rather than stat'ed by app: the app container
 * probably does not mount that volume, so what it sees has no bearing on whether the key
 * works. See shared.ts.
 */
import type { FastifyInstance } from 'fastify';
import { guard, secretFilesView } from './shared.js';

export function register(app: FastifyInstance): void {

  /**
   * With no parameters: what is in the allowlisted directories, for the dropdown.
   * With `?path=`: that one path is also checked, for live feedback while typing.
   *
   * Both carry roots and files, because when a typed path is rejected the interface should be
   * able to say which directories are readable and what is in them — otherwise all it has is
   * "not in an allowed directory".
   */
  app.get('/api/admin/secret-files', guard, async (req) => {
    const { path } = (req.query ?? {}) as { path?: string };
    // The status comes from the gateway (see secretFilesView in shared.ts); what app itself
    // sees does not count
    return secretFilesView(path, req.headers.authorization);
  });
}

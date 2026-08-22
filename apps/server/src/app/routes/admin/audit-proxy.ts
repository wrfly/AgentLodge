/**
 * The audit proxy's configuration panel.
 *
 * There are **two kinds** of configuration here, from different sources. Do not mix them:
 *
 *   1. the enable switch   our own `egress.useAuditProxy` setting, off by default, in our
 *                          database. It has to be changeable while the proxy is unreachable
 *                          or not even deployed — that is exactly when turning it off
 *                          matters, and requiring the proxy to be up in order to disable it
 *                          is a deadlock.
 *   2. the proxy's own     allowlist, dynamic routing, retention — owned by **the proxy**
 *                          and persisted in its own volume. This is a forwarding layer with
 *                          authentication and an audit log, nothing more.
 *
 * Why the second is not kept in our database: the proxy enforces, we are only a client.
 * The other way round there would be a window between the proxy restarting and us pushing
 * configuration down, during which it runs on its environment defaults — possibly looser
 * than what the administrator set. An audit component should not have such a window.
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import { config } from '../../../core/config.js';
import { setSetting } from '../../../core/db/settings.js';
import {
  auditProxyBase,
  auditProxyEnabled,
  fetchAuditConfig,
  patchAuditConfig,
} from '../../../core/egress.js';
import { guard } from './shared.js';
import { tr } from '../../../core/i18n/locale.js';

/** Everything the panel needs. enabled always has a value, since it does not depend on the proxy being up. */
async function status(req: FastifyRequest) {
  const enabled = auditProxyEnabled();
  const base = auditProxyBase();
  if (!base) {
    return {
      enabled,
      configured: false,
      reason: tr(req, 'No global audit proxy is configured (AUDIT_PROXY_URL)'),
    };
  }
  if (!config.auditAdminToken) {
    return {
      enabled,
      configured: true,
      url: base,
      editable: false,
      reason: tr(req, 'The proxy\'s control API is not enabled (AUDIT_ADMIN_TOKEN is unset); only environment variables can change it'),
    };
  }
  try {
    return { enabled, configured: true, url: base, editable: true, config: await fetchAuditConfig() };
  } catch (err) {
    return {
      enabled,
      configured: true,
      url: base,
      editable: false,
      reason: tr(req, 'Cannot reach the audit proxy: {reason}', {
        reason: err instanceof Error ? err.message : String(err),
      }),
    };
  }
}

export function register(app: FastifyInstance): void {
  app.get('/api/admin/audit-proxy', guard, async (req) => status(req));

  app.patch('/api/admin/audit-proxy', guard, async (req, reply) => {
    const body = { ...((req.body ?? {}) as Record<string, unknown>) };

    // The enable switch is our own setting and is not forwarded to the proxy (see 1 above)
    if ('enabled' in body) {
      const on = body.enabled === true || body.enabled === 'true';
      setSetting('egress.useAuditProxy', on ? 'true' : 'false', req.user!.id);
      // Turning it off means direct egress with no record. That has to leave a trace, and
      // the action name has to show the direction at a glance rather than hiding it in detail.
      audit.log({
        actorId: req.user!.id,
        action: on ? 'admin.egress.audit-on' : 'admin.egress.audit-off',
        targetType: 'audit-proxy',
        detail: { enabled: on },
        ip: req.ip,
      });
      delete body.enabled;
    }

    // Only the switch was touched, so stop here — the proxy need not be up
    if (Object.keys(body).length === 0) return status(req);

    if (!auditProxyBase() || !config.auditAdminToken) {
      return reply.code(400).send({ error: tr(req, 'The audit proxy\'s control API is not enabled') });
    }
    try {
      await patchAuditConfig(body);
      // An allowlist change decides where data can go, so it has to leave a trace
      audit.log({
        actorId: req.user!.id,
        action: 'admin.audit-proxy.update',
        targetType: 'audit-proxy',
        detail: body,
        ip: req.ip,
      });
      return status(req);
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

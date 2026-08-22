/**
 * The console's entry point for egress traces.
 *
 * The audit proxy owns the data; this is **a forwarding layer with administrator
 * authentication**, the same pattern as the configuration panel in audit-proxy.ts.
 *
 * Why not let the browser talk to the proxy's own UI: that UI needs authentication of its
 * own — loopback or a token — which would mean either exposing the proxy on the frontend
 * network or planting the proxy's token in the browser. `/api/admin/*` already has
 * administrator authentication, so this route changes neither the network topology nor
 * where server secrets live.
 */
import type { FastifyInstance } from 'fastify';
import * as audit from '../../../core/db/audit.js';
import { config } from '../../../core/config.js';
import {
  auditProxyBase,
  clearAuditTraces,
  fetchAuditTrace,
  fetchAuditTraces,
} from '../../../core/egress.js';
import { guard } from './shared.js';

/** One way of saying the proxy is not set up. Not "0 records", which reads as "no traffic". */
function unavailable(): { available: false; reason: string } | null {
  if (!auditProxyBase()) {
    return { available: false, reason: 'No audit proxy is configured (AUDIT_PROXY_URL)' };
  }
  if (!config.auditAdminToken) {
    return { available: false, reason: 'The proxy\'s control API is not enabled (AUDIT_ADMIN_TOKEN is unset)' };
  }
  return null;
}

export function register(app: FastifyInstance): void {
  app.get('/api/admin/traces', guard, async () => {
    const off = unavailable();
    if (off) return { ...off, rows: [] };
    try {
      const { traceDir, rows } = await fetchAuditTraces();
      // Newest first: what people look at is almost always the one that just happened
      return { available: true, traceDir, rows: [...rows].reverse() };
    } catch (err) {
      return {
        available: false,
        rows: [],
        reason: `Cannot reach the audit proxy: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  });

  app.get('/api/admin/traces/:id', guard, async (req, reply) => {
    const off = unavailable();
    if (off) return reply.code(400).send({ error: off.reason });
    const { id } = req.params as { id: string };
    try {
      return await fetchAuditTrace(Number(id));
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Clear everything. Irreversible, and what it deletes is the record that everything
   * outbound was recorded — so the action goes into **our** audit_logs first, which live
   * somewhere other than the data being deleted, and only then does the proxy act.
   */
  app.delete('/api/admin/traces', guard, async (req, reply) => {
    const off = unavailable();
    if (off) return reply.code(400).send({ error: off.reason });
    try {
      const result = await clearAuditTraces();
      audit.log({
        actorId: req.user!.id,
        action: 'admin.traces.clear',
        targetType: 'audit-proxy',
        detail: { removed: result.removed, remaining: result.remaining, freedMb: result.freedMb },
        ip: req.ip,
      });
      return result;
    } catch (err) {
      return reply.code(502).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });
}

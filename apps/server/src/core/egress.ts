import { config } from './config.js';
import { getBoolFresh } from './db/settings.js';

/**
 * Egress policy: which upstreams have to go through the audit proxy first.
 *
 * It lives in core because both layers need the same test:
 *   gateway  blocks before sending — the real enforcement point
 *   app      blocks when the console switches upstream, so the failure is not a 503 the
 *            next time a user sends a message
 * Let the two tests drift apart and the console says "you may switch" while the gateway
 * says "you may not send", which is the hardest kind of thing to debug.
 */

/**
 * Whether egress goes through the audit proxy. **Off by default**; an administrator turns
 * it on in the console.
 *
 * Off, the gateway connects to the upstream directly: no proxy, and **no x-forwarded-***.
 * Those two headers exist for the proxy's routing, and sending them on a direct
 * connection just tells the real upstream there is a reverse proxy in front that is not
 * there.
 *
 * On, it fails closed: with no AUDIT_PROXY_URL configured, egress is refused rather than
 * silently going direct.
 *
 * Read without the cache: app and gateway are separate processes with separate settings
 * caches (see getBoolFresh).
 */
export function auditProxyEnabled(): boolean {
  return getBoolFresh('egress.useAuditProxy');
}

/** A loopback upstream: the traffic never left this machine, so there is nothing to audit */
export function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

/** Kinds that never reach the network: the mock builds responses inside the gateway process, the local agent runs as a child process */
const OFFLINE_KINDS = new Set(['mock', 'local-agent']);

/**
 * Whether this upstream needs the audit proxy.
 *
 * Three exemptions: enforcement is off, the kind never reaches the network, or the
 * address is loopback. Everything else needs it — the guarantee being made is "everything
 * that went out was recorded", and one hole that allows a silent direct connection is
 * enough to void it.
 */
export function requiresAuditProxy(kind: string, baseUrl: string): boolean {
  // Audit proxy off means this upstream does not need it and goes direct; see auditProxyEnabled()
  if (!auditProxyEnabled()) return false;
  if (OFFLINE_KINDS.has(kind)) return false;
  return !isLoopback(baseUrl);
}

/** Is it configured? undefined means yes; anything else is a reason for a person to read. */
export function auditProxyProblem(p: { kind: string; baseUrl: string }): string | undefined {
  if (config.auditProxyUrl) return undefined;
  if (!requiresAuditProxy(p.kind, p.baseUrl)) return undefined;
  return 'An upstream that reaches the network has to go through the audit proxy, but the '
    + 'server has no AUDIT_PROXY_URL configured. The audit proxy is part of this project — '
    + 'the `audit` service in docker/compose.yml — so ask whoever runs the deployment.';
}

/* ---------------- The proxy's control API ---------------- */

/**
 * Where the audit proxy is. **There is exactly one** — it is part of this project, not a
 * per-upstream component. The gateway tells it where to relay each request with
 * x-forwarded-host, so one instance serves every upstream.
 */
export function auditProxyBase(): string {
  return config.auditProxyUrl;
}

export interface AuditProxyConfig {
  allow: string[];
  dynamicUpstream: boolean;
  maxCount: number;
  maxBytes: number;
  maxAgeMs: number;
  locked: { retry: number; maxConcurrent: number };
  stats: { traceCount: number; traceBytes: number; traceDir: string };
  pinnedUpstream: string | null;
  uiEnabled: boolean;
  /** Where its UI is mounted, empty when off. The console builds links and a cookie Path from it. */
  uiPrefix?: string;
}

async function call(method: 'GET' | 'PATCH', body?: unknown): Promise<AuditProxyConfig> {
  const url = new URL('/__admin/config', auditProxyBase()).toString();
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${config.auditAdminToken}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      /* Not JSON: use it verbatim */
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as AuditProxyConfig;
}

/** One line of index.jsonl. The proxy decides the fields; only the ones the console uses are declared here. */
export interface TraceRow {
  id: number;
  time: string;
  method: string;
  path: string;
  status: number;
  model?: string | null;
  stream?: boolean;
  duration_ms?: number;
  request_bytes?: number;
  response_bytes?: number;
  upstream?: string;
  stop_reason?: string | null;
  usage?: Record<string, unknown> | null;
  rewritten?: string[] | null;
  dir?: string;
}

/** The listing. The proxy owns the data and we only relay it — no caching, so the console cannot show something the proxy does not have. */
export async function fetchAuditTraces(): Promise<{ traceDir: string; rows: TraceRow[] }> {
  return callTraces('GET', '');
}

/** One record in full: request headers and body, SSE event by event, the reconstruction, usage */
export async function fetchAuditTrace(id: number): Promise<Record<string, unknown>> {
  return callTraces('GET', `/${id}`);
}

async function callTraces<T>(method: 'GET' | 'DELETE', suffix: string): Promise<T> {
  const url = new URL(`/__admin/traces${suffix}`, auditProxyBase()).toString();
  const res = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${config.auditAdminToken}` },
    // The listing can be tens of thousands of lines and deleting can be slow; allow for it
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) {
    let msg = text.slice(0, 300);
    try {
      msg = (JSON.parse(text) as { error?: string }).error ?? msg;
    } catch {
      /* Not JSON: use it verbatim */
    }
    throw new Error(msg);
  }
  return JSON.parse(text) as T;
}

export interface ClearResult {
  removed: number;
  /** What could not be removed — in use, say — and stays in the index */
  remaining: number;
  freedMb: number;
  config: AuditProxyConfig;
}

/** Clear every trace the proxy has written. Its runtime configuration and sticky device_id are untouched. */
export async function clearAuditTraces(): Promise<ClearResult> {
  const body = await callTraces<{
    removed: number;
    remaining: number;
    freed_mb: number;
    config: AuditProxyConfig;
  }>('DELETE', '');
  return { removed: body.removed, remaining: body.remaining, freedMb: body.freed_mb, config: body.config };
}

export const fetchAuditConfig = (): Promise<AuditProxyConfig> => call('GET');
export const patchAuditConfig = (patch: unknown): Promise<AuditProxyConfig> => call('PATCH', patch);

/**
 * Would the proxy refuse this host?
 *
 * This closes a real gap: the console's checks used to ask only whether a proxy was
 * configured, never whether the proxy would accept the host. So switching upstream
 * succeeded and the user got a 403 on their next message — a 403 that looks like an
 * upstream fault. undefined means no problem, including when the proxy cannot be reached
 * (see the caller).
 */
export async function allowlistProblem(baseUrl: string): Promise<string | undefined> {
  // With the proxy off the traffic never touches it, so the allowlist takes no part
  if (!auditProxyEnabled()) return undefined;
  if (!auditProxyBase() || !config.auditAdminToken) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    return undefined; // the URL itself is invalid; let another check report that
  }
  let cfg: AuditProxyConfig;
  try {
    cfg = await fetchAuditConfig();
  } catch {
    return undefined; // if the proxy cannot be asked, do not block configuration — the gate at send time still stands
  }
  if (cfg.pinnedUpstream) return undefined; // this instance pins its upstream; the allowlist takes no part
  if (!cfg.allow.length) return undefined; // empty means no restriction
  if (cfg.allow.includes(host)) return undefined;
  return `The audit proxy will not relay to ${host}. Add it to the allowlist under "Audit `
    + `proxy" first. Currently allowed: ${cfg.allow.join(', ')}`;
}

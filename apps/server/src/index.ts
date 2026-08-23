import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { config } from './core/config.js';
import { initDb } from './core/db/index.js';
import { importLegacy } from './core/db/import-legacy.js';
import * as pricing from './core/db/pricing.js';
import * as providersRepo from './core/db/providers.js';
import * as usersRepo from './core/db/users.js';
import * as invitesRepo from './core/db/invites.js';
import * as sessionsRepo from './core/db/sessions.js';
import { listAgents } from './app/agents/registry.js';
import { attachUser, requireUser } from './core/auth/guard.js';
import { installLocale } from './core/i18n/locale.js';
import { registerAuthRoutes } from './app/routes/auth.js';
import { registerAdminRoutes } from './app/routes/admin/index.js';
import { registerMeRoutes } from './app/routes/me.js';
import { registerCliRoutes } from './app/routes/cli.js';
import { registerConversationRoutes } from './app/routes/conversations.js';
import { MAX_UPLOAD_BYTES } from './app/workspace.js';
import { buildGateway, gate, startModelAutoRefresh } from './gateway/index.js';
import { gatewayEnabled } from './app/agents/provider.js';
import * as containers from './app/containers.js';

/**
 * How many reverse-proxy hops to trust. A number is a hop count; an IP or CIDR string
 * works too (proxy-addr's syntax). 0 trusts nobody and falls back to the socket peer.
 */
function trustProxyOption(): number | string {
  const raw = process.env.TRUST_PROXY ?? '1';
  const n = Number(raw);
  return Number.isFinite(n) ? n : raw;
}

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'warn' },
  bodyLimit: 2 * 1024 * 1024, // memory content can run long
  /*
   * Required behind a reverse proxy. Without it req.ip is the Caddy container's address and
   * **every request looks like it came from one place**. That costs two things:
   *   audit         audit_logs.ip and the IPs in the session list are all the same value,
   *                 so nothing can be traced back
   *   availability  auth.ts buckets brute-force attempts by `ip:${req.ip}`, and one shared
   *                 bucket means five wrong passwords from anyone locks the whole site out
   *                 for fifteen minutes. Worse, once locked, isLocked blocks before the
   *                 password is checked, so even a correct login cannot clear the counter —
   *                 there is nothing to do but wait it out.
   *
   * The value is **a hop count**, not `true`: Caddy's reverse_proxy **appends** to
   * X-Forwarded-For rather than replacing it, so `true` — trust the whole chain — takes the
   * leftmost entry, which the client wrote, handing the IP to an attacker to forge. `1`
   * takes the entry Caddy appended, which is the peer it actually saw. Add a CDN in front
   * and it becomes 2.
   *
   * Connected directly (npm run dev, no proxy) there is no XFF header and the socket peer is
   * used, which is unaffected.
   */
  trustProxy: trustProxyOption(),
});

/**
 * Which origins may make credentialed cross-origin requests.
 *
 * This used to be `origin: true`, which echoes back whatever Origin the caller sent and
 * pairs it with Access-Control-Allow-Credentials — in other words, any website at all. It
 * was not exploitable as it stood: the refresh cookie is SameSite=Lax and so never rides a
 * cross-site fetch, and the access token lives in memory in the user's own tab. But it is a
 * layer of defence given away for nothing, and it would turn into a real hole the day
 * somebody sets SameSite=None to put the frontend on another domain.
 *
 * Nothing needs it, either. In production Caddy serves the interface and the API from one
 * origin, so no CORS is involved; in development Vite proxies /api, so the browser only ever
 * talks to :5173 and no CORS is involved there either. A request with no Origin header at
 * all — curl, a CLI, server-to-server — is not a browser making a cross-origin request and
 * is left alone.
 *
 * CORS_ORIGINS adds more, comma-separated, for anyone who really does serve the interface
 * from somewhere else.
 */
function allowedOrigins(): Set<string> {
  const out = new Set<string>();
  const add = (u?: string): void => {
    if (!u) return;
    try {
      out.add(new URL(u).origin);
    } catch {
      /* Not a URL; nothing to allow */
    }
  };
  add(process.env.APP_BASE_URL);
  add(process.env.PUBLIC_GATEWAY_URL);
  for (const u of (process.env.CORS_ORIGINS ?? '').split(',')) add(u.trim());
  return out;
}

const CORS_ALLOW = allowedOrigins();
const CORS_DEV = process.env.NODE_ENV !== 'production';

await app.register(cors, {
  credentials: true,
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (CORS_ALLOW.has(origin)) return cb(null, true);
    // Development conveniences only: a second local port is a colleague running Vite, not
    // an attacker, and this never applies once NODE_ENV says production
    if (CORS_DEV && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin))
      return cb(null, true);
    cb(null, false);
  },
});
await app.register(cookie);
await app.register(multipart, {
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 10 },
});

/*
 * HOST_DATA_DIR has to be absolute: it appears verbatim in
 * `podman run -v <here>:/workspace` and is resolved by podman on the host. A relative path
 * resolves somewhere else, which shows up as `statfs ...: no such file or directory` when
 * creating a container — or worse, mounts an empty directory, so the agent cannot see its
 * own files and nothing reports an error.
 */
if (config.hostDataDir && !path.isAbsolute(config.hostDataDir)) {
  console.error(`\n  HOST_DATA_DIR has to be an absolute path; it is currently "${config.hostDataDir}"\n`);
  process.exit(1);
}

initDb();
importLegacy();
pricing.seedDefaults();
providersRepo.seedFromSettings();
// Move the model list from global settings onto the provider (idempotent; the old rows are
// deleted afterwards)
providersRepo.migrateModelSettings();

/** A fresh deployment: mint a bootstrap administrator invite code and print it */
function bootstrapInvite(): void {
  if (usersRepo.count() > 0) return;
  const unused = invitesRepo.list().some((i) => !i.disabled && i.usedCount < i.maxUses);
  if (unused) return;
  const invite = invitesRepo.create({ note: 'bootstrap admin', maxUses: 1, presetRole: 'admin' });
  console.log(`\n  ╭─────────────────────────────────────────────╮`);
  console.log(`  │  First administrator invite code             │`);
  console.log(`  │  ${invite.code.padEnd(43)}│`);
  console.log(`  ╰─────────────────────────────────────────────╯\n`);
}
if (config.role !== 'gateway') bootstrapInvite();

// Every request has its identity resolved first; whether that is required is each route's
// preHandler to decide
// Resolve the request locale before anything can produce a message. It is a lazy getter,
// so a request that never fails never parses Accept-Language.
app.addHook('onRequest', async (req) => installLocale(req));

app.addHook('preHandler', attachUser);

registerAuthRoutes(app);
registerConversationRoutes(app);
registerMeRoutes(app);
registerAdminRoutes(app);
registerCliRoutes(app);

app.get('/api/health', async () => ({
  ok: true,
  permissionMode: config.permissionMode,
  codexSandbox: config.codexSandbox,
  jwtSecretPersistent: config.jwtSecretFromEnv,
}));

/**
 * Claude Code's probe before it starts. The gateway answers the same path: with a user's
 * ANTHROPIC_BASE_URL pointed here, the reverse proxy may send this to either side, so both
 * have to answer it.
 */
app.route({ method: ['HEAD', 'GET'], url: '/api/hello', handler: async () => ({ ok: true }) });

/** The agents, models and effort levels available here */
app.get('/api/agents', { preHandler: requireUser }, async () => listAgents());

// Only on the main service: the gateway container shares the same database, so running it
// twice is waste — and the gateway has no podman socket, so reclaiming containers is not
// its job either
if (config.role !== 'gateway') {
  setInterval(() => void sessionsRepo.pruneExpired(), 3600_000).unref();
  setInterval(() => void containers.reapIdle(), 5 * 60_000).unref();
}

// The gateway is a Fastify app of its own that happens to share this process by default,
// which is one process fewer in development. ROLE=app / ROLE=gateway runs half of it, which
// is how a compose deployment splits them into two containers — only then can the gateway
// sit on the internal network and the agent side have no route out at all.
const runsApp = config.role !== 'gateway';
const runsGateway = config.role !== 'app';

if (runsGateway) {
  const gateway = buildGateway();
  await gateway.listen({ port: config.gatewayPort, host: config.gatewayHost });
  // Here rather than on the app side: the key that authorises the question is in this process
  startModelAutoRefresh((message) => console.log(`  ${message}`));
}
if (runsApp) {
  await app.listen({ port: config.port, host: config.host });
}

console.log(
  `\n  AgentLodge server  ` +
    (runsApp ? `http://${config.host}:${config.port}` : '— (ROLE=gateway; the main service is elsewhere)'),
);
console.log(
  `  metering gateway ` +
    (runsGateway
      ? `http://${config.gatewayHost}:${config.gatewayPort}` +
        `  concurrency limit ${config.maxUpstreamConcurrency}` +
        (gatewayEnabled() ? '' : '  ⚠️ no upstream provider is active; agents are not going through the gateway')
      : '— (ROLE=app; the gateway is in another container)'),
);
console.log(`  data:            ${config.dataDir}`);
console.log(`  users ${usersRepo.count()} · invite codes ${invitesRepo.list().length}`);
if (!config.jwtSecretFromEnv) {
  console.log(`  ⚠️  JWT_SECRET is unset; a random key is in use for this run`);
  console.log(`      What that costs: encrypted settings (upstream and SendGrid keys) cannot`);
  console.log(`      be decrypted and have to be entered again, and streaming requests in`);
  console.log(`      flight break at restart. Sessions are unaffected — a refresh token is a`);
  console.log(`      random string in the database, not a JWT, and resumes by itself.`);
}
const containerProbe = await containers.probe();
console.log(
  `  container isolation ${containers.enabled() ? (containerProbe.ok ? '✓ ' : '✗ ') : '— '}${containerProbe.detail}`,
);
for (const a of await listAgents()) {
  const mark = a.availability.available ? '✓' : '✗';
  const detail = a.availability.available
    ? (a.availability.version ?? '')
    : (a.availability.reason ?? '');
  console.log(`  agent ${mark} ${a.id.padEnd(7)} ${detail}`);
}
console.log('');

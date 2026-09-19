import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import { config } from './core/config.js';
import { initDb } from './core/db/index.js';
import { importLegacy } from './core/db/import-legacy.js';
import * as pricing from './core/db/pricing.js';
import * as usageRepo from './core/db/usage.js';
import * as providersRepo from './core/db/providers.js';
import * as modelsRepo from './core/db/models.js';
import * as usersRepo from './core/db/users.js';
import * as invitesRepo from './core/db/invites.js';
import * as sessionsRepo from './core/db/sessions.js';
import * as audit from './core/db/audit.js';
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
import { drainLegacyProviderKeys } from './gateway/legacy-keys.js';
import { gatewayEnabled } from './app/agents/provider.js';
import * as containers from './app/containers.js';
import * as deferred from './app/deferred.js';
import { legacySendgrid } from './app/mail.js';
import { getString } from './core/db/settings.js';
import { trustProxyOption } from './core/trust-proxy.js';

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
   * **Not `true`**, which trusts the whole chain and so takes the leftmost X-Forwarded-For
   * entry — the one the client wrote. Which proxies are named, and why it is no longer a
   * hop count, is in core/trust-proxy.ts.
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
/*
 * One-off database repairs, and one process does them.
 *
 * `app` and `gateway` are two processes over one SQLite file and they start together, so both
 * used to arrive here at once. The first took the write lock for as long as the recost ran —
 * twenty-one thousand rows on the deployment this was written for — the second exceeded
 * `busy_timeout` and threw, and that killed it. Compose restarted it, it raced again, and
 * repeated ten times until the first finished. The service came up correct and the log looked
 * like a disaster.
 *
 * The same gate the rest of this file's housekeeping already uses, and for the same stated
 * reason: the gateway shares the database, so running it there is waste. Waste is what made
 * the loser wait in the first place — so this removes the contention rather than tolerating
 * it, and a lock from anywhere else still fails loudly the way every other startup write does.
 */
if (config.role !== 'gateway') {
  pricing.seedDefaults();
  /*
   * After the seed, and in this order: `repriceHistory` costs every stored row from the price
   * table, so the table has to be complete first — recosting against a table still missing its
   * Claude rows would write the catch-all price in and then mark the job done.
   */
  usageRepo.repriceHistory();
  /*
   * Inside the gate for the same reason, and it was outside it by oversight rather than by
   * design: it is two inserts behind a "is the table empty" read, which on a fresh deployment
   * both processes pass at once — the same race, two lines further down.
   */
  providersRepo.seedFromSettings();
  const collapsed = modelsRepo.collapseVariantRows();
  if (collapsed) {
    console.log(`[models] ${collapsed} effort/thinking variant row(s) collapsed to the model they belong to`);
  }
}
// Move the model list from global settings onto the provider (idempotent; the old rows are
// deleted afterwards)

/** A fresh deployment: mint the invite code the first account, the administrator, registers with */
function bootstrapInvite(): void {
  if (usersRepo.count() > 0) return;
  const unused = invitesRepo.list().some((i) => !i.disabled && i.usedCount < i.maxUses);
  if (unused) return;
  const invite = invitesRepo.create({ note: 'bootstrap admin', maxUses: 1 });
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
  setInterval(() => void audit.prune(config.auditLogRetentionDays), 3600_000).unref();
  setInterval(() => void containers.reapIdle(), 5 * 60_000).unref();
  // Questions that arrived over the ceiling and are waiting for the window to turn over.
  // Here for the same reason as the others: one process owns it, and it is the one that
  // can start a turn.
  deferred.startSweeping();
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
  // Here rather than on the app side: the credential that authorises the question is
  // reachable from this process and from no other
  startModelAutoRefresh((message) => console.log(`  ${message}`));
  await drainLegacyProviderKeys((message) => console.log(`  ${message}`));
}
if (runsApp) {
  await app.listen({ port: config.port, host: config.host });
}

/** The zone this process actually resolved, and what it is offset by right now */
function clock(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const minutes = -new Date().getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
  return `${zone} (UTC${offset})${process.env.TZ ? '' : ' — TZ is unset'}`;
}

console.log(
  `\n  AgentLodge server  ` +
    (runsApp ? `http://${config.host}:${config.port}` : '— (ROLE=gateway; the main service is elsewhere)'),
);
console.log(
  `  metering gateway ` +
    (runsGateway
      ? `http://${config.gatewayHost}:${config.gatewayPort}` +
        // From the gate, not from the environment variable: the limit is a stored setting
        // and the variable is only its fallback, so printing the variable would announce a
        // number the gate is not running at on every deployment that has ever changed it
        `  concurrency limit ${gate.max()}${gate.pinned() ? ' (pinned)' : ''}` +
        (gatewayEnabled() ? '' : '  ⚠️ no model is configured; conversations will be refused until one is')
      : '— (ROLE=app; the gateway is in another container)'),
);
console.log(`  data:            ${config.dataDir}`);
// Printed because it is otherwise invisible and decides where a day ends: usage rows are
// bucketed by it, and so are the quota windows. An unset TZ in a container is UTC, which is
// nobody's working day.
console.log(`  clock:           ${clock()}`);
console.log(`  users ${usersRepo.count()} · invite codes ${invitesRepo.list().length}`);
if (!config.jwtSecretFromEnv) {
  console.log(`  ⚠️  JWT_SECRET is unset; a random key is in use for this run`);
  console.log(`      What that costs: encrypted settings (upstream and mail keys) cannot`);
  console.log(`      be decrypted and have to be entered again, and streaming requests in`);
  console.log(`      flight break at restart. Sessions are unaffected — a refresh token is a`);
  console.log(`      random string in the database, not a JWT, and resumes by itself.`);
}
if (legacySendgrid() && !getString('mail.apiKey')) {
  // Loud at boot rather than at the first invite: an upgrade that quietly stops sending
  // mail is found by a user who never got their password-reset link.
  console.log(`  ⚠️  A SendGrid key is configured, and SendGrid is no longer a backend`);
  console.log(`      Mail is not being sent. Set MAIL_PROVIDER and MAIL_API_KEY (resend or`);
  console.log(`      brevo), or MAIL_PROVIDER=smtp with the SMTP settings, in the console`);
  console.log(`      under Settings → Email. The old key is left where it is, unused.`);
}
const containerProbe = await containers.probe();
console.log(
  `  container isolation ${containers.enabled() ? (containerProbe.ok ? '✓ ' : '✗ ') : '— '}${containerProbe.detail}`,
);

/*
 * Whether this machine can hold the containers it is configured to create.
 *
 * The limit is per container and the containers are per user, so the number that matters
 * is the product — and nothing in the configuration mentions the machine, so an allowance
 * that is fine on paper and impossible in practice looks exactly like one that is fine.
 * What it costs is not an error either: the kernel picks a process and kills it, and what
 * gets killed is whatever was biggest at that moment, which is as likely to be the
 * application as the agent that asked for the memory.
 *
 * Two is the smallest interesting number — one person working alone is not a deployment —
 * and the services themselves need roughly 512 MB on top.
 */
if (runsApp && containers.enabled()) {
  const totalMb = Math.round(os.totalmem() / 1024 / 1024);
  const needed = config.containerMemoryMb * 2 + 512;
  if (totalMb < needed) {
    console.log(
      `  ⚠️  ${totalMb} MB of memory, and two concurrent agents would ask for ${needed} MB`,
    );
    console.log(
      `      CONTAINER_MEMORY_MB is ${config.containerMemoryMb}. Two people mid-turn at once`,
    );
    console.log('      is enough to have the kernel kill something — and what it kills may');
    console.log(`      be this process. Lower it to about ${Math.floor((totalMb - 512) / 2)}, or give the machine more.`);
  }
}
// What the engine still has from before this process started: containers to track, and
// turns that were running when the previous process went away
if (runsApp && containerProbe.ok) {
  const found = await containers.reconcile();
  if (found.running || found.strays) {
    console.log(`  containers          ${found.running} running from before this start, ${found.strays} stray turn(s) ended`);
  }
}
for (const a of await listAgents()) {
  const mark = a.availability.available ? '✓' : '✗';
  const detail = a.availability.available
    ? (a.availability.version ?? '')
    : (a.availability.reason ?? '');
  console.log(`  agent ${mark} ${a.id.padEnd(7)} ${detail}`);
}
console.log('');

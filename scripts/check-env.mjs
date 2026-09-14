/**
 * Every setting the server reads is either forwarded by compose, or written down here as
 * deliberately not.
 *
 * The failure this exists for leaves no trace at all. `TRUST_PROXY` was read by
 * `core/trust-proxy.ts`, documented in the manual, and absent from both compose files — so
 * an operator who set it in `.env` changed nothing. What that looked like from outside was
 * a signed-in-devices list where every visitor lived at 172.24.0.1, and the way it was
 * eventually found was an afternoon of reading proxy configuration. Nothing logged, nothing
 * failed, and the setting appeared in every place somebody would think to check.
 *
 * `check-compose.mjs` could not have caught it: that one compares the two compose files
 * against *each other*, and they agreed — both were missing it. The missing comparison is
 * against the code.
 *
 * The rule, then: a name read through `process.env` in `apps/server/src` has to appear in
 * both compose files, or in EXEMPT below with a reason. Adding an environment variable
 * therefore forces a decision rather than allowing an accident — which is the whole of what
 * this is for. The list being long is not a problem; a name arriving in neither is.
 *
 * Run: node scripts/check-env.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const COMPOSE = ['docker/compose.yml', 'docker/compose.release.yml'];
/** The engine overlay sets a few of its own; forwarded there counts as forwarded */
const OVERLAY = 'docker/compose.docker.yml';

/**
 * Names that are meant not to be in compose, and why. A reason is required: the point of
 * the list is that somebody decided, and the next person can see what they decided.
 */
const EXEMPT = new Map([
  ['PATH', 'the process environment, not a setting'],
  ['NODE_ENV', 'the process environment, not a setting'],
  ['PORT', 'the app listens on a fixed port inside its container; compose maps it'],

  // Test fixtures. Real ones would be a container that cannot start; these make one
  // pretend to, so the suites can exercise the paths that handle it.
  ['FAKE_STATUS', 'container test fixture'],
  ['FAKE_PS', 'container test fixture'],
  ['FAKE_START_ERR', 'container test fixture'],
  ['FAKE_ENGINE_ERR', 'container test fixture'],
  ['TRACE_REQUESTS', 'developer switch, noisy by design; not a deployment setting'],
  ['PODMAN_LOG', 'developer switch: logs every engine invocation'],

  // Configured in the console instead, where the value is validated, audited and can be
  // changed without a restart. The environment fallback is for a first start before
  // anybody has signed in — forwarding it too would give one setting two homes.
  ['APP_BASE_URL', 'console setting with an env fallback (settings.ts)'],
  ['ENABLED_AGENTS', 'console setting with an env fallback (settings.ts)'],
  ['MAIL_PROVIDER', 'console setting with an env fallback (settings.ts)'],
  ['MAIL_API_KEY', 'console setting with an env fallback (settings.ts)'],
  ['SENDGRID_API_KEY', 'read only to migrate a pre-console deployment (app/mail.ts)'],

  // The upstream lives in the providers table. These are read once, on first start, to
  // turn a pre-provider deployment into a row — see providers.ts.
  ['DEEPSEEK_API_KEY', 'legacy, migrated into upstream_providers on first start'],
  ['DEEPSEEK_BASE_URL', 'legacy, migrated into upstream_providers on first start'],
  ['MODEL', 'legacy default model; the provider row carries it now'],
  ['CLAUDE_MODELS', 'fallback model list; the provider row carries it now'],
  ['CODEX_MODELS', 'fallback model list; the provider row carries it now'],

  // Inside the agent image, not in app's environment: app passes them to the container
  // it creates rather than reading its own.
  ['CLAUDE_BIN', 'resolved inside the agent container'],
  ['CODEX_BIN', 'resolved inside the agent container'],
  ['CODEX_SANDBOX', 'passed to the agent container by containers.ts'],
  ['PERMISSION_MODE', 'passed to the agent container by containers.ts'],

  // Internal tuning with no deployment-shaped reason to change it. Forwarding these would
  // put two more knobs on a page an operator reads to find the one they need.
  ['EVENT_BUFFER_SIZE', 'how many events a reconnecting SSE client can replay; internal'],
  ['POOL_SHARE_CACHE_MS', 'how long a pool-share reading is reused; internal'],
]);

/* ---- what the server reads ---- */
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

const src = walk(path.join(root, 'apps/server/src'))
  .map((f) => fs.readFileSync(f, 'utf8'))
  .join('\n');

const read_by_server = new Set(
  [...src.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]),
);

// A parser that matched nothing would pass while checking nothing
if (read_by_server.size < 20) {
  console.error(
    `✗ check-env found only ${read_by_server.size} environment reads in apps/server/src, which `
      + 'cannot be right — the scan needs updating. Failing rather than reporting success on '
      + 'nothing.',
  );
  process.exit(1);
}

/* ---- what compose forwards ---- */
const forwarded = COMPOSE.map((f) => {
  const text = read(f);
  return new Set([...text.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));
});
const overlay = new Set([...read(OVERLAY).matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((m) => m[1]));

const problems = [];
for (const name of [...read_by_server].sort()) {
  if (EXEMPT.has(name)) continue;
  const missing = COMPOSE.filter((f, i) => !forwarded[i].has(name) && !overlay.has(name));
  if (missing.length) {
    problems.push(
      `${name} is read by the server and forwarded by ${missing.length === COMPOSE.length ? 'neither compose file' : `not ${missing.join(' or ')}`}\n`
        + '    → add it to the environment block, or to EXEMPT in this file with a reason',
    );
  }
}

/* ---- and the reverse: an exemption for a name nobody reads any more ---- */
for (const [name] of EXEMPT) {
  if (!read_by_server.has(name)) {
    problems.push(`${name} is exempted here but the server no longer reads it — drop the entry`);
  }
}

if (problems.length) {
  console.error(`✗ environment variables\n\n${problems.map((p) => `  ${p}`).join('\n\n')}\n`);
  process.exit(1);
}

console.log(
  `✓ env OK — ${read_by_server.size} read by the server, `
    + `${read_by_server.size - EXEMPT.size} forwarded by both compose files, `
    + `${EXEMPT.size} exempt with a reason`,
);

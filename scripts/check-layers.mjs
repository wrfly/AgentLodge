/**
 * Structural checks that a type checker cannot make: layer boundaries, the one file that has
 * to exist twice, and the guard on every administrative route.
 *
 *   core     usable by both: config, protocol, data access, auth, quota
 *   app      the main service only: routes, turn orchestration, containers, CLI adapters
 *   gateway  the metering gateway only: the gate, translation, tickets, usage parsing
 *
 * The rule is short: **core depends on nobody, and app and gateway do not depend on each
 * other.**
 *
 * Why a machine checks it: today both layers run in one process (ROLE=all), so a careless
 * import works fine and nothing complains. The bill arrives when the two are split into
 * separate containers, and it arrives as "it works in dev, and something is quietly
 * missing in production" — the worst kind to track down. The cross-layer import in
 * `events.ts` got in exactly that way.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'apps/server/src',
);

/** layer -> the layers it may depend on */
const ALLOW = {
  core: new Set(['core']),
  app: new Set(['core', 'app']),
  gateway: new Set(['core', 'gateway']),
  // index.ts is the assembly point: it imports from both sides, so it is unrestricted
  '': new Set(['core', 'app', 'gateway', '']),
};

const layerOf = (rel) => (rel.includes('/') ? rel.split('/')[0] : '');

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return walk(p);
    return e.name.endsWith('.ts') ? [p] : [];
  });
}

const violations = [];
for (const abs of walk(SRC)) {
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  const from = layerOf(rel);
  const allowed = ALLOW[from] ?? ALLOW[''];

  for (const m of fs.readFileSync(abs, 'utf8').matchAll(/from '(\.[^']+)'/g)) {
    const targetRel = path
      .relative(SRC, path.resolve(path.dirname(abs), m[1]))
      .split(path.sep)
      .join('/');
    const to = layerOf(targetRel);
    if (!allowed.has(to)) {
      violations.push(`  ${rel}\n      → ${targetRel}   (${from || 'root'} must not depend on ${to})`);
    }
  }
}

if (violations.length) {
  console.error(`✗ ${violations.length} layer violation(s):\n${violations.join('\n')}`);
  process.exit(1);
}

/*
 * protocol.ts exists twice, byte for byte, because a workspace package was not worth the
 * build configuration early on. Nothing enforced that until the two drifted — AGENT_IDS
 * was added on the server side alone and the copies stopped matching. Cheap to check, and
 * the failure it prevents is a type that means one thing on each side of the wire.
 */
const TWINS = ['apps/server/src/core/protocol.ts', 'apps/web/src/lib/protocol.ts'];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [a, b] = TWINS.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
if (a !== b) {
  console.error(
    `✗ the two copies of protocol.ts have drifted:\n    ${TWINS.join('\n    ')}\n`
      + '  They must stay identical — copy one over the other.',
  );
  process.exit(1);
}

/*
 * Every /api/admin/ route needs its guard.
 *
 * The guard is an argument on each individual route — `app.get(path, guard, handler)` — not a
 * prefix or a plugin scope, so leaving it off is a single missing word that changes nothing
 * visible: the route works, and it works for everybody. There is no failing test to write for
 * a route nobody thought to protect, which is exactly why a machine should count them.
 */
const ROUTE_RE = /app\.(get|post|patch|put|delete)\(\s*(['"`])([^'"`]*?)\2\s*,?\s*([^\n]*)/g;
const unguarded = [];
let adminRoutes = 0;
for (const abs of walk(SRC)) {
  const src = fs.readFileSync(abs, 'utf8');
  const rel = path.relative(SRC, abs).split(path.sep).join('/');
  for (const m of src.matchAll(ROUTE_RE)) {
    const [, verb, , url, rest] = m;
    if (!url.includes('/api/admin/')) continue;
    adminRoutes++;
    if (!/\bguard\b|\brequireAdmin\b|\badminOnly\b/.test(rest)) {
      const line = src.slice(0, m.index).split('\n').length;
      unguarded.push(`  ${rel}:${line}  ${verb.toUpperCase()} ${url}`);
    }
  }
}
if (unguarded.length) {
  console.error(
    `✗ ${unguarded.length} admin route(s) with no guard:\n${unguarded.join('\n')}\n`
      + '  Add the module\'s `guard` as the second argument.',
  );
  process.exit(1);
}

console.log(
  '✓ layers OK (core ← app / gateway, neither side depends on the other); '
    + `protocol.ts copies match; ${adminRoutes} admin routes all guarded`,
);

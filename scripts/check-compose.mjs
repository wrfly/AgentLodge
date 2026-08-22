/**
 * Keep the two compose files from drifting apart.
 *
 * docker/compose.yml builds from source; docker/compose.release.yml runs published images
 * and is self-contained, so somebody deploying downloads one file rather than cloning. Two
 * files describing one stack drift, and the way they drift is silent: a setting added to the
 * one you were testing with, and missing from the one everybody actually deploys. It surfaces
 * as a feature that "does not work in production" with nothing in the logs to say why.
 *
 * The rule is one-directional. Every service in compose.yml has to exist in the release file,
 * and every environment key it sets has to be set there too. Extras in the release file are
 * fine — it folds in the Docker-engine settings that compose.docker.yml overlays separately.
 *
 * The parser is deliberately narrow: these two files, whose shape we control, rather than a
 * YAML dependency for one check. Narrow parsers fail by finding nothing, which would make
 * this pass while checking nothing at all, so it asserts it found a plausible amount first.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** service -> Set of environment keys */
function parse(file) {
  const services = new Map();
  let inServices = false;
  let service = null;
  let inEnv = false;

  for (const line of fs.readFileSync(path.join(root, file), 'utf8').split('\n')) {
    if (/^[a-z]/.test(line)) {
      inServices = line.startsWith('services:');
      service = null;
      inEnv = false;
      continue;
    }
    if (!inServices) continue;

    const svc = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
    if (svc) {
      service = svc[1];
      services.set(service, new Set());
      inEnv = false;
      continue;
    }
    if (!service) continue;

    if (/^ {4}environment:\s*$/.test(line)) {
      inEnv = true;
      continue;
    }
    // Any other key at the service's own level ends the environment block
    if (/^ {4}\S/.test(line)) inEnv = false;

    if (inEnv) {
      const kv = line.match(/^ {6}([A-Z_][A-Z0-9_]*):/);
      if (kv) services.get(service).add(kv[1]);
    }
  }
  return services;
}

const dev = parse('docker/compose.yml');
const rel = parse('docker/compose.release.yml');

const problems = [];

// The parser going stale would otherwise look exactly like everything being fine
const devEnvCount = [...dev.values()].reduce((n, s) => n + s.size, 0);
if (dev.size < 4 || devEnvCount < 20) {
  console.error(
    `✗ check-compose parsed only ${dev.size} services and ${devEnvCount} environment keys `
      + 'out of docker/compose.yml, which cannot be right — the file\'s shape changed and this '
      + 'parser needs updating. Failing rather than reporting success on nothing.',
  );
  process.exit(1);
}

for (const [name, envs] of dev) {
  if (!rel.has(name)) {
    problems.push(`  service '${name}' is in compose.yml and not in compose.release.yml`);
    continue;
  }
  const missing = [...envs].filter((k) => !rel.get(name).has(k));
  if (missing.length) {
    problems.push(`  service '${name}' is missing: ${missing.join(', ')}`);
  }
}

if (problems.length) {
  console.error(
    `✗ docker/compose.release.yml has drifted from docker/compose.yml:\n${problems.join('\n')}\n`
      + '  Anything added to one stack has to reach the other, or it works in the build you '
      + 'test and not in the images people deploy.',
  );
  process.exit(1);
}

console.log(
  `✓ compose files agree (${dev.size} services, ${devEnvCount} environment keys checked)`,
);

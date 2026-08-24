/**
 * Run every test suite.
 *
 * The suites are discovered from package.json rather than listed here, because a list has to
 * be remembered: a new suite that nobody adds to it simply never runs, and a suite that
 * never runs is worse than no suite — it reads as coverage while testing nothing.
 *
 * Each is a standalone tsx program that exits non-zero on failure; there is no test runner
 * to configure and nothing to install.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Workspaces that carry their own `test:*` scripts */
const PACKAGES = [
  { dir: 'apps/server', label: 'server' },
  { dir: 'credential-proxy', label: 'credential-proxy' },
];

/**
 * Suites that are not npm scripts. Discovery only finds package.json, and the credential
 * manager is a Go module — so its tests would never run here, which for the one service
 * holding every upstream credential is exactly the "reads as coverage while testing
 * nothing" case this file exists to avoid.
 *
 * Skipped, loudly, when there is no Go toolchain: this repo builds it in a container, so
 * not having one locally is normal and should not read as a failure.
 */
const FOREIGN = [
  { dir: 'credential-manager', label: 'credential-manager', cmd: 'go', args: ['test', './...'] },
];

const suites = [];
for (const pkg of PACKAGES) {
  const file = path.join(root, pkg.dir, 'package.json');
  if (!fs.existsSync(file)) continue;
  const scripts = JSON.parse(fs.readFileSync(file, 'utf8')).scripts ?? {};
  // `test:*` and a plain `test` alike — credential-proxy has one suite and calls it `test`,
  // and picking only the prefixed form silently skipped it
  const names = Object.keys(scripts)
    .filter((s) => s === 'test' || s.startsWith('test:'))
    .sort();
  for (const name of names) suites.push({ ...pkg, script: name });
}

for (const suite of FOREIGN) {
  if (!fs.existsSync(path.join(root, suite.dir))) continue;
  suites.push(suite);
}

if (!suites.length) {
  console.error('✗ no test:* scripts found — did a package.json move?');
  process.exit(1);
}

const results = [];
for (const s of suites) {
  const label = !s.script ? s.label : s.script === 'test' ? s.label : `${s.label}/${s.script.slice(5)}`;
  const [cmd, args] = s.cmd ? [s.cmd, s.args] : ['npm', ['--silent', 'run', s.script]];
  let out = '';
  let ok = true;
  try {
    out = execFileSync(cmd, args, {
      cwd: path.join(root, s.dir),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    // A missing toolchain is not a failing suite; say which one was skipped and move on
    if (s.cmd && e.code === 'ENOENT') {
      console.log(`- ${label.padEnd(28)} skipped: no \`${s.cmd}\` on this machine`);
      continue;
    }
    ok = false;
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  // Every npm suite ends with a line saying how many passed and failed; show that line
  // alone. `go test` has no such line, so fall back to its last one ("ok <pkg> 0.03s")
  const lines = out.trim().split('\n').filter((l) => l.trim());
  const tail = lines.filter((l) => /passed/.test(l)).pop() ?? lines.pop() ?? '(no summary line)';
  results.push({ label, ok, tail, out });
  console.log(`${ok ? '✓' : '✗'} ${label.padEnd(28)} ${tail.replace(/^[✓✗]\s*/, '')}`);
  if (!ok) console.log(out.split('\n').filter((l) => l.includes('✗')).map((l) => `      ${l.trim()}`).join('\n'));
}

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${failed.length === 0 ? '✓' : '✗'} ${results.length - failed.length}/${results.length} suites passed`,
);
process.exit(failed.length === 0 ? 0 : 1);

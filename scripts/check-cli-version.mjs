/**
 * Keep the gateway's floor version equal to the Claude Code the agent image installs.
 *
 * `CLI_VERSION` in apps/server/src/gateway/upstream.ts is what our own upstream calls claim
 * to be before any real client has been seen — see gateway/cli-version.ts for why that number
 * is load-bearing rather than cosmetic. What makes it *true* rather than merely plausible is
 * that the agent image runs exactly that version, so the claim matches a client this
 * deployment is certain to have.
 *
 * That is a second copy of `ARG CLAUDE_VERSION` in docker/agent.Dockerfile, and second copies
 * drift. This one drifts silently: bumping the image and forgetting the constant leaves the
 * gateway claiming a version nobody runs, which the upstream answers by refusing models that
 * every client in the deployment can otherwise use.
 *
 * The ARG is the original. `latest` is a legitimate value there — an image built to track
 * upstream has no number to compare against — so the check stands down rather than guesses.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const DOCKERFILE = 'docker/agent.Dockerfile';
const UPSTREAM = 'apps/server/src/gateway/upstream.ts';

const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const arg = read(DOCKERFILE).match(/^ARG CLAUDE_VERSION=(\S+)/m)?.[1];
const constant = read(UPSTREAM).match(/^export const CLI_VERSION = '([^']+)'/m)?.[1];

/*
 * A narrow regex fails by finding nothing, which would make this pass while checking nothing.
 * Say so instead — one of the two files has been renamed or rewritten.
 */
if (!arg) {
  console.error(`✗ ${DOCKERFILE} has no 'ARG CLAUDE_VERSION=' line for check-cli-version to read`);
  process.exit(1);
}
if (!constant) {
  console.error(`✗ ${UPSTREAM} has no top-level 'export const CLI_VERSION' for check-cli-version to read`);
  process.exit(1);
}

if (arg === 'latest') {
  console.log(`✓ ${DOCKERFILE} tracks latest, so there is no number to pin CLI_VERSION to (${constant})`);
  process.exit(0);
}

if (arg !== constant) {
  console.error(
    `✗ CLI_VERSION has drifted from the agent image:\n`
      + `    ${DOCKERFILE}  ARG CLAUDE_VERSION=${arg}\n`
      + `    ${UPSTREAM}  CLI_VERSION = '${constant}'\n`
      + '  The gateway claims to be a Claude Code that this deployment does not run. Set the\n'
      + '  constant to the ARG — the image is the original, and the constant is the copy.',
  );
  process.exit(1);
}

console.log(`✓ CLI_VERSION matches the agent image (${arg})`);

import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { initDb } from '../core/db/index.js';
import * as usersRepo from '../core/db/users.js';
import * as sessionsRepo from '../core/db/sessions.js';
import * as audit from '../core/db/audit.js';
import { hashPassword } from '../core/auth/crypto.js';

/**
 * Setting a password from the machine the deployment runs on.
 *
 * For the case the web application cannot answer by itself: the only administrator has
 * forgotten their password and no mail is configured, so the reset link that would normally
 * fix it has nowhere to go. Without this the only way back in is editing the database by
 * hand, which is how a password ends up stored in some shape the application does not
 * expect.
 *
 * There is no authentication here and there does not need to be: reaching this command
 * means already holding the data directory, and anyone who does can do far worse than
 * change a password. What matters is that it is **not reachable over HTTP** — it is a
 * separate entry point, not a route.
 *
 *   docker exec agentlodge-app-1 node apps/server/dist/cli/reset-password.js
 *   docker exec agentlodge-app-1 node apps/server/dist/cli/reset-password.js you@example.com
 *   npm -w @agentlodge/server run reset-password -- you@example.com 'a new one'
 */

const MIN_LENGTH = 8;

/** However this was started, so the usage line can be pasted rather than translated */
const invocation = `node ${path.relative(process.cwd(), process.argv[1] ?? '') || 'reset-password.js'}`;

/** Readable when typed by hand, and still 62 bits */
function suggest(): string {
  const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(12), (b) => alphabet[b % alphabet.length]).join('');
}

function listUsers(): void {
  const users = usersRepo.list();
  if (users.length === 0) {
    console.log('\n  No accounts yet. The first one is created with the invite code the server prints at startup.\n');
    return;
  }
  console.log('\n  Accounts\n');
  for (const u of users) {
    const flags = [u.role, u.status === 'active' ? null : u.status].filter(Boolean).join(' · ');
    console.log(`    ${u.email.padEnd(32)} ${u.username.padEnd(18)} ${flags}`);
  }
  console.log('\n  Give one of those addresses to set its password:\n');
  console.log(`    ${invocation} <email> [password]\n`);
}

export function run(argv: string[]): number {
  const args = argv.filter((a) => a !== '--');
  const activate = args.includes('--activate');
  const [email, given] = args.filter((a) => !a.startsWith('--'));

  initDb();

  if (!email) {
    listUsers();
    return 0;
  }

  const user = usersRepo.findByEmail(email);
  if (!user) {
    console.error(`\n  No account with the address ${email}.\n`);
    listUsers();
    return 1;
  }

  const password = given ?? suggest();
  if (password.length < MIN_LENGTH) {
    console.error(`\n  A password has to be at least ${MIN_LENGTH} characters.\n`);
    return 1;
  }

  usersRepo.setPassword(user.id, hashPassword(password));
  // The same rule the application follows when a password changes: every device signs in again
  const revoked = sessionsRepo.revokeAll(user.id);
  if (activate && user.status !== 'active') usersRepo.setStatus(user.id, 'active');

  audit.log({
    actorId: user.id,
    action: 'auth.reset_password',
    targetType: 'user',
    targetId: user.id,
    // No actor and no address: whoever ran this was at a shell on the host
    detail: { via: 'console', revokedSessions: revoked, activated: activate || undefined },
  });

  console.log(`\n  ${user.email} (${user.role})`);
  if (!given) console.log(`\n    password:  ${password}\n`);
  else console.log('\n    password set\n');
  console.log(`    ${revoked} session(s) signed out`);

  if (user.status !== 'active' && !activate) {
    console.log(`\n  ⚠️  This account is ${user.status}, so it still cannot sign in.`);
    console.log('      Run it again with --activate to reinstate it.');
  }
  console.log('');
  return 0;
}

// Only when this file is what was started: a test imports it to call run() directly, and
// exiting the process out from under it would take the test with it
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(run(process.argv.slice(2)));
}

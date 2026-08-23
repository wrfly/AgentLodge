/**
 * The way back in when the application cannot let you in.
 *
 * This runs when somebody is already locked out, which is the worst moment to discover that
 * it writes a hash the login route cannot verify, or that it reports success on an address
 * that does not exist. So the test signs in with what it sets, through the same functions
 * the login route uses.
 *
 * Run: npm -w @agentlodge/server run test:reset-password
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-reset-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('../core/db/index.js');
initDb();
const users = await import('../core/db/users.js');
const sessions = await import('../core/db/sessions.js');
const audit = await import('../core/db/audit.js');
const { verifyPassword } = await import('../core/auth/crypto.js');
const { run } = await import('./reset-password.js');

let pass = 0;
let fail = 0;

function ok(label: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** What it prints is the only way an operator gets the password, so the test reads it */
function capture(argv: string[]): { code: number; out: string } {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = console.error = (...a: unknown[]) => lines.push(a.join(' '));
  try {
    return { code: run(argv), out: lines.join('\n') };
  } finally {
    console.log = log;
    console.error = err;
  }
}

const admin = users.create({
  email: 'admin@example.com',
  username: 'admin',
  passwordHash: 'not-a-real-hash',
  role: 'admin',
});

console.log('\n=== Setting a password you chose ===');
{
  const { code, out } = capture(['admin@example.com', 'a-known-password']);
  ok('it reports success', code === 0, out);
  ok('and does not print the password back', !out.includes('a-known-password'), out);

  const after = users.findById(admin.id)!;
  ok('the new one verifies', verifyPassword('a-known-password', after.passwordHash));
  ok('the old one does not', !verifyPassword('not-a-real-hash', after.passwordHash));
  ok('and the change is dated', Boolean(after.passwordChangedAt));
}

console.log('\n=== One it made up ===');
{
  const { code, out } = capture(['admin@example.com']);
  ok('it reports success', code === 0);

  const shown = /password:\s+(\S+)/.exec(out)?.[1];
  ok('the password is printed, or nobody can use it', Boolean(shown), out);
  ok('and it is long enough to be worth having', (shown ?? '').length >= 12, shown);
  ok('it is the one that was set', verifyPassword(shown ?? '', users.findById(admin.id)!.passwordHash));
}

console.log('\n=== Every device signs in again ===');
{
  const DAY = 24 * 3600_000;
  sessions.create({ userId: admin.id, refreshToken: 'tok-1', ttlMs: DAY });
  sessions.create({ userId: admin.id, refreshToken: 'tok-2', ttlMs: DAY });
  ok('there are sessions to lose', sessions.listActive(admin.id).length === 2);

  const { out } = capture(['admin@example.com', 'another-password']);
  ok('they are gone', sessions.listActive(admin.id).length === 0);
  ok('and it says how many', out.includes('2 session'), out);
}

console.log('\n=== It is recorded ===');
{
  const entry = audit.list(20).find((e) => e.action === 'auth.reset_password');
  ok('the reset is in the audit log', Boolean(entry), JSON.stringify(entry));
  ok('marked as having come from a shell', JSON.stringify(entry?.detail ?? {}).includes('console'));
}

console.log('\n=== What it refuses ===');
{
  const unknown = capture(['nobody@example.com', 'a-known-password']);
  ok('an address with no account fails', unknown.code === 1);
  ok('and says which addresses there are', unknown.out.includes('admin@example.com'));

  const short = capture(['admin@example.com', 'short']);
  ok('a password under eight characters fails', short.code === 1, short.out);
  ok('and the old one still works', verifyPassword('another-password', users.findById(admin.id)!.passwordHash));
}

console.log('\n=== A suspended account is not silently reinstated ===');
{
  users.setStatus(admin.id, 'suspended');
  const quiet = capture(['admin@example.com', 'yet-another-one']);
  ok('it says the account still cannot sign in', quiet.out.includes('suspended'), quiet.out);
  ok('and leaves it suspended', users.findById(admin.id)!.status === 'suspended');

  capture(['admin@example.com', 'yet-another-one', '--activate']);
  ok('--activate is what reinstates it', users.findById(admin.id)!.status === 'active');
}

console.log('\n=== With no address at all ===');
{
  const { code, out } = capture([]);
  ok('it lists the accounts', code === 0 && out.includes('admin@example.com'), out);
  ok('and shows how to call it', out.includes('<email>'));
}

fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

/**
 * The gateway's route table.
 *
 * This exists because a whole block of routes was once deleted along with the comment
 * above them, and nothing noticed: it type-checked, every suite passed, and the console's
 * credential pages answered 404 at runtime. Those routes have no unit test of their own —
 * they forward to another process — so what is checked here is that they are still
 * registered, and still behind the admin guard.
 *
 * Run: npm -w @agentlodge/server run test:routes
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-routes-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';
process.env.CREDENTIAL_MANAGER_SOCKET = path.join(box, 'credential-manager.sock');

const { initDb } = await import('../core/db/index.js');
initDb();
const { buildGateway } = await import('./index.js');

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

const app = buildGateway();
await app.ready();

/** What the console and the CLIs depend on, by method and path */
const EXPECTED: Array<[string, string]> = [
  ['POST', '/v1/messages'],
  ['POST', '/v1/messages/count_tokens'],
  ['POST', '/responses'],
  ['POST', '/v1/chat/completions'],
  ['GET', '/v1/models'],
  ['GET', '/gate'],
  ['PATCH', '/gate'],
  ['GET', '/models'],
  ['GET', '/upstream-allowance'],
  // The credential pages: every one of these is a console feature with no other route
  ['GET', '/credentials'],
  ['POST', '/credentials'],
  ['DELETE', '/credentials'],
  ['POST', '/credentials/import'],
  ['GET', '/credentials/files'],
  ['POST', '/credentials/login/start'],
  ['POST', '/credentials/login/finish'],
];

console.log('\n=== Every route the console and the CLIs call is registered ===');
for (const [method, route] of EXPECTED) ok(`${method} ${route}`, hasRoute(method, route));

/** Fastify keeps the real table internally; find() is the honest question to ask it */
function hasRoute(method: string, url: string): boolean {
  const found = (app as unknown as {
    findRoute: (opts: { method: string; url: string }) => unknown;
  }).findRoute({ method, url });
  return Boolean(found);
}

console.log('\n=== The administrative ones are guarded ===');
{
  const res = await app.inject({ method: 'GET', url: '/credentials' });
  ok('an unauthenticated /credentials is refused', res.statusCode === 401, String(res.statusCode));

  const listed = await app.inject({ method: 'GET', url: '/gate' });
  ok('and so is /gate', listed.statusCode === 401, String(listed.statusCode));
}

await app.close();
fs.rmSync(box, { recursive: true, force: true });
console.log(`\n${fail === 0 ? '✓ all passed' : '✗ failures'}: ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

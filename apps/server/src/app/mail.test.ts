/**
 * Which backend a message goes to, and what it puts on the wire.
 *
 * resend and brevo are one POST each, and they disagree about both halves: the header
 * that carries the key, and the names of the fields in the body. Mixing them up fails as
 * a 401 or a 400 at the moment somebody is waiting for an invite, so the shape of each
 * request is pinned here rather than discovered in production.
 *
 * The unconfigured case is a test as much as the others: it has to degrade to a link in
 * the log and hand that link back, because that is what makes local development work
 * without an account anywhere.
 *
 * Run: npm -w @agentlodge/server run test:mail
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The database path is read from the environment at module load, so point it at a fresh
// directory before importing anything that touches the db.
const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'al-mail-')));
process.env.DATA_DIR = box;
process.env.JWT_SECRET = 'test-only-not-a-real-secret';

const { initDb } = await import('../core/db/index.js');
initDb();
const { setSetting } = await import('../core/db/settings.js');
const { send } = await import('./mail.js');

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

/* ---------------- A fetch that records rather than sends ---------------- */

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

let sent: Sent | null = null;
let reply: () => Response = () => new Response('{}', { status: 200 });

globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  sent = {
    url: String(input),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  };
  return reply();
}) as typeof fetch;

const message = {
  to: 'someone@example.com',
  subject: 'An invitation',
  text: 'plain',
  html: '<p>rich</p>',
  link: 'https://lodge.example.com/invite/abc',
};

console.log('\n=== Nothing configured ===');
{
  sent = null;
  const r = await send(message);
  ok('nothing is sent', r.sent === false);
  ok('the link comes back for the caller to show', r.fallbackLink === message.link);
  ok('and it says what is missing', /from address/i.test(r.error ?? ''), r.error);
  ok('no request was made', sent === null);
}

console.log('\n=== resend ===');
{
  setSetting('mail.from', 'lodge@example.com');
  setSetting('mail.fromName', 'AgentLodge');
  setSetting('mail.apiKey', 'rsnd_key');
  sent = null;
  const r = await send(message);
  const body = sent?.body ?? {};
  ok('the default provider needs no setting of its own', r.sent === true, r.error);
  ok('posts to resend', sent?.url === 'https://api.resend.com/emails', sent?.url);
  ok('the key is a bearer token', sent?.headers.authorization === 'Bearer rsnd_key', JSON.stringify(sent?.headers));
  ok('the sender carries the display name', body.from === 'AgentLodge <lodge@example.com>', String(body.from));
  ok('the recipient is a list', Array.isArray(body.to) && (body.to as string[])[0] === message.to, JSON.stringify(body.to));
  ok('both bodies go', body.html === message.html && body.text === message.text);
}

console.log('\n=== What a provider says when it refuses ===');
{
  reply = () => new Response('{"message":"domain is not verified"}', { status: 403 });
  const r = await send(message);
  reply = () => new Response('{}', { status: 200 });
  ok('the failure is reported', r.sent === false);
  ok('with the status and the reason it gave', /403/.test(r.error ?? '') && /not verified/.test(r.error ?? ''), r.error);
  ok('and the link still comes back', r.fallbackLink === message.link);
}

console.log('\n=== brevo ===');
{
  setSetting('mail.provider', 'brevo');
  sent = null;
  const r = await send(message);
  const body = sent?.body ?? {};
  const sender = body.sender as { email?: string; name?: string } | undefined;
  const to = body.to as Array<{ email?: string }> | undefined;
  ok('posts to brevo', sent?.url === 'https://api.brevo.com/v3/smtp/email', sent?.url);
  ok('the key rides its own header, not Authorization', sent?.headers['api-key'] === 'rsnd_key' && !sent?.headers.authorization, JSON.stringify(sent?.headers));
  ok('the sender is an object', sender?.email === 'lodge@example.com' && sender?.name === 'AgentLodge', JSON.stringify(sender));
  ok('and so is each recipient', to?.[0]?.email === message.to, JSON.stringify(to));
  ok('the bodies are named differently here', body.htmlContent === message.html && body.textContent === message.text);
  ok('it reports success', r.sent === true, r.error);
}

console.log('\n=== smtp ===');
{
  setSetting('mail.provider', 'smtp');
  sent = null;
  const missing = await send(message);
  ok('without a host it degrades rather than dialling', missing.sent === false && /SMTP host/i.test(missing.error ?? ''), missing.error);
  ok('and makes no HTTP request either', sent === null);

  // Port 1 is refused straight away, which is the point: the dispatch reaches the SMTP
  // client and the failure comes back as a result rather than as a thrown error.
  setSetting('mail.smtpHost', '127.0.0.1');
  setSetting('mail.smtpPort', '1');
  const refused = await send(message);
  ok('a relay that refuses is a failed send, not a crash', refused.sent === false && Boolean(refused.error), refused.error);
  ok('the link comes back from there too', refused.fallbackLink === message.link);
  ok('and no HTTP provider was called', sent === null);
}

console.log('\n=== The provider name is checked when it is written ===');
{
  let refusedWrite = '';
  try {
    setSetting('mail.provider', 'sendgrid');
  } catch (e) {
    refusedWrite = e instanceof Error ? e.message : String(e);
  }
  ok('an unknown provider is refused', /resend/.test(refusedWrite), refusedWrite);
}

fs.rmSync(box, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

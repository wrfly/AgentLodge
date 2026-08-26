/**
 * Which backend a message goes to, and what it puts on the wire.
 *
 * resend and brevo are one POST each, and they disagree about both halves: the header
 * that carries the key, and the names of the fields in the body. Mixing them up fails as
 * a 401 or a 400 at the moment somebody is waiting for an invite, so the shape of each
 * request is pinned here rather than discovered in production.
 *
 * The unconfigured case is a test as much as the others: it has to degrade rather than
 * throw, and report that nothing went out, because that is what makes local development
 * work without an account anywhere. The link goes to the log — the caller wrote it and
 * still has it, so there is nothing to hand back.
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

/*
 * Read through a function, not straight off the variable: the assignment that fills it
 * happens inside the stub, where control-flow analysis cannot see it, so a `= null` at the
 * top of a case would narrow every later read in that block to `never`. A call's return
 * type is not narrowed.
 */
let captured: Sent | null = null;
const request = (): Sent | null => captured;
let reply: () => Response = () => new Response('{}', { status: 200 });

globalThis.fetch = (async (input: unknown, init?: { headers?: unknown; body?: unknown }) => {
  captured = {
    url: String(input),
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
  };
  return reply();
}) as unknown as typeof fetch;

const message = {
  to: 'someone@example.com',
  subject: 'An invitation',
  text: 'plain',
  html: '<p>rich</p>',
  link: 'https://lodge.example.com/invite/abc',
};

console.log('\n=== Nothing configured ===');
{
  captured = null;
  const r = await send(message);
  ok('nothing is sent', r.sent === false);
  ok('and it says what is missing', /from address/i.test(r.error ?? ''), r.error);
  ok('no request was made', request() === null);
}

console.log('\n=== resend ===');
{
  setSetting('mail.from', 'lodge@example.com');
  setSetting('mail.fromName', 'AgentLodge');
  setSetting('mail.apiKey', 'rsnd_key');
  captured = null;
  const r = await send(message);
  const body = request()?.body ?? {};
  ok('the default provider needs no setting of its own', r.sent === true, r.error);
  ok('posts to resend', request()?.url === 'https://api.resend.com/emails', request()?.url);
  ok('the key is a bearer token', request()?.headers.authorization === 'Bearer rsnd_key', JSON.stringify(request()?.headers));
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
}

console.log('\n=== brevo ===');
{
  setSetting('mail.provider', 'brevo');
  captured = null;
  const r = await send(message);
  const body = request()?.body ?? {};
  const sender = body.sender as { email?: string; name?: string } | undefined;
  const to = body.to as Array<{ email?: string }> | undefined;
  ok('posts to brevo', request()?.url === 'https://api.brevo.com/v3/smtp/email', request()?.url);
  ok('the key rides its own header, not Authorization', request()?.headers['api-key'] === 'rsnd_key' && !request()?.headers.authorization, JSON.stringify(request()?.headers));
  ok('the sender is an object', sender?.email === 'lodge@example.com' && sender?.name === 'AgentLodge', JSON.stringify(sender));
  ok('and so is each recipient', to?.[0]?.email === message.to, JSON.stringify(to));
  ok('the bodies are named differently here', body.htmlContent === message.html && body.textContent === message.text);
  ok('it reports success', r.sent === true, r.error);
}

console.log('\n=== smtp ===');
{
  setSetting('mail.provider', 'smtp');
  captured = null;
  const missing = await send(message);
  ok('without a host it degrades rather than dialling', missing.sent === false && /SMTP host/i.test(missing.error ?? ''), missing.error);
  ok('and makes no HTTP request either', request() === null);

  // Port 1 is refused straight away, which is the point: the dispatch reaches the SMTP
  // client and the failure comes back as a result rather than as a thrown error.
  setSetting('mail.smtpHost', '127.0.0.1');
  setSetting('mail.smtpPort', '1');
  const refused = await send(message);
  ok('a relay that refuses is a failed send, not a crash', refused.sent === false && Boolean(refused.error), refused.error);
  ok('and no HTTP provider was called', request() === null);
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

console.log('\n=== An unknown provider fails closed, whichever way it arrived ===');
{
  // setSetting refuses it, but MAIL_PROVIDER never passes through validate. It used to
  // fall off the end of a ternary chain into resend, so a key meant for some fourth
  // provider went to api.resend.com as a bearer token.
  captured = null;
  const settings = await import('../core/db/settings.js');
  const { run } = await import('../core/db/index.js');
  // Straight out of the table: setSetting cannot clear it, because '' fails the same
  // validate that MAIL_PROVIDER skips — which is the asymmetry under test.
  run('delete from settings where key = ?', 'mail.provider');
  process.env.MAIL_PROVIDER = 'postmark';
  process.env.MAIL_API_KEY = 'pm_a_key_for_somebody_else';
  settings.invalidate();

  const result = await send(message);

  ok('nothing is sent', !result.sent);
  ok('the reason names the bad value', /postmark/.test(result.error ?? ''), result.error);
  // Not just "it threw somewhere": an administrator reading this has to learn what the
  // accepted values are, which is what separates a checked configuration from the
  // exhaustive switch downstream catching an impossible case.
  ok('and what to put there instead', /resend/.test(result.error ?? ''), result.error);
  ok('and nobody received the key', request() === null, JSON.stringify(request()));

  delete process.env.MAIL_PROVIDER;
  delete process.env.MAIL_API_KEY;
  settings.invalidate();
}

console.log('\n=== An upgrade from SendGrid says so ===');
{
  // SendGrid was the only backend there was, and it is gone. Its key is left in the
  // settings table on purpose — carrying it into mail.apiKey would hand it to resend —
  // so the one thing left to do with it is recognise the case and say what to do about
  // it. Without that, an upgrade turns every invite and reset link into a console.log
  // whose only clue is "No API key configured".
  captured = null;
  const settings = await import('../core/db/settings.js');
  const { run } = await import('../core/db/index.js');
  run('delete from settings where key = ?','mail.apiKey');
  run(
    'insert into settings (key, value, updated_at) values (?, ?, ?)',
    'mail.sendgridApiKey',
    'SG.an_old_key',
    new Date().toISOString(),
  );
  settings.invalidate();

  const result = await send(message);

  ok('nothing is sent', !result.sent);
  ok('it names SendGrid rather than saying "no API key"', /SendGrid/.test(result.error ?? ''), result.error);
  ok('and says what to configure instead', /resend|smtp/.test(result.error ?? ''), result.error);
  ok('the old key goes nowhere', request() === null, JSON.stringify(request()));

  run('delete from settings where key = ?','mail.sendgridApiKey');
  settings.invalidate();
}

fs.rmSync(box, { recursive: true, force: true });

console.log(`\n${fail === 0 ? '✅' : '❌'}  ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

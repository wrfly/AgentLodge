import nodemailer from 'nodemailer';
import { getNumber, getString } from '../core/db/settings.js';

/**
 * Sending mail, through whichever of three backends is configured.
 *
 * resend and brevo are one POST each, so they are one POST each here rather than an SDK.
 * smtp is not one POST: the TLS upgrade, the authentication mechanisms and the MIME
 * encoding of a non-ASCII subject are each a place a hand-written client is wrong without
 * saying so, and that one is nodemailer — which carries no dependencies of its own.
 *
 * With nothing configured it degrades to printing the link to the server log, so local
 * development still exercises the whole flow.
 */

export interface SendResult {
  sent: boolean;
  /** When nothing was actually sent, the link is handed back so the caller can show it */
  fallbackLink?: string;
  error?: string;
}

interface SendInput {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** The link printed and returned when degraded */
  link?: string;
}

type Provider = 'resend' | 'brevo' | 'smtp';

/** What this provider still needs, or undefined when it can send */
function missing(provider: Provider, from: string): string | undefined {
  if (!from) return 'No from address configured';
  if (provider === 'smtp') {
    return getString('mail.smtpHost') ? undefined : 'No SMTP host configured';
  }
  return getString('mail.apiKey') ? undefined : 'No API key configured';
}

/** The reason a provider gave, which its status code alone never carries */
async function detail(res: Response): Promise<string> {
  const body = await res.text().catch(() => '');
  return `${res.status}: ${body.slice(0, 400) || 'no body'}`;
}

export async function send(input: SendInput): Promise<SendResult> {
  const provider = (getString('mail.provider', 'resend') || 'resend') as Provider;
  const from = getString('mail.from');
  const fromName = getString('mail.fromName', 'AgentLodge');

  const notReady = missing(provider, from);
  if (notReady) {
    console.log(
      `\n  [mail] ${provider} is not configured; nothing was sent\n` +
        `  to:      ${input.to}\n` +
        `  subject: ${input.subject}\n` +
        (input.link ? `  link:    ${input.link}\n` : ''),
    );
    return { sent: false, fallbackLink: input.link, error: notReady };
  }

  try {
    const failure =
      provider === 'smtp'
        ? await sendSmtp(from, fromName, input)
        : provider === 'brevo'
          ? await sendBrevo(from, fromName, input)
          : await sendResend(from, fromName, input);

    if (!failure) return { sent: true };
    console.error(`[mail] ${provider}: ${failure}`);
    return { sent: false, error: `${provider} ${failure}`, fallbackLink: input.link };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mail] send failed:', msg);
    return { sent: false, error: msg, fallbackLink: input.link };
  }
}

async function sendResend(from: string, fromName: string, input: SendInput): Promise<string | undefined> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${getString('mail.apiKey')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: `${fromName} <${from}>`,
      to: [input.to],
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? undefined : await detail(res);
}

async function sendBrevo(from: string, fromName: string, input: SendInput): Promise<string | undefined> {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: {
      // Brevo's own header, not Authorization: a Bearer token there is a different API
      'api-key': getString('mail.apiKey'),
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: from, name: fromName },
      to: [{ email: input.to }],
      subject: input.subject,
      htmlContent: input.html,
      textContent: input.text,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  return res.ok ? undefined : await detail(res);
}

async function sendSmtp(from: string, fromName: string, input: SendInput): Promise<string | undefined> {
  const port = getNumber('mail.smtpPort') ?? 587;
  const user = getString('mail.smtpUser');
  const transport = nodemailer.createTransport({
    host: getString('mail.smtpHost'),
    port,
    // 465 is TLS from the first byte; 587 and 25 open in the clear and STARTTLS from
    // there, which nodemailer does on its own when the server offers it
    secure: port === 465,
    auth: user ? { user, pass: getString('mail.smtpPassword') } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 20_000,
  });
  try {
    // Built per send rather than kept: this sends a handful of messages a day, and a
    // pooled connection would only be something to keep alive and re-open after the relay
    // drops it
    await transport.sendMail({
      from: { address: from, name: fromName },
      to: input.to,
      subject: input.subject,
      text: input.text,
      html: input.html,
    });
    return undefined;
  } finally {
    transport.close();
  }
}

/* ---------------- Templates ---------------- */

function layout(title: string, bodyHtml: string): string {
  // Mail clients support CSS poorly: everything inline, no flex or grid
  return `<!doctype html>
<html><body style="margin:0;padding:0;background:#faf9f5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'PingFang SC','Microsoft YaHei',sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #e3e0d6;border-radius:14px;">
        <tr><td style="padding:28px 28px 8px;">
          <div style="font-size:15px;font-weight:600;color:#c96442;letter-spacing:-0.01em;">AgentLodge</div>
        </td></tr>
        <tr><td style="padding:8px 28px 28px;">
          <h1 style="margin:0 0 14px;font-size:19px;font-weight:600;color:#2f2f2c;">${title}</h1>
          ${bodyHtml}
        </td></tr>
      </table>
      <div style="max-width:480px;margin-top:14px;font-size:11.5px;color:#9a978f;line-height:1.6;">
        If you were not expecting this email, you can simply ignore it.
      </div>
    </td></tr>
  </table>
</body></html>`;
}

function button(href: string, label: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0;"><tr><td style="border-radius:8px;background:#c96442;">
    <a href="${href}" style="display:inline-block;padding:11px 22px;font-size:14px;font-weight:500;color:#ffffff;text-decoration:none;">${label}</a>
  </td></tr></table>`;
}

const P = 'margin:0 0 12px;font-size:14px;line-height:1.7;color:#3d3d3a;';
const SMALL = 'margin:14px 0 0;font-size:12px;line-height:1.6;color:#8a8781;word-break:break-all;';

export interface InviteMailInput {
  to: string;
  code: string;
  link: string;
  inviterName?: string;
  expiresAt?: string;
  tokenLimit?: number | null;
}

export function inviteMail(input: InviteMailInput): { subject: string; html: string; text: string } {
  const who = input.inviterName ? `${input.inviterName} ` : '';
  const quotaLine =
    input.tokenLimit != null
      ? `<p style="${P}">Your account quota is <strong>${input.tokenLimit.toLocaleString()}</strong> tokens per month.</p>`
      : '';
  const expiryLine = input.expiresAt
    ? `<p style="${P}">The invitation expires on ${new Date(input.expiresAt).toLocaleString('en-GB')}.</p>`
    : '';

  return {
    subject: 'You have been invited to AgentLodge',
    html: layout(
      'You have been invited to AgentLodge',
      `<p style="${P}">${who}invited you to AgentLodge — an AI chat service built on Claude Code and Codex.</p>
       <p style="${P}">Use the button below to finish signing up; the invite code is filled in for you:</p>
       ${button(input.link, 'Accept and sign up')}
       <p style="${P}">Or enter the code by hand: <strong style="font-family:ui-monospace,Menlo,monospace;font-size:15px;letter-spacing:0.04em;">${input.code}</strong></p>
       ${quotaLine}${expiryLine}
       <p style="${SMALL}">If the button does not work, copy this link:<br>${input.link}</p>`,
    ),
    text: `${who}invited you to AgentLodge.\n\nSign-up link: ${input.link}\nInvite code: ${input.code}\n`,
  };
}

export function resetMail(input: { link: string; ttlMinutes: number }): {
  subject: string;
  html: string;
  text: string;
} {
  return {
    subject: 'Reset your AgentLodge password',
    html: layout(
      'Reset your password',
      `<p style="${P}">We received a request to reset your password. Use the button below to set a new one:</p>
       ${button(input.link, 'Set a new password')}
       <p style="${P}">The link is valid for <strong>${input.ttlMinutes} minutes</strong> and works once.</p>
       <p style="${P}">If this was not you, ignore this email — your password will not change.</p>
       <p style="${SMALL}">If the button does not work, copy this link:<br>${input.link}</p>`,
    ),
    text: `Reset your AgentLodge password: ${input.link}\n\nValid for ${input.ttlMinutes} minutes, and works once.`,
  };
}

export function quotaWarningMail(input: {
  username: string;
  used: number;
  limit: number;
  link: string;
}): { subject: string; html: string; text: string } {
  const pct = Math.round((input.used / input.limit) * 100);
  return {
    subject: `AgentLodge quota is ${pct}% used`,
    html: layout(
      `Quota is ${pct}% used`,
      `<p style="${P}">${input.username}, you have used <strong>${input.used.toLocaleString()}</strong> of ${input.limit.toLocaleString()} tokens this month.</p>
       <p style="${P}">Once the quota is used up you cannot start new conversations until an administrator adjusts it.</p>
       ${button(input.link, 'See the breakdown')}`,
    ),
    text: `You have used ${input.used} of ${input.limit} tokens this month (${pct}%). Breakdown: ${input.link}`,
  };
}

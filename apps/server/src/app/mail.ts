import { getString } from '../core/db/settings.js';

/**
 * Sending mail through SendGrid v3.
 *
 * Straight to the REST API rather than pulling in @sendgrid/mail — it is one POST, which
 * does not justify a dependency. With no API key configured it degrades to printing the
 * link to the server log, so local development still exercises the whole flow.
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

const ENDPOINT = 'https://api.sendgrid.com/v3/mail/send';

export async function send(input: SendInput): Promise<SendResult> {
  const apiKey = getString('mail.sendgridApiKey');
  const from = getString('mail.from');
  const fromName = getString('mail.fromName', 'AgentLodge');

  if (!apiKey || !from) {
    console.log(
      `\n  [mail] SendGrid is not configured; nothing was sent\n` +
        `  to:      ${input.to}\n` +
        `  subject: ${input.subject}\n` +
        (input.link ? `  link:    ${input.link}\n` : ''),
    );
    return { sent: false, fallbackLink: input.link, error: !apiKey ? 'No SendGrid API key configured' : 'No from address configured' };
  }

  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: input.to }] }],
        from: { email: from, name: fromName },
        subject: input.subject,
        content: [
          { type: 'text/plain', value: input.text },
          { type: 'text/html', value: input.html },
        ],
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (res.ok) return { sent: true };

    // SendGrid puts the reason in the body; the status code alone says nothing
    const body = await res.text().catch(() => '');
    const detail = body.slice(0, 400) || `HTTP ${res.status}`;
    console.error(`[mail] SendGrid returned ${res.status}: ${detail}`);
    return { sent: false, error: `SendGrid ${res.status}: ${detail}`, fallbackLink: input.link };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[mail] send failed:', msg);
    return { sent: false, error: msg, fallbackLink: input.link };
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

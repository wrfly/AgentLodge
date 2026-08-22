import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../../core/config.js';
import * as usersRepo from '../../core/db/users.js';
import * as invitesRepo from '../../core/db/invites.js';
import * as sessionsRepo from '../../core/db/sessions.js';
import * as audit from '../../core/db/audit.js';
import { getString } from '../../core/db/settings.js';
import { hashPassword, randomToken, verifyPassword } from '../../core/auth/crypto.js';
import { issueStreamTicket, signAccessToken } from '../../core/auth/tokens.js';
import { requireUser } from '../../core/auth/guard.js';
import * as mail from '../mail.js';
import * as memory from '../memory.js';
import { tr } from '../../core/i18n/locale.js';

const REFRESH_COOKIE = 'agentlodge_rt';
const RESET_TTL_MS = 30 * 60 * 1000;
/**
 * The grace window for concurrent refreshes.
 *
 * A refresh token used a second time inside this window is treated as one client making
 * concurrent requests, not as a replay. The cost is that an attacker replaying a stolen
 * token within ten seconds of a legitimate refresh is not caught immediately — the same
 * trade the industry makes (Auth0's refresh token leeway, for instance). Past the window,
 * every session is still revoked.
 */
const REFRESH_RACE_GRACE_MS = 10_000;

/* ---------------- Brute-force protection ---------------- */

const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 5;
const LOCK_MS = 15 * 60 * 1000;

function isLocked(key: string): boolean {
  const f = failures.get(key);
  if (!f) return false;
  if (f.until < Date.now()) {
    failures.delete(key);
    return false;
  }
  return f.count >= MAX_FAILURES;
}

function noteFailure(key: string): void {
  const f = failures.get(key) ?? { count: 0, until: 0 };
  f.count += 1;
  f.until = Date.now() + LOCK_MS;
  failures.set(key, f);
}

/*
 * Sweep expired entries.
 *
 * isLocked drops an entry when it expires, but only for the key being asked about — and half
 * the keys here are `email:<whatever the caller typed>`, which nobody ever asks about again.
 * Every wrong address left one behind for good. It grows slowly, since five failures lock the
 * address out for fifteen minutes, and it never stops growing, which for a process meant to
 * run for months is the wrong shape. The tickets map in core/auth/tokens.js sweeps the same
 * way for the same reason.
 */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (v.until < now) failures.delete(k);
}, 60_000).unref();

/* ---------------- Issuing tokens ---------------- */

function setRefreshCookie(reply: FastifyReply, token: string): void {
  reply.setCookie(REFRESH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.secureCookies,
    path: '/api/auth',
    maxAge: Math.floor(config.refreshTokenTtlMs / 1000),
  });
}

function clientMeta(req: FastifyRequest) {
  const ua = req.headers['user-agent'] ?? '';
  return {
    ip: req.ip,
    userAgent: ua.slice(0, 300),
    platform: /iPhone|iPad|Android|Mobile/i.test(ua) ? 'mobile' : 'web',
  };
}

async function issueTokens(
  reply: FastifyReply,
  req: FastifyRequest,
  user: usersRepo.User,
  rotatedFrom?: string,
) {
  const refreshToken = randomToken();
  const meta = clientMeta(req);
  const session = sessionsRepo.create({
    userId: user.id,
    refreshToken,
    platform: meta.platform,
    ip: meta.ip,
    userAgent: meta.userAgent,
    rotatedFrom,
    ttlMs: config.refreshTokenTtlMs,
  });
  setRefreshCookie(reply, refreshToken);
  return {
    accessToken: await signAccessToken({ sub: user.id, role: user.role, sid: session.id }),
    expiresIn: Math.floor(config.accessTokenTtlMs / 1000),
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Returns an English source string, or null when the password is acceptable.
 *
 * The caller translates it — this helper has no request, and inventing one just to reach a
 * locale would be worse than handing back a key the caller can resolve.
 */
function validatePassword(pw: string): string | null {
  if (pw.length < 8) return 'The password has to be at least 8 characters';
  if (pw.length > 200) return 'That password is too long';
  // Eight digits, or eight letters, is too weak to accept
  if (/^\d+$/.test(pw)) return 'The password cannot be all digits';
  return null;
}

export function registerAuthRoutes(app: FastifyInstance): void {
  /* ---------------- Sign-up ---------------- */

  app.post('/api/auth/register', async (req, reply) => {
    const body = (req.body ?? {}) as {
      email?: string;
      username?: string;
      password?: string;
      inviteCode?: string;
    };
    const email = (body.email ?? '').trim().toLowerCase();
    const username = (body.username ?? '').trim();
    const password = body.password ?? '';
    const code = (body.inviteCode ?? '').trim();

    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: tr(req, 'That is not a valid email address') });
    if (username.length < 2 || username.length > 24)
      return reply.code(400).send({ error: tr(req, 'A username has to be 2–24 characters') });
    const pwErr = validatePassword(password);
    if (pwErr) return reply.code(400).send({ error: tr(req, pwErr) });
    if (!code) return reply.code(400).send({ error: tr(req, 'An invite code is required') });

    const invite = invitesRepo.findByCode(code);
    if (!invite) return reply.code(400).send({ error: tr(req, 'Invalid invite code') });
    const usable = invitesRepo.checkUsable(invite, email);
    if (!usable.ok) return reply.code(400).send({ error: usable.reason });

    if (usersRepo.emailTaken(email)) return reply.code(409).send({ error: tr(req, 'That address is already registered') });
    if (usersRepo.usernameTaken(username))
      return reply.code(409).send({ error: tr(req, 'That username is taken') });

    const user = usersRepo.create({
      email,
      username,
      passwordHash: hashPassword(password),
      role: invite.presetRole,
      inviteCodeId: invite.id,
      tokenLimit: invite.presetTokenLimit,
    });
    invitesRepo.consume(invite.id);
    await memory.ensureInitialized(user.id);

    audit.log({
      actorId: user.id,
      action: 'user.register',
      targetType: 'user',
      targetId: user.id,
      detail: { inviteCode: invite.code },
      ip: req.ip,
    });

    const tokens = await issueTokens(reply, req, user);
    reply.code(201);
    return { user: usersRepo.toPublic(user), ...tokens };
  });

  /** For the sign-up page: validate an invite code and echo the address it is bound to. An emailed link carries the code. */
  app.get('/api/auth/invite/:code', async (req, reply) => {
    const { code } = req.params as { code: string };
    const invite = invitesRepo.findByCode(code);
    if (!invite) return reply.code(404).send({ error: tr(req, 'Invalid invite code') });
    const usable = invitesRepo.checkUsable(invite);
    return {
      valid: usable.ok,
      reason: usable.ok ? undefined : usable.reason,
      email: invite.email,
      expiresAt: invite.expiresAt,
      tokenLimit: invite.presetTokenLimit,
    };
  });

  /* ---------------- Sign-in ---------------- */

  app.post('/api/auth/login', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string; password?: string };
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';

    const ipKey = `ip:${req.ip}`;
    const emailKey = `email:${email}`;
    if (isLocked(ipKey) || isLocked(emailKey))
      return reply.code(429).send({ error: tr(req, 'Too many attempts; try again in 15 minutes') });

    const user = usersRepo.findByEmail(email);
    // A missing user still runs one hash comparison, so response time cannot be used to
    // discover whether an address is registered
    const ok = user
      ? verifyPassword(password, user.passwordHash)
      : (verifyPassword(password, hashPassword('dummy')), false);

    if (!user || !ok) {
      noteFailure(ipKey);
      noteFailure(emailKey);
      return reply.code(401).send({ error: tr(req, 'That email or password is not correct') });
    }
    if (user.status === 'suspended')
      return reply.code(403).send({ error: tr(req, 'This account has been disabled; contact an administrator') });

    failures.delete(ipKey);
    failures.delete(emailKey);
    usersRepo.touchLogin(user.id);

    const tokens = await issueTokens(reply, req, user);
    return { user: usersRepo.toPublic(user), ...tokens };
  });

  /* ---------------- Refresh: rotation and replay detection ---------------- */

  app.post('/api/auth/refresh', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (!token) return reply.code(401).send({ error: tr(req, 'Not signed in') });

    const session = sessionsRepo.findByToken(token);
    if (!session) return reply.code(401).send({ error: tr(req, 'Your session is no longer valid; sign in again') });

    const owner = usersRepo.findById(session.userId);
    if (!owner || owner.status === 'suspended')
      return reply.code(403).send({ error: tr(req, 'This account is unavailable') });

    // Replay detection has to come before the revoked check: rotation marks the old session
    // revoked, so checking revoked first would mean the replay branch never runs.
    if (sessionsRepo.hasDescendant(session.id)) {
      // But the same token being exchanged twice is not necessarily a replay: React's
      // StrictMode double-mount, or several tabs cold-starting at once, send the same cookie
      // concurrently. The rotation has not reached the browser yet, so the second request
      // necessarily still holds the old token.
      //
      // The test: the session it rotated into is alive and was created just now, inside the
      // grace window. That is concurrency, not a replay.
      //
      // This branch reissues an access token and sets no cookie. The rotation was completed
      // by whichever request arrived first, the browser should keep that one, and setting
      // another here would overwrite a valid cookie.
      const child = sessionsRepo.latestActiveDescendant(session.id);
      if (child && Date.now() - Date.parse(child.createdAt) <= REFRESH_RACE_GRACE_MS) {
        req.log.debug({ userId: session.userId }, 'concurrent refresh inside the grace window; treated as one client');
        return {
          user: usersRepo.toPublic(owner),
          accessToken: await signAccessToken({
            sub: owner.id,
            role: owner.role,
            sid: child.id,
          }),
          expiresIn: Math.floor(config.accessTokenTtlMs / 1000),
        };
      }

      const n = sessionsRepo.revokeAll(session.userId);
      req.log.warn({ userId: session.userId, revoked: n }, 'refresh token replayed; every session revoked');
      audit.log({
        actorId: session.userId,
        action: 'auth.replay_detected',
        targetType: 'user',
        targetId: session.userId,
        detail: { revoked: n },
        ip: req.ip,
      });
      reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
      return reply
        .code(401)
        .send({ error: tr(req, 'Unusual sign-in activity was detected; every device has been signed out. Sign in again.') });
    }

    if (session.revokedAt || new Date(session.expiresAt) < new Date())
      return reply.code(401).send({ error: tr(req, 'Your session has expired; sign in again') });

    sessionsRepo.revoke(session.id);
    const tokens = await issueTokens(reply, req, owner, session.id);
    return { user: usersRepo.toPublic(owner), ...tokens };
  });

  /* ---------------- Sign-out ---------------- */

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[REFRESH_COOKIE];
    if (token) {
      const session = sessionsRepo.findByToken(token);
      if (session) sessionsRepo.revoke(session.id);
    }
    reply.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
    return { ok: true };
  });

  /* ---------------- Changing a password ---------------- */

  app.post('/api/auth/change-password', { preHandler: requireUser }, async (req, reply) => {
    const body = (req.body ?? {}) as { currentPassword?: string; newPassword?: string };
    const user = usersRepo.findById(req.user!.id)!;

    if (!verifyPassword(body.currentPassword ?? '', user.passwordHash))
      return reply.code(401).send({ error: tr(req, 'The current password is not correct') });

    const err = validatePassword(body.newPassword ?? '');
    if (err) return reply.code(400).send({ error: tr(req, err) });
    if (body.newPassword === body.currentPassword)
      return reply.code(400).send({ error: tr(req, 'The new password cannot be the same as the current one') });

    usersRepo.setPassword(user.id, hashPassword(body.newPassword!));

    // Changing the password signs out every other device and keeps this one
    const others = sessionsRepo.listActive(user.id).filter((s) => s.id !== req.user!.sessionId);
    others.forEach((s) => sessionsRepo.revoke(s.id));

    audit.log({
      actorId: user.id,
      action: 'user.change_password',
      targetType: 'user',
      targetId: user.id,
      detail: { revokedSessions: others.length },
      ip: req.ip,
    });

    return { ok: true, revokedSessions: others.length };
  });

  /* ---------------- Forgotten password ---------------- */

  app.post('/api/auth/forgot-password', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: string };
    const email = (body.email ?? '').trim().toLowerCase();

    const ipKey = `forgot:${req.ip}`;
    if (isLocked(ipKey)) return reply.code(429).send({ error: tr(req, 'Too many requests; try again shortly') });
    noteFailure(ipKey);

    const user = usersRepo.findByEmail(email);
    // The same result either way, so this cannot be used to enumerate accounts
    if (user && user.status === 'active') {
      const token = randomToken();
      sessionsRepo.createReset(user.id, token, RESET_TTL_MS);
      const link = `${getString('app.baseUrl', 'http://localhost:5173')}/reset-password?token=${token}`;
      const tpl = mail.resetMail({ link, ttlMinutes: RESET_TTL_MS / 60000 });
      const result = await mail.send({ to: user.email, ...tpl, link });
      audit.log({
        actorId: user.id,
        action: 'auth.forgot_password',
        targetType: 'user',
        targetId: user.id,
        detail: { mailSent: result.sent },
        ip: req.ip,
      });
    }
    return { ok: true, message: tr(req, 'If that address is registered, a reset link has been sent') };
  });

  app.post('/api/auth/reset-password', async (req, reply) => {
    const body = (req.body ?? {}) as { token?: string; newPassword?: string };
    const reset = body.token ? sessionsRepo.findReset(body.token) : undefined;

    if (!reset || reset.usedAt || new Date(reset.expiresAt) < new Date())
      return reply.code(400).send({ error: tr(req, 'That reset link is invalid or has expired') });

    const err = validatePassword(body.newPassword ?? '');
    if (err) return reply.code(400).send({ error: tr(req, err) });

    const user = usersRepo.findById(reset.userId);
    if (!user) return reply.code(400).send({ error: tr(req, 'That reset link is invalid') });

    usersRepo.setPassword(user.id, hashPassword(body.newPassword!));
    sessionsRepo.useReset(reset.id);
    // Resetting a password means suspecting a compromise, so every device is signed out
    const revoked = sessionsRepo.revokeAll(user.id);

    audit.log({
      actorId: user.id,
      action: 'auth.reset_password',
      targetType: 'user',
      targetId: user.id,
      detail: { revokedSessions: revoked },
      ip: req.ip,
    });

    return { ok: true };
  });

  /* ---------------- Current user and devices ---------------- */

  app.get('/api/auth/me', { preHandler: requireUser }, async (req) => ({
    user: usersRepo.toPublic(usersRepo.findById(req.user!.id)!),
  }));

  app.get('/api/auth/sessions', { preHandler: requireUser }, async (req) =>
    sessionsRepo.listActive(req.user!.id).map((s) => ({
      id: s.id,
      platform: s.platform,
      ip: s.ip,
      userAgent: s.userAgent,
      createdAt: s.createdAt,
      lastSeenAt: s.lastSeenAt,
      current: s.id === req.user!.sessionId,
    })),
  );

  app.delete('/api/auth/sessions/:id', { preHandler: requireUser }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const target = sessionsRepo.listActive(req.user!.id).find((s) => s.id === id);
    if (!target) return reply.code(404).send({ error: tr(req, 'No such device') });
    sessionsRepo.revoke(id);
    return { ok: true };
  });

  /** Exchanging for an SSE ticket, since EventSource cannot send an Authorization header */
  app.post('/api/auth/stream-ticket', { preHandler: requireUser }, async (req) => ({
    ticket: issueStreamTicket(req.user!.id),
  }));
}

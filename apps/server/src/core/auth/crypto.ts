import crypto from 'node:crypto';

/**
 * Password hashing uses Node's built-in scrypt, so there is no native dependency like
 * argon2 to build. Parameters follow OWASP's advice: N=2^15, r=8, p=1 — roughly 32MB and
 * ~100ms. DESIGN.md specifies argon2id, which can still be swapped in before production:
 * the stored format already carries an algorithm prefix so migration is gradual.
 */
const SCRYPT = { N: 32768, r: 8, p: 1, keylen: 64, maxmem: 64 * 1024 * 1024 } as const;

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, keyB64] = parts;
  try {
    const salt = Buffer.from(saltB64!, 'base64url');
    const expected = Buffer.from(keyB64!, 'base64url');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** An opaque random token: refresh tokens, invite codes, stream tickets */
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Hashed before storage, so a stolen database is not a set of working logins */
export function sha256(input: string): string {
  return crypto.createHash('sha256').update(input).digest('base64url');
}

/** Invite codes: confusable characters removed, grouped so they can be read aloud */
export function generateInviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const pick = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${pick()}-${pick()}-${pick()}`;
}

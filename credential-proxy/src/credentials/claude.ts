import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { config } from '../config.js';

/* ------------------------------------------------------------------ *
 * Claude subscription credentials, with three places to look: the environment, the
 * credentials file, then the macOS Keychain.
 *
 * The host's own CLI refreshes these tokens too, so a failed refresh re-reads storage
 * first — more often than not the CLI has already done the work for us.
 * ------------------------------------------------------------------ */

export interface ClaudeOAuth {
  accessToken: string;
  refreshToken: string | null;
  /** Unix milliseconds */
  expiresAt: number | null;
  source: string;
}

const KEYCHAIN_SERVICE = 'Claude Code-credentials';

function credentialsPath(): string {
  if (config.claudeCredentialsFile) {
    return config.claudeCredentialsFile.replace(/^~/, os.homedir());
  }
  return path.join(os.homedir(), '.claude', '.credentials.json');
}

function parsePayload(payload: Record<string, unknown>, source: string): ClaudeOAuth {
  const oauth = (payload['claudeAiOauth'] as Record<string, unknown> | undefined) ?? payload;
  const access = (oauth['accessToken'] ?? oauth['access_token']) as string | undefined;
  if (!access) throw new Error(`No access token in the Claude credentials (${source})`);
  const refresh = (oauth['refreshToken'] ?? oauth['refresh_token']) as string | undefined;
  const rawExp = oauth['expiresAt'] ?? oauth['expires_at'];
  const expiresAt =
    typeof rawExp === 'number' ? rawExp : typeof rawExp === 'string' && /^\d+$/.test(rawExp) ? Number(rawExp) : null;
  return { accessToken: access, refreshToken: refresh ?? null, expiresAt, source };
}

function fromEnv(): ClaudeOAuth | null {
  const token = process.env['CLAUDE_CODE_OAUTH_TOKEN'] ?? process.env['CLAUDE_ACCESS_TOKEN'];
  if (!token) return null;
  return { accessToken: token, refreshToken: null, expiresAt: null, source: 'env' };
}

function fromFile(): ClaudeOAuth | null {
  const p = credentialsPath();
  if (!fs.existsSync(p)) return null;
  return parsePayload(JSON.parse(fs.readFileSync(p, 'utf8')), `file:${p}`);
}

function fromKeychain(): ClaudeOAuth | null {
  if (process.platform !== 'darwin') return null;
  try {
    const out = execFileSync('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!out) return null;
    return parsePayload(JSON.parse(out), 'keychain');
  } catch {
    return null;
  }
}

export class ClaudeCredentialStore {
  private cached: ClaudeOAuth | null = null;
  private inflight: Promise<ClaudeOAuth> | null = null;

  private loadRaw(): ClaudeOAuth {
    for (const loader of [fromEnv, fromFile, fromKeychain]) {
      const c = loader();
      if (c) return c;
    }
    throw new Error(
      'No Claude OAuth credentials found. Run `claude login` on the host, or set CLAUDE_CODE_OAUTH_TOKEN.',
    );
  }

  private expired(c: ClaudeOAuth, skewMs = 10 * 60 * 1000): boolean {
    if (c.expiresAt === null) return false;
    return Date.now() >= c.expiresAt - skewMs;
  }

  async getAccessToken(forceRefresh = false): Promise<string> {
    // Serialised, so concurrent requests cannot each trigger a refresh and burn the refresh_token
    while (this.inflight) await this.inflight.catch(() => undefined);
    this.cached ??= this.loadRaw();
    if (forceRefresh || this.expired(this.cached)) {
      this.inflight = this.refresh(this.cached);
      try {
        this.cached = await this.inflight;
      } finally {
        this.inflight = null;
      }
    }
    return this.cached.accessToken;
  }

  private async refresh(creds: ClaudeOAuth): Promise<ClaudeOAuth> {
    if (!creds.refreshToken) {
      const reloaded = this.loadRaw();
      if (!this.expired(reloaded, 0)) return reloaded;
      throw new Error('The Claude access token has expired, and there is no refresh token');
    }

    const res = await fetch(config.claudeOauthTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: config.claudeOauthClientId,
      }),
    });

    if (!res.ok) {
      // The host CLI may have refreshed it already, so read storage once more
      const reloaded = this.loadRaw();
      if (!this.expired(reloaded, 0)) return reloaded;
      throw new Error(`Claude token refresh failed: ${res.status} ${(await res.text()).slice(0, 300)}`);
    }

    const data = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };
    const refreshed: ClaudeOAuth = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : creds.expiresAt,
      source: creds.source,
    };
    this.persist(refreshed);
    return refreshed;
  }

  /** Write it back, so the host CLI gets the refreshed token too */
  private persist(c: ClaudeOAuth): void {
    const p = credentialsPath();
    const payload = {
      claudeAiOauth: {
        accessToken: c.accessToken,
        refreshToken: c.refreshToken,
        expiresAt: c.expiresAt,
      },
    };
    try {
      if (fs.existsSync(p)) {
        const existing = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
        existing['claudeAiOauth'] = {
          ...((existing['claudeAiOauth'] as object) ?? {}),
          ...payload.claudeAiOauth,
        };
        fs.writeFileSync(p, JSON.stringify(existing), { mode: 0o600 });
      } else if (c.source !== 'keychain') {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(payload), { mode: 0o600 });
      }
    } catch {
      /* Failing to write is survivable — we still hold it in memory */
    }

    if (c.source === 'keychain' && process.platform === 'darwin') {
      try {
        execFileSync(
          'security',
          ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', 'Claude Code', '-w', JSON.stringify(payload)],
          { stdio: 'ignore' },
        );
      } catch {
        /* ignore */
      }
    }
  }

  status(): Record<string, unknown> {
    try {
      const c = this.cached ?? this.loadRaw();
      return {
        provider: 'claude',
        ok: true,
        source: c.source,
        expiresAt: c.expiresAt,
        expired: this.expired(c, 0),
        hasRefreshToken: Boolean(c.refreshToken),
      };
    } catch (e) {
      return { provider: 'claude', ok: false, error: (e as Error).message };
    }
  }
}

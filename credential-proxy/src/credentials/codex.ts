import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

/** ChatGPT subscription credentials, written to ~/.codex/auth.json by `codex login` */
export interface CodexOAuth {
  accessToken: string;
  refreshToken: string | null;
  accountId: string | null;
  authMode: string | null;
  source: string;
}

function authPath(): string {
  return path.join(config.codexHome, 'auth.json');
}

export class CodexCredentialStore {
  private cached: CodexOAuth | null = null;
  private inflight: Promise<CodexOAuth> | null = null;

  private loadRaw(): CodexOAuth {
    const p = authPath();
    if (!fs.existsSync(p)) {
      throw new Error(`${p} does not exist. Run \`codex login\` on the host (ChatGPT subscription).`);
    }
    const data = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
    const tokens = (data['tokens'] as Record<string, unknown> | undefined) ?? {};
    const access = (tokens['access_token'] ?? data['access_token']) as string | undefined;
    if (!access) throw new Error('No access_token in auth.json');
    return {
      accessToken: access,
      refreshToken: ((tokens['refresh_token'] ?? data['refresh_token']) as string) ?? null,
      accountId: ((tokens['account_id'] ?? data['account_id']) as string) ?? null,
      authMode: ((data['auth_mode'] ?? data['type']) as string) ?? null,
      source: `file:${p}`,
    };
  }

  async get(forceRefresh = false): Promise<CodexOAuth> {
    while (this.inflight) await this.inflight.catch(() => undefined);
    this.cached ??= this.loadRaw();
    if (forceRefresh) {
      this.inflight = this.refresh(this.cached);
      try {
        this.cached = await this.inflight;
      } finally {
        this.inflight = null;
      }
    }
    return this.cached;
  }

  private async refresh(creds: CodexOAuth): Promise<CodexOAuth> {
    if (!creds.refreshToken) return this.loadRaw();

    const res = await fetch(config.openaiOauthTokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: config.openaiOauthClientId,
      }),
    });
    // On a failed refresh, re-read the file: the host's codex CLI may have refreshed it already
    if (!res.ok) return this.loadRaw();

    const data = (await res.json()) as { access_token: string; refresh_token?: string };
    const refreshed: CodexOAuth = {
      ...creds,
      accessToken: data.access_token,
      refreshToken: data.refresh_token ?? creds.refreshToken,
    };
    this.persist(refreshed);
    return refreshed;
  }

  private persist(c: CodexOAuth): void {
    const p = authPath();
    try {
      const existing = fs.existsSync(p)
        ? (JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>)
        : {};
      const tokens = ((existing['tokens'] as Record<string, unknown>) ?? {});
      tokens['access_token'] = c.accessToken;
      if (c.refreshToken) tokens['refresh_token'] = c.refreshToken;
      if (c.accountId) tokens['account_id'] = c.accountId;
      existing['tokens'] = tokens;
      existing['last_refresh'] = Date.now() / 1000;
      fs.writeFileSync(p, JSON.stringify(existing, null, 2), { mode: 0o600 });
    } catch {
      /* ignore */
    }
  }

  status(): Record<string, unknown> {
    try {
      const c = this.cached ?? this.loadRaw();
      return {
        provider: 'codex',
        ok: true,
        source: c.source,
        authMode: c.authMode,
        hasRefreshToken: Boolean(c.refreshToken),
      };
    } catch (e) {
      return { provider: 'codex', ok: false, error: (e as Error).message };
    }
  }
}

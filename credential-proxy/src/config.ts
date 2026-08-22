import path from 'node:path';
import os from 'node:os';

function str(k: string, d: string): string {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
}
function int(k: string, d: number): number {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
}
function list(k: string): string[] {
  return str(k, '').split(',').map((s) => s.trim()).filter(Boolean);
}

export const config = {
  host: str('GATEWAY_HOST', '127.0.0.1'),
  port: int('GATEWAY_PORT', 8795),   // 8787 is AgentLodge's app; do not collide with it

  /** Shared secret callers present to this gateway. Comma-separated for several; empty means no authentication. */
  tokens: list('GATEWAY_TOKEN'),
  /** The subscription allowance is shared, so concurrency is capped */
  maxConcurrent: int('GATEWAY_MAX_CONCURRENT', 2),

  /* ---- DeepSeek: passed straight through with your own API key ---- */
  deepseekUpstream: str('DEEPSEEK_UPSTREAM', 'https://api.deepseek.com'),
  deepseekApiKey: str('DEEPSEEK_API_KEY', ''),

  /* ---- Anthropic: uses the host's Claude subscription credentials ---- */
  anthropicUpstream: str('ANTHROPIC_UPSTREAM', 'https://api.anthropic.com'),
  claudeCredentialsFile: str('CLAUDE_CREDENTIALS_FILE', ''),
  claudeOauthClientId: str('CLAUDE_OAUTH_CLIENT_ID', '9d1c250a-e61b-44d9-88ed-5944d1962f5e'),
  claudeOauthTokenUrl: str('CLAUDE_OAUTH_TOKEN_URL', 'https://platform.claude.com/v1/oauth/token'),

  /* ---- Codex: uses the host's ChatGPT subscription credentials ---- */
  codexUpstream: str('CODEX_UPSTREAM', 'https://chatgpt.com/backend-api/codex'),
  codexHome: str('CODEX_HOME', path.join(os.homedir(), '.codex')),
  openaiOauthTokenUrl: str('OPENAI_OAUTH_TOKEN_URL', 'https://auth.openai.com/oauth/token'),
  openaiOauthClientId: str('OPENAI_OAUTH_CLIENT_ID', 'app_EMoamEEZ73f0CkXaXp7hrann'),

  /* ---- Metering ---- */
  dataDir: str('GATEWAY_DATA_DIR', path.join(process.cwd(), 'data')),
  /** Whether each request's usage is appended to a JSONL file */
  meteringEnabled: str('GATEWAY_METERING', 'true') !== 'false',

  upstreamTimeoutMs: int('GATEWAY_UPSTREAM_TIMEOUT_MS', 600_000),
} as const;

export function assertSafeToListen(): void {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
  if (!loopback && config.tokens.length === 0) {
    throw new Error(
      `Refusing to start: GATEWAY_HOST=${config.host} is not a loopback address, and GATEWAY_TOKEN is empty.\n` +
        'This gateway holds your subscription credentials; leaving it open hands your subscription to whoever finds it.',
    );
  }
}

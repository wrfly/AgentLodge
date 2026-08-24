import path from 'node:path';

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

  /* ---- Auth: credentials live in the auther sidecar, not here ---- */
  /** Unix socket path for the auther service (the only holder of refresh tokens). */
  autherSocket: str('AUTHER_SOCKET', '/run/agentlodge/auther.sock'),

  /* ---- DeepSeek: passed straight through with your own API key ---- */
  deepseekUpstream: str('DEEPSEEK_UPSTREAM', 'https://api.deepseek.com'),
  deepseekApiKey: str('DEEPSEEK_API_KEY', ''),

  /* ---- Anthropic / Codex upstreams (credentials come from the auther) ---- */
  anthropicUpstream: str('ANTHROPIC_UPSTREAM', 'https://api.anthropic.com'),
  codexUpstream: str('CODEX_UPSTREAM', 'https://chatgpt.com/backend-api/codex'),

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

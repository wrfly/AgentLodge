import Fastify from 'fastify';
import { config, assertSafeToListen } from './config.js';
import { requireGatewayToken } from './token.js';
import { ClaudeCredentialStore } from './credentials/claude.js';
import { CodexCredentialStore } from './credentials/codex.js';
import { forwardDeepseek } from './providers/deepseek.js';
import { forwardAnthropic } from './providers/anthropic.js';
import { forwardCodex } from './providers/codex.js';
import { metering } from './metering.js';

type Provider = 'deepseek' | 'anthropic' | 'codex';

/**
 * Routing:
 *   /v1/messages*, /v1/complete   → Anthropic (Claude subscription credentials)
 *   /v1/responses*                → Codex (ChatGPT subscription credentials)
 *   everything else under /v1/*   → DeepSeek (your own API key, OpenAI-compatible)
 *
 * An x-gateway-provider header names one explicitly and overrides the inference above.
 */
function routeOf(path: string, override?: string): Provider {
  if (override === 'deepseek' || override === 'anthropic' || override === 'codex') return override;
  const p = path.split('?')[0] ?? '';
  if (p.startsWith('/v1/messages') || p === '/v1/complete') return 'anthropic';
  if (p.startsWith('/v1/responses')) return 'codex';
  return 'deepseek';
}

/** The subscription allowance is shared, so concurrency is capped */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.queue.push(r));
    this.active++;
  }
  release(): void {
    this.active--;
    this.queue.shift()?.();
  }
}

async function main(): Promise<void> {
  assertSafeToListen();

  const app = Fastify({
    logger: { level: process.env['LOG_LEVEL'] ?? 'info' },
    bodyLimit: 64 * 1024 * 1024,
  });

  // The bytes are forwarded as they arrive, so Fastify must not parse the body
  app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  const claudeStore = new ClaudeCredentialStore();
  const codexStore = new CodexCredentialStore();
  const sem = new Semaphore(config.maxConcurrent);

  app.get('/health', async () => ({ status: 'ok' }));

  app.get('/ready', async (_req, reply) => {
    const claude = claudeStore.status();
    const codex = codexStore.status();
    const deepseek = {
      provider: 'deepseek',
      ok: Boolean(config.deepseekApiKey),
      ...(config.deepseekApiKey ? {} : { error: 'DEEPSEEK_API_KEY is not configured' }),
    };
    const ok = claude['ok'] || codex['ok'] || deepseek.ok;
    return reply.code(ok ? 200 : 503).send({
      status: ok ? 'ready' : 'not_ready',
      claude,
      codex,
      deepseek,
    });
  });

  /** A usage summary, which the original Python version had no equivalent of */
  app.get('/usage', { onRequest: requireGatewayToken }, async () => ({
    summary: metering.summary(),
  }));

  app.all('/v1/*', { onRequest: requireGatewayToken }, async (req, reply) => {
    const provider = routeOf(req.url, req.headers['x-gateway-provider'] as string | undefined);
    const body = Buffer.isBuffer(req.body) ? req.body : null;

    await sem.acquire();
    try {
      if (provider === 'anthropic') {
        await forwardAnthropic(req, reply, body, claudeStore);
      } else if (provider === 'codex') {
        await forwardCodex(req, reply, body, codexStore);
      } else {
        await forwardDeepseek(req, reply, body);
      }
    } finally {
      sem.release();
    }
  });

  await app.listen({ port: config.port, host: config.host });
  app.log.info(
    `Credential gateway ready  max-concurrency=${config.maxConcurrent}  ` +
      `auth=${config.tokens.length ? 'on' : 'off'}  metering=${config.meteringEnabled ? 'on' : 'off'}`,
  );

  const shutdown = async (sig: string): Promise<void> => {
    app.log.info(`Got ${sig}, shutting down…`);
    await app.close().catch(() => undefined);
    metering.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

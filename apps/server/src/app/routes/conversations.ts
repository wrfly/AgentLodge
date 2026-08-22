import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { liveStartSeq, subscribe } from '../../core/events.js';
import { defaultAgent, isAgentId, isEnabledAgent } from '../agents/registry.js';
import * as convRepo from '../../core/db/conversations.js';
import * as turns from '../turns.js';
import * as quota from '../../core/quota.js';
import { requireUser } from '../../core/auth/guard.js';
import { consumeStreamTicket } from '../../core/auth/tokens.js';
import * as workspace from '../workspace.js';
import { tr } from '../../core/i18n/locale.js';

const guard = { preHandler: requireUser };

export function registerConversationRoutes(app: FastifyInstance): void {
  app.get('/api/conversations', guard, async (req) => {
    const { agent } = req.query as { agent?: string };
    return convRepo.list(req.user!.id, isAgentId(agent) ? agent : undefined);
  });

  app.post('/api/conversations', guard, async (req, reply) => {
    const body = (req.body ?? {}) as {
      title?: string;
      agent?: string;
      model?: string;
      effort?: string;
    };
    const conv = convRepo.create({
      userId: req.user!.id,
      // A disabled agent takes no new conversations: one created there could not be opened
      // and would just be an unreachable row in the list
      agent: isAgentId(body.agent) && isEnabledAgent(body.agent) ? body.agent : defaultAgent(),
      title: body.title,
      model: body.model,
      effort: body.effort,
    });
    reply.code(201);
    return conv;
  });

  app.get('/api/conversations/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = convRepo.full(id, req.user!.id);
    if (!conv) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    return { ...conv, busy: turns.isBusy(id) };
  });

  app.patch('/api/conversations/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { title?: string; model?: string; effort?: string };
    const patch: convRepo.Patch = {};
    if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim();
    // Changing model or effort affects later turns only; existing messages are untouched
    if (typeof body.model === 'string') patch.model = body.model.trim();
    if (typeof body.effort === 'string') patch.effort = body.effort.trim();

    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    convRepo.update(id, req.user!.id, patch);
    return convRepo.full(id, req.user!.id);
  });

  app.delete('/api/conversations/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    turns.abortConversation(id);
    convRepo.remove(id, req.user!.id);
    // The working directory goes with it, or disk use only ever grows
    await fs.rm(turns.workspaceDir(req.user!.id, id), { recursive: true, force: true });
    return reply.code(204).send();
  });

  /* ---------------- Sending and interrupting ---------------- */

  app.post('/api/conversations/:id/messages', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: tr(req, 'The message is empty') });
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (turns.isBusy(id)) return reply.code(409).send({ error: tr(req, 'This conversation is already generating') });

    try {
      const { turnId, userMessage } = await turns.startTurn(id, req.user!.id, text);
      reply.code(202);
      return { turnId, userMessage };
    } catch (err) {
      if (err instanceof turns.QuotaExceededError) {
        return reply.code(402).send({ error: err.message, quota: err.status });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post('/api/conversations/:id/abort', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (!turns.abortConversation(id))
      return reply.code(404).send({ error: tr(req, 'Nothing is running in this conversation') });
    return { ok: true };
  });

  /* ---------------- SSE ---------------- */

  app.get('/api/conversations/:id/stream', (req, reply) => {
    const { id } = req.params as { id: string };
    const query = req.query as { ticket?: string; lastEventId?: string };

    // The frontend streams with fetch and sends Authorization; the ticket is the fallback for
    // EventSource and anything like it
    const userId = req.user?.id ?? (query.ticket ? consumeStreamTicket(query.ticket) : null);
    if (!userId) {
      void reply.code(401).send({ error: tr(req, 'Not signed in') });
      return;
    }
    if (!convRepo.exists(id, userId)) {
      void reply.code(404).send({ error: tr(req, 'No such conversation') });
      return;
    }

    const headerId = req.headers['last-event-id'];
    const resumeId = (Array.isArray(headerId) ? headerId[0] : headerId) ?? query.lastEventId;
    // A Last-Event-ID means this is a reconnect, so resume from there; otherwise replay only
    // the turn currently running
    const afterSeq = resumeId !== undefined ? Number(resumeId) : liveStartSeq(id);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    const unsubscribe = subscribe(id, Number.isFinite(afterSeq) ? afterSeq : 0, (item) => {
      reply.raw.write(`id: ${item.seq}\ndata: ${JSON.stringify(item.event)}\n\n`);
    });

    const heartbeat = setInterval(() => {
      reply.raw.write(`data: ${JSON.stringify({ type: 'heartbeat', ts: Date.now() })}\n\n`);
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
    };
    req.raw.on('close', cleanup);
    req.raw.on('error', cleanup);
  });

  /** Checked before sending, so the composer can be disabled when the quota is short */
  app.get('/api/conversations/:id/quota', guard, async (req) => quota.status(req.user!.id));

  /** Export as Markdown */
  app.get('/api/conversations/:id/export', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = convRepo.full(id, req.user!.id);
    if (!conv) return reply.code(404).send({ error: tr(req, 'No such conversation') });

    const md = conversationToMarkdown(conv as never);
    const name = `${conv.title.replace(/[/\\:*?"<>|]/g, '_').slice(0, 60)}.md`;
    reply.header('content-type', 'text/markdown; charset=utf-8');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(name)}`);
    return md;
  });

  /* ---------------- Workspace files ---------------- */

  app.get('/api/conversations/:id/files', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    return workspace.list(req.user!.id, id);
  });

  app.get('/api/conversations/:id/files/preview', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: rel } = req.query as { path?: string };
    if (!rel) return reply.code(400).send({ error: tr(req, 'Missing path') });
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    const p = await workspace.preview(req.user!.id, id, rel);
    if (!p) return reply.code(404).send({ error: tr(req, 'No such file') });
    return p;
  });

  // A download goes through <a download>, which cannot send an Authorization header, so a
  // single-use ticket is accepted here too
  app.get('/api/conversations/:id/files/download', async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: rel, ticket } = req.query as { path?: string; ticket?: string };
    const userId = req.user?.id ?? (ticket ? consumeStreamTicket(ticket) : null);
    if (!userId) return reply.code(401).send({ error: tr(req, 'Not signed in') });
    if (!rel) return reply.code(400).send({ error: tr(req, 'Missing path') });
    if (!convRepo.exists(id, userId)) return reply.code(404).send({ error: tr(req, 'No such conversation') });

    const abs = await workspace.resolveInside(userId, id, rel);
    if (!abs) return reply.code(400).send({ error: tr(req, 'Invalid path') });

    // Opened with O_NOFOLLOW and measured through the handle: a symlink is refused by the
    // kernel, and the size reported is the size of the file being sent, with no window in
    // between for it to become something else
    const handle = await fs.open(abs, workspace.O_READ_NOFOLLOW).catch(() => null);
    if (!handle) return reply.code(404).send({ error: tr(req, 'No such file') });
    const stat = await handle.stat().catch(() => null);
    if (!stat?.isFile()) {
      await handle.close();
      return reply.code(404).send({ error: tr(req, 'No such file') });
    }

    const name = path.basename(abs);
    reply.header('content-type', 'application/octet-stream');
    reply.header('content-length', String(stat.size));
    // A filename may contain non-ASCII, so it is encoded per RFC 5987
    reply.header(
      'content-disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    );
    return reply.send(handle.createReadStream({ autoClose: true }));
  });

  app.post('/api/conversations/:id/files', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });

    const uploaded: string[] = [];
    const dir = turns.workspaceDir(req.user!.id, id);
    await fs.mkdir(dir, { recursive: true });

    try {
      for await (const part of req.parts()) {
        if (part.type !== 'file') continue;
        const name = workspace.safeFileName(part.filename);
        const dest = await workspace.resolveInside(req.user!.id, id, name);
        if (!dest) continue;
        // O_NOFOLLOW, or an agent that dropped a symlink here first gets whatever it aimed
        // at truncated and overwritten with the upload — as app's uid, in app's filesystem
        const out = await fs.open(dest, workspace.O_WRITE_NOFOLLOW).catch(() => null);
        if (!out) continue;
        await pipeline(part.file, out.createWriteStream());
        if (part.file.truncated) {
          await fs.rm(dest, { force: true });
          return reply
            .code(413)
            .send({
              error: tr(req, 'The file is over the {mb}MB limit', {
                mb: workspace.MAX_UPLOAD_BYTES / 1024 / 1024,
              }),
            });
        }
        uploaded.push(name);
      }
    } catch (err) {
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }

    if (!uploaded.length) return reply.code(400).send({ error: tr(req, 'No file was received') });
    return { uploaded, files: await workspace.list(req.user!.id, id) };
  });

  app.delete('/api/conversations/:id/files', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { path: rel } = req.query as { path?: string };
    if (!rel) return reply.code(400).send({ error: tr(req, 'Missing path') });
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (!(await workspace.remove(req.user!.id, id, rel)))
      return reply.code(400).send({ error: tr(req, 'Invalid path') });
    return { ok: true, files: await workspace.list(req.user!.id, id) };
  });
}

/** Render a conversation as Markdown, for keeping or sharing */
export function conversationToMarkdown(conv: {
  title: string;
  agent: string;
  model?: string;
  createdAt: string;
  messages: Array<{
    role: string;
    blocks: Array<Record<string, unknown>>;
    usage?: { inputTokens: number; outputTokens: number } | undefined;
  }>;
}): string {
  const lines: string[] = [
    `# ${conv.title}`,
    '',
    `> ${conv.agent}${conv.model ? ` · ${conv.model}` : ''} · ${new Date(conv.createdAt).toLocaleString('zh-CN')}`,
    '',
  ];

  for (const m of conv.messages) {
    lines.push(m.role === 'user' ? '## Me' : '## Assistant', '');
    for (const b of m.blocks) {
      const kind = b.kind as string;
      if (kind === 'text') {
        lines.push(String(b.text ?? ''), '');
      } else if (kind === 'thinking') {
        lines.push('<details><summary>Thought process</summary>', '', String(b.text ?? ''), '', '</details>', '');
      } else if (kind === 'tool_use') {
        const input = JSON.stringify(b.input ?? {}, null, 2);
        const result = (b.result as { content?: string } | undefined)?.content ?? '';
        lines.push(
          `<details><summary>🔧 ${String(b.toolName)}</summary>`,
          '',
          '```json',
          input.slice(0, 4000),
          '```',
          '',
          ...(result ? ['```', result.slice(0, 4000), '```', ''] : []),
          '</details>',
          '',
        );
      }
    }
    if (m.usage) {
      lines.push(`<sub>↑ ${m.usage.inputTokens} · ↓ ${m.usage.outputTokens}</sub>`, '');
    }
  }
  return lines.join('\n');
}

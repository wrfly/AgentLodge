import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { FastifyInstance } from 'fastify';
import { currentSeq, dropChannel, liveStartSeq, subscribe } from '../../core/events.js';
import { defaultAgent, isAgentId, isEnabledAgent } from '../agents/registry.js';
import * as convRepo from '../../core/db/conversations.js';
import { getString } from '../../core/db/settings.js';
import * as usageRepo from '../../core/db/usage.js';
import * as trimsRepo from '../../core/db/trims.js';
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
      thinking?: boolean;
    };
    const conv = convRepo.create({
      userId: req.user!.id,
      // A disabled agent takes no new conversations: one created there could not be opened
      // and would just be an unreachable row in the list
      agent: isAgentId(body.agent) && isEnabledAgent(body.agent) ? body.agent : defaultAgent(),
      title: body.title,
      model: body.model,
      effort: body.effort,
      thinking: body.thinking,
    });
    reply.code(201);
    return conv;
  });

  app.get('/api/conversations/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = convRepo.full(id, req.user!.id);
    if (!conv) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    return { ...conv, busy: turns.isBusy(id, req.user!.id) };
  });

  app.patch('/api/conversations/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as {
      title?: string;
      model?: string;
      effort?: string;
      thinking?: boolean;
    };
    const patch: convRepo.Patch = {};
    if (typeof body.title === 'string' && body.title.trim()) {
      patch.title = body.title.trim();
      // Named by hand, so the summariser leaves it alone from here on
      patch.titleCustom = true;
    }
    // Changing model, effort or thinking affects later turns only; existing messages are
    // untouched — the ticket a turn runs on carries the values it started with
    if (typeof body.model === 'string') patch.model = body.model.trim();
    if (typeof body.effort === 'string') patch.effort = body.effort.trim();
    if (typeof body.thinking === 'boolean') patch.thinking = body.thinking;

    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    convRepo.update(id, req.user!.id, patch);
    return convRepo.full(id, req.user!.id);
  });

  app.delete('/api/conversations/:id', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conv = convRepo.meta(id, req.user!.id);
    if (!conv) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    /*
     * The threads go first, and they have to: `abortConversation` stops one conversation now
     * that a thread runs beside its parent rather than instead of it. Without this the
     * thread's CLI keeps running, `fs.rm` below pulls the working directory out from under
     * it mid-turn, and when it finishes `appendMessage` finds no conversation and drops the
     * answer silently — a process still burning the user's quota for nobody.
     */
    for (const child of conv.parentId ? [] : convRepo.listThreads(id, req.user!.id)) {
      turns.abortConversation(child.id);
      dropChannel(child.id);
    }
    turns.abortConversation(id);
    convRepo.remove(id, req.user!.id);
    dropChannel(id);
    // The working directory goes with it, or disk use only ever grows. A sub-conversation
    // does not have one of its own — its directory is the parent's, and deleting the child
    // has to leave the parent's files alone. (Deleting the parent takes the directory, and
    // the cascade takes the children's rows with it.)
    if (!conv.parentId) {
      await fs.rm(turns.workspaceDir(req.user!.id, id), { recursive: true, force: true });
    }
    return reply.code(204).send();
  });

  /* ---------------- Sending and interrupting ---------------- */

  app.post('/api/conversations/:id/messages', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: tr(req, 'The message is empty') });
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (turns.isBusy(id, req.user!.id)) return reply.code(409).send({ error: tr(req, 'This conversation is already generating') });

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

  /**
   * Correct the newest question. The answer to it goes, and the corrected question is asked
   * in its place.
   *
   * The newest, and nothing earlier. Editing something from several turns back used to branch
   * the conversation, and the semantics did not survive having a workspace: the agent had
   * spent those turns reading files, writing code, running commands, and none of that can be
   * rewound. A branch at turn three carrying turn ten's directory is a conversation whose
   * agent is looking at code it never wrote. Asking about an older passage is what a thread
   * is for — it asks from here about back there, which is what actually happened.
   */
  app.post('/api/conversations/:id/messages/:messageId/edit', guard, async (req, reply) => {
    const { id, messageId } = req.params as { id: string; messageId: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: tr(req, 'The message is empty') });
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (turns.isBusy(id)) return reply.code(409).send({ error: tr(req, 'This conversation is already generating') });

    const at = convRepo.messageAt(id, req.user!.id, messageId);
    if (!at) return reply.code(404).send({ error: tr(req, 'No such message') });
    if (at.role !== 'user') return reply.code(400).send({ error: tr(req, 'Only a question can be edited') });

    const last = convRepo.lastUserMessage(id, req.user!.id);
    if (last?.id !== messageId) {
      return reply.code(400).send({
        error: tr(req, 'Only the newest question can be edited. Select the passage and open a thread instead.'),
      });
    }

    try {
      // The question and whatever was answered to it
      const cut = convRepo.truncateFrom(id, req.user!.id, at.seq);
      let rules: string[] = [];
      try {
        rules = rememberDiscarded(id, cut);
        const { turnId, userMessage } = await turns.startTurn(id, req.user!.id, text);
        reply.code(202);
        return { turnId, userMessage };
      } catch (err) {
        // The turn never started — a quota that ran out, an engine that is down — so the
        // question goes back. It is the only copy, and answering 402 over the space where it
        // used to be loses what somebody typed for a reason that has nothing to do with it.
        convRepo.restoreMessages(id, req.user!.id, cut);
        // And so do the rules. Restoring the answer without them leaves it on screen and in
        // the database while the gateway cuts it out of every later request — a conversation
        // the model cannot see, with nothing to undo it.
        trimsRepo.forget(id, rules);
        throw err;
      }
    } catch (err) {
      if (err instanceof turns.QuotaExceededError) {
        return reply.code(402).send({ error: err.message, quota: err.status });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Ask the newest question again, optionally somewhere else.
   *
   * The model and effort are part of it on purpose: the usual reason to retry is that the
   * answer was not good enough, and the usual next move is a bigger model. Making that one
   * action rather than "change the setting, then retry" is the difference between the button
   * being useful and being a refresh.
   */
  app.post('/api/conversations/:id/retry', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { model?: string; effort?: string };
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (turns.isBusy(id)) return reply.code(409).send({ error: tr(req, 'This conversation is already generating') });

    const last = convRepo.lastUserMessage(id, req.user!.id);
    if (!last) return reply.code(400).send({ error: tr(req, 'There is nothing to retry yet') });
    const text = last.blocks.map((b) => (b.kind === 'text' ? b.text : '')).join('').trim();
    if (!text) return reply.code(400).send({ error: tr(req, 'There is nothing to retry yet') });

    const settings = {
      ...(body.model !== undefined ? { model: body.model } : {}),
      ...(body.effort !== undefined ? { effort: body.effort } : {}),
    };

    try {
      // The question goes too, and is asked again — `startTurn` is the only thing that stores
      // one, and a retry that left the old row behind would show it twice
      const cut = convRepo.truncateFrom(id, req.user!.id, last.seq);
      const before = convRepo.meta(id, req.user!.id);
      let rules: string[] = [];
      try {
        rules = rememberDiscarded(id, cut);
        // The retry has to run on the model it was retried *with*, so this lands before the
        // turn — and comes back off below if the turn never started. It used to be written
        // outside the try, where a refusal left the conversation on a model the interface
        // never showed, and the next question went to it silently.
        if (Object.keys(settings).length) convRepo.update(id, req.user!.id, settings);
        const { turnId, userMessage } = await turns.startTurn(id, req.user!.id, text);
        reply.code(202);
        return { turnId, userMessage };
      } catch (err) {
        convRepo.restoreMessages(id, req.user!.id, cut);
        trimsRepo.forget(id, rules);
        // Only the keys the retry set, and an empty string where there was nothing before —
        // `update` ignores undefined, so passing it through would leave the new value standing
        if (before && Object.keys(settings).length) {
          convRepo.update(id, req.user!.id, {
            ...(settings.model !== undefined ? { model: before.model ?? '' } : {}),
            ...(settings.effort !== undefined ? { effort: before.effort ?? '' } : {}),
          });
        }
        throw err;
      }
    } catch (err) {
      if (err instanceof turns.QuotaExceededError) {
        return reply.code(402).send({ error: err.message, quota: err.status });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * Open a sub-conversation on a selection.
   *
   * A sub-conversation is a thread on the same work: it shares the parent's working
   * directory and CLI session — the model keeps everything it already knew — and the
   * selection becomes its first question. It is not a branch; nothing is copied, and the
   * two conversations see each other's turns through the shared transcript.
   *
   * A thread runs beside the conversation, not instead of it. It has its own session, so
   * there is nothing shared to wedge and no reason to ask whether the parent is busy —
   * asking a side question while the main answer is still coming is the case the feature
   * exists for. `startTurn` still refuses a second turn in the thread itself.
   */
  /** The quoted part of a thread's opening prompt, without the `>` markers */
  const quotedPassage = (text: string): string =>
    text
      .split('\n')
      .filter((l) => l.startsWith('>'))
      .map((l) => l.replace(/^>\s?/, ''))
      .join(' ')
      .trim();

  app.post('/api/conversations/:id/sub', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = (req.body ?? {}) as { text?: string };
    const text = (body.text ?? '').trim();
    if (!text) return reply.code(400).send({ error: tr(req, 'The message is empty') });
    const parent = convRepo.meta(id, req.user!.id);
    if (!parent) return reply.code(404).send({ error: tr(req, 'No such conversation') });

    const child = convRepo.create({
      userId: req.user!.id,
      agent: parent.agent,
      model: parent.model,
      effort: parent.effort,
      thinking: parent.thinking,
      parentId: id,
    });

    /*
     * The conversation so far, as text, because the thread does not resume its session.
     *
     * Sharing the session made the two one transcript in the model's eyes: a few side
     * questions were enough to fill the parent's context with a discussion nobody meant to
     * have there, and it only got heavier with use. A separate session cannot be polluted,
     * and this is what it costs — the words, re-sent once, without the tool calls.
     */
    const prior = turns.recentTranscript(convRepo.full(id, req.user!.id)?.messages ?? []);
    const prompt = prior
      ? `The conversation this question comes from, which you did not take part in:\n\n${prior}\n\n---\n\n${text}`
      : text;

    try {
      const { turnId, userMessage } = await turns.startTurn(child.id, req.user!.id, prompt);
      /*
       * What went to the model is the question with the conversation wrapped around it; what
       * belongs in the record is the question. Returned as rewritten too — the caller renders
       * this straight into the panel, and handing back the pre-rewrite object would put the
       * whole replay in the reader's first bubble.
       */
      convRepo.rewriteMessage(child.id, req.user!.id, userMessage.id, text);
      /*
       * Named after the passage, not the prompt. The stored question is a markdown quotation
       * followed by a question, so a title taken from it whole reads "> directories Tell me
       * more about this." — the quote markers and, on every thread nobody retyped the
       * default, the same boilerplate sentence.
       */
      convRepo.retitle(child.id, convRepo.deriveTitle(quotedPassage(text) || text));
      reply.code(202);
      return {
        conversationId: child.id,
        turnId,
        userMessage: { ...userMessage, blocks: [{ kind: 'text' as const, blockId: 0, text }] },
        conversation: convRepo.full(child.id, req.user!.id),
      };
    } catch (err) {
      /*
       * The row was created before the turn, because the turn needs somewhere to put its
       * messages. A turn that never starts leaves it empty, and an empty thread is not
       * something anybody can act on: no question to read, no answer to wait for, and the
       * panel that lists threads has no way to delete one. Three refused clicks used to mean
       * three of them in the list for good.
       */
      convRepo.remove(child.id, req.user!.id);
      if (err instanceof turns.QuotaExceededError) {
        return reply.code(402).send({ error: err.message, quota: err.status });
      }
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /**
   * The threads opened inside this conversation.
   *
   * Threads are deliberately absent from the sidebar — a thread is part of the conversation
   * it was opened in, not a conversation of its own — which left them with no way back once
   * their panel was closed. They are listed from here instead.
   */
  app.get('/api/conversations/:id/threads', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id))
      return reply.code(404).send({ error: tr(req, 'No such conversation') });
    return convRepo.listThreads(id, req.user!.id);
  });

  app.post('/api/conversations/:id/abort', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id)) return reply.code(404).send({ error: tr(req, 'No such conversation') });
    if (!turns.abortConversation(id, req.user!.id))
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
    // the turn currently running. An id past the current sequence belongs to a channel that
    // has since been dropped and made afresh (events.ts sweeps idle ones), so as far as
    // replay is concerned this is a first connection.
    const resumeSeq = resumeId !== undefined ? Number(resumeId) : NaN;
    const afterSeq =
      Number.isFinite(resumeSeq) && resumeSeq <= currentSeq(id) ? resumeSeq : liveStartSeq(id);

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
  /**
   * What this conversation has cost, split by the model that answered.
   *
   * From `usage_records` and the price table, which is where the usage page and the quota
   * read from too. The header used to add up what the CLI reported spending, so the same
   * conversation carried two different figures in two different currencies depending on
   * which page you were looking at.
   */
  app.get('/api/conversations/:id/usage', guard, async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!convRepo.exists(id, req.user!.id))
      return reply.code(404).send({ error: tr(req, 'No such conversation') });
    return {
      currency: getString('billing.currency', 'USD'),
      byModel: usageRepo.byModelForConversation(id),
    };
  });

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

/**
 * The pieces of an answer the gateway can recognise on the wire, one rule each.
 *
 * A stored assistant row is one *turn*; a turn is several wire messages, split wherever the
 * model stopped to call a tool. Joining every text block gave a string no single wire message
 * ever equals — "I'll read it.The answer is 42." — so the rule matched nothing and the
 * discarded answer went upstream intact on every turn that used a tool, which for a coding
 * agent is most of them.
 *
 * Each text block is its own rule instead, because each is what one wire message says.
 */
/**
 * Tell the gateway to stop sending the answers we just deleted.
 *
 * Only what was actually cut. It used to ask for the newest assistant row in the whole
 * conversation, with no check that the row was inside the cut — so after a turn that died
 * without storing an answer (a server restart mid-stream, an error path) the newest answer
 * was an *earlier* one, still on screen and legitimately in the CLI's transcript, and it got
 * a rule that removed it from every later request for good.
 */
function rememberDiscarded(
  conversationId: string,
  cut: Array<{ role: string; blocks: Array<{ kind?: string; text?: string }> }>,
): string[] {
  const written: string[] = [];
  for (const m of cut) {
    if (m.role !== 'assistant') continue;
    for (const rule of trimRulesFor(m)) {
      if (trimsRepo.add(conversationId, rule)) written.push(rule);
    }
  }
  return written;
}

function trimRulesFor(m: { blocks: Array<{ kind?: string; text?: string }> }): string[] {
  const seen = new Set<string>();
  for (const b of m.blocks) {
    if (b.kind !== 'text') continue;
    const text = (b.text ?? '').trim();
    if (text) seen.add(text);
  }
  return [...seen];
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

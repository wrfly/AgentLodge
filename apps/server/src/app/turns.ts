import path from 'node:path';
import fs from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import crypto from 'node:crypto';
import { config, paths } from '../core/config.js';
import { publish } from '../core/events.js';
import { getAdapter } from './agents/registry.js';
import { gatewayEnabled } from './agents/provider.js';
import * as containers from './containers.js';
import { signRuntimeToken } from '../core/runtime-token.js';
import type { RunningTurn, TurnResult } from './agents/types.js';
import * as convRepo from '../core/db/conversations.js';
import * as usageRepo from '../core/db/usage.js';
import * as memory from './memory.js';
import * as quota from '../core/quota.js';
import * as usersRepo from '../core/db/users.js';
import * as mail from './mail.js';
import * as recap from './recap.js';
import { getString } from '../core/db/settings.js';
import type { MessageBlock, StoredMessage } from '../core/protocol.js';

/**
 * Email a warning once usage passes 90%, at most once per period.
 *
 * Done asynchronously after the turn, so it does not hold up the conversation.
 */
async function maybeWarnQuota(userId: string): Promise<void> {
  const status = quota.status(userId);
  if (!status.warning) return;

  // Whichever window is closest to refusing is the one worth writing about
  const hit = status.tightest ? status.windows[status.tightest] : null;
  if (!hit || hit.limit === null) return;

  const q = usersRepo.getQuota(userId);
  // One mail per window, not per period: the key names the window and the instant it began
  const key = `${hit.scope}:${hit.startsAt}`;
  if (q.warnedPeriod === key) return;

  const user = usersRepo.findById(userId);
  if (!user) return;

  // Mark before sending: a failure is not retried, so nobody gets nagged repeatedly
  usersRepo.markWarned(userId, key);
  const base = getString('app.baseUrl', 'http://localhost:5173');
  // The refusal's own formatter, so the mail and the refusal cannot spell one number two ways
  const { unit, amount } = quota.amountIn(status.limitKind, status.currency);
  const tpl = mail.quotaWarningMail({
    username: user.username,
    used: amount(hit.used),
    limit: amount(hit.limit),
    unit,
    window: quota.scopeLabel(hit.scope),
    pct: Math.round((hit.used / hit.limit) * 100),
    link: `${base}/usage`,
  });
  await mail.send({ to: user.email, ...tpl, link: `${base}/usage` });
}

interface ActiveTurn {
  turnId: string;
  conversationId: string;
  userId: string;
  running: RunningTurn;
}

/** One turn per conversation at a time — a CLI's resume cannot write the same session concurrently */
const active = new Map<string, ActiveTurn>();
const byTurnId = new Map<string, ActiveTurn>();

/**
 * Whether any turn is running in the conversation's family.
 *
 * A sub-conversation shares its parent's CLI session, and a session has one transcript —
 * two members writing to it concurrently would interleave and corrupt it. So "busy" is a
 * family question: a turn in the sub makes the parent busy and vice versa.
 */
export function isBusy(conversationId: string, userId?: string): boolean {
  if (!userId) return active.has(conversationId);
  for (const id of convRepo.familyIds(conversationId, userId)) {
    if (active.has(id)) return true;
  }
  return false;
}

export function activeCountForUser(userId: string): number {
  let n = 0;
  for (const t of active.values()) if (t.userId === userId) n += 1;
  return n;
}

/** Stop whichever member of the family is generating */
export function abortConversation(conversationId: string, userId?: string): boolean {
  if (!userId) {
    const t = active.get(conversationId);
    if (!t) return false;
    t.running.abort();
    return true;
  }
  let aborted = false;
  for (const id of convRepo.familyIds(conversationId, userId)) {
    const t = active.get(id);
    if (!t) continue;
    t.running.abort();
    aborted = true;
  }
  return aborted;
}

export function abortTurn(turnId: string): boolean {
  const t = byTurnId.get(turnId);
  if (!t) return false;
  t.running.abort();
  return true;
}

/**
 * What each CLI says when the session it was asked to resume no longer exists.
 *
 * The state does not heal itself: the session id is in the database and every turn tries to
 * resume with it again, so the conversation is wedged for good. It happens when a container
 * is removed and rebuilt, when HOME is wiped, or across a major CLI upgrade. (Persisting
 * HOME made it far rarer, not impossible — hence the handling.)
 */
function isResumeLost(result: TurnResult): boolean {
  if (result.aborted || !result.error || result.blocks.length > 0) return false;
  const e = result.error.toLowerCase();
  return (
    e.includes('no rollout found') || // codex
    e.includes('no conversation found') ||
    e.includes('error_during_execution') || // what claude says when the resume target is gone
    e.includes('session not found')
  );
}

/** A note in front of the answer after starting over, or it just looks as though the agent lost its memory */
function withResumeLostNotice(blocks: MessageBlock[]): MessageBlock[] {
  const notice: MessageBlock = {
    kind: 'text',
    blockId: 0,
    text:
      '> ⚠️ The CLI session record from the previous turn is gone (the container was '
      + 'rebuilt), so this turn starts from an empty context.\n\n',
  };
  return [notice, ...blocks.map((b) => ({ ...b, blockId: b.blockId + 1 }))];
}

/**
 * A conversation's working directory: workspaces/<userId>/<convId>/
 *
 * A sub-conversation resolves to its root's directory: it shares the parent's files rather
 * than copying them, which is what makes a thread on the same work different from a branch.
 *
 * Its sibling, workspaces/<userId>/memory/, is the memory both CLIs read; see memory.ts.
 *
 * **Reads the database.** It used to be a path join and looks like one still, which caught
 * two path-only test suites that had never needed a connection. Callers outside a request —
 * tests, scripts — have to have called `initDb()`.
 */
export function workspaceDir(userId: string, conversationId: string): string {
  return path.join(paths.workspaces, userId, convRepo.rootOf(conversationId, userId));
}

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly status: quota.QuotaStatus,
  ) {
    super(message);
  }
}

/* ---------------- Forking ---------------- */

/**
 * Regenerable, and usually the bulk of a workspace by an order of magnitude. A fork that
 * copies them turns a cheap branch into a gigabyte.
 */
const NOT_WORTH_COPYING = new Set(['node_modules', '.venv', 'venv', '__pycache__', '.next', 'dist', 'build', 'target']);
/** Past this the copy is refused outright and the fork starts on an empty directory */
const MAX_FORK_BYTES = 200 * 1024 * 1024;

async function dirSize(root: string): Promise<number> {
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (NOT_WORTH_COPYING.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try {
          total += (await fs.stat(full)).size;
        } catch {
          /* vanished between readdir and stat */
        }
      }
      if (total > MAX_FORK_BYTES) return;
    }
  };
  await walk(root);
  return total;
}

/**
 * Copy what the source conversation built into the fork's own directory.
 *
 * Without it the forked agent is told it wrote a file and then cannot see it: the transcript
 * we replay says "created sort.py" while `ls` says otherwise, and every instruction that
 * refers to earlier work fails on a directory that does not contain it.
 *
 * Returns whether the files came across, because a fork that starts empty is a different
 * thing to be told about than one that did not.
 */
export async function copyWorkspace(from: string, to: string): Promise<boolean> {
  try {
    await fs.access(from);
  } catch {
    return false;                       // nothing was ever written there
  }
  if ((await dirSize(from)) > MAX_FORK_BYTES) return false;
  await fs.mkdir(to, { recursive: true });
  await fs.cp(from, to, {
    recursive: true,
    // A dangling symlink would abort the whole copy
    dereference: false,
    filter: (src) => !NOT_WORTH_COPYING.has(path.basename(src)),
  });
  return true;
}

/** What the forked agent is told happened before it existed */
export function transcript(messages: StoredMessage[]): string {
  const lines = messages.map((m) => {
    const text = m.blocks
      .map((b) => (b.kind === 'text' ? b.text : b.kind === 'thinking' ? '' : ''))
      .join('')
      .trim();
    if (!text) return '';
    return `${m.role === 'user' ? 'User' : 'You'}: ${text}`;
  });
  return lines.filter(Boolean).join('\n\n');
}

export interface ForkResult {
  conversationId: string;
  turnId: string;
  userMessage: StoredMessage;
  /** False when the source workspace was too large or never existed */
  filesCopied: boolean;
}

/**
 * Branch a conversation at one of its messages, with an edited version of that message.
 *
 * Editing something said several turns ago is not a correction, it is a different path from
 * that point — so it becomes its own conversation rather than rewriting one somebody may
 * still want. The two then diverge properly: separate CLI sessions, separate directories,
 * both still there.
 *
 * The agent's own memory cannot be branched — the CLI's session is an opaque handle and
 * there is no rewinding it — so the fork starts a new one and is handed the kept messages as
 * text. That is the words, not the doing: tool calls are not replayed, which is exactly why
 * the directory is copied instead.
 */
export async function forkAt(
  conversationId: string,
  userId: string,
  messageId: string,
  text: string,
): Promise<ForkResult> {
  const source = convRepo.meta(conversationId, userId);
  if (!source) throw new Error('No such conversation');
  const at = convRepo.messageAt(conversationId, userId, messageId);
  if (!at) throw new Error('No such message');
  if (at.role !== 'user') throw new Error('Only a question can be edited');

  const kept = convRepo.messagesBefore(conversationId, userId, at.seq);
  const fork = convRepo.create({
    userId,
    agent: source.agent,
    title: source.title,
    model: source.model,
    effort: source.effort,
    thinking: source.thinking,
  });

  const filesCopied = await copyWorkspace(
    workspaceDir(userId, conversationId),
    workspaceDir(userId, fork.id),
  );

  // Kept messages are copied verbatim so the branch reads as a whole conversation rather
  // than as an orphaned question
  for (const m of kept) {
    convRepo.appendMessage(fork.id, userId, {
      role: m.role,
      blocks: m.blocks,
      usage: m.usage,
      error: m.error,
      aborted: m.aborted,
      createdAt: m.createdAt,
    });
  }

  const prior = transcript(kept);
  const prompt = prior
    ? `The conversation so far, which you did not take part in:\n\n${prior}\n\n---\n\n${text}`
    : text;

  const { turnId, userMessage } = await startTurn(fork.id, userId, prompt);
  // The stored message is what the user actually asked, not the replay wrapped around it
  convRepo.rewriteMessage(fork.id, userId, userMessage.id, text);
  return { conversationId: fork.id, turnId, userMessage: { ...userMessage, blocks: [{ kind: 'text', blockId: 0, text }] }, filesCopied };
}

export interface StartTurnResult {
  turnId: string;
  userMessage: StoredMessage;
}

export async function startTurn(
  conversationId: string,
  userId: string,
  text: string,
): Promise<StartTurnResult> {
  const conv = convRepo.meta(conversationId, userId);
  if (!conv) throw new Error('No such conversation');
  if (isBusy(conversationId, userId)) throw new Error('This conversation is already generating');

  const verdict = quota.check(userId);
  if (!verdict.allow) {
    // Same trace the gateway leaves, so a refusal counts wherever it happened
    const hit = verdict.status.tightest ?? 'window';
    usageRepo.noteRefusal({
      userId,
      agent: conv.agent,
      scope: hit,
      windowStart: verdict.status.windows[hit].startsAt,
    });
    throw new QuotaExceededError(verdict.reason!, verdict.status);
  }

  const adapter = getAdapter(conv.agent);
  if (!adapter) throw new Error(`Unknown agent: ${conv.agent}`);

  const turnId = crypto.randomUUID();
  const cwd = workspaceDir(userId, conversationId);
  // Every turn: the agent may have written memory during the last one, the codex rendering
  // may be stale, and a new conversation has no link in it yet
  await memory.tidy(userId);
  await memory.snapshot(userId, 'agent');
  await memory.linkInto(cwd, userId);

  // A ticket is only signed when the gateway is enabled; with no active upstream the CLI
  // uses its own configuration
  const viaGateway = gatewayEnabled();
  const runtimeToken = viaGateway
    ? await signRuntimeToken(
        {
          sub: userId,
          cid: conversationId,
          tid: turnId,
          agent: conv.agent,
          thinking: conv.thinking,
        },
        config.runtimeTokenTtlMs,
      )
    : undefined;

  /*
   * Container mode: make sure this user's container is up and convert host paths to
   * container paths.
   *
   * Before the message is stored and before turn.started goes out. This is the one step
   * that can fail for reasons of its own — the engine down, the image missing — and it
   * used to run after both: the caller got a 500, the user's message was already in the
   * conversation, and the interface, told a turn had started and never told otherwise,
   * sat on "Thinking" until the page was reloaded.
   */
  let containerName: string | undefined;
  let containerCwd: string | undefined;
  if (containers.enabled()) {
    containerName = await containers.ensure(userId);
    containerCwd = containers.toContainerPath(userId, cwd);
    containers.touch(userId);
  }

  const isFirst = conv.messageCount === 0;
  const userMessage = convRepo.appendMessage(conversationId, userId, {
    role: 'user',
    blocks: [{ kind: 'text', blockId: 0, text }],
    createdAt: new Date().toISOString(),
  })!;

  /*
   * `turn.started` goes first, and the title after it, because that is the order a client
   * connecting late can still see both in.
   *
   * A first connection replays from `turn.started` (`liveStartSeq` in core/events.ts returns
   * its seq - 1) — anything published before it is not replayed at all. That was harmless
   * while the stream was always opened long before the first message. It is not any more:
   * the conversation is created by the first message now, so the client opens the stream and
   * posts the message back to back, and the server routinely handles the post before the SSE
   * route subscribes. Titled first, the derived title was dropped and the header read "New
   * chat" for the whole of the most-watched turn in the product.
   *
   * The client handles the two independently, so nothing cares that the turn now starts a
   * line before the conversation is named.
   */
  publish(conversationId, { type: 'turn.started', turnId });

  if (isFirst) {
    const title = convRepo.deriveTitle(text);
    convRepo.update(conversationId, userId, { title });
    publish(conversationId, { type: 'title.updated', conversationId, title });
  }

  const startRun = (resumeSessionId?: string) =>
    adapter.run({
      // The stored message is what the user wrote, and that is all the CLI is told. The
      // answer an edit or retry discarded still sits in the CLI's session, and the gateway
      // drops it from the request body instead of asking the model to ignore it — see
      // gateway/redo-trim.ts.
      prompt: text,
      cwd,
      containerName,
      containerCwd,
      memoryDir: containers.enabled() ? memory.containerDir() : memory.dir(userId),
      resumeSessionId,
      // No model on the conversation, then the active provider's default, then the
      // environment, then whatever the CLI decides
      // The conversation's own choice, then the default configured for this agent, then
      // whatever the CLI would use on its own
      model: conv.model || getString(`agent.${conv.agent}.defaultModel`) || config.model || undefined,
      effort: conv.effort || undefined,
      runtimeToken,
      onEvent: (e) => publish(conversationId, e),
      onSessionId: (sid) => {
        // Refreshed every turn: in some versions resume forks a new session id. Written to
        // the family root — the sub-conversation and its parent resume one session, so the
        // id has to live in the one place both read from.
        const root = convRepo.rootOf(conversationId, userId);
        if (convRepo.meta(root, userId)?.agentSessionId !== sid) {
          convRepo.update(root, userId, { agentSessionId: sid });
        }
      },
    });

  // An abort has to reach whichever process is actually running — there may be a second
  // attempt below. The session id is the root's: the sub-conversation resumes the same
  // session as its parent.
  const sessionId = convRepo.rootSessionId(conversationId, userId);
  let current = startRun(sessionId);
  const running: RunningTurn = {
    abort: () => current.abort(),
    done: (async () => {
      const first = await current.done;
      // The CLI's session record is gone — container rebuilt, CLI upgraded, HOME wiped —
      // and resuming again would produce the same error forever, wedging the conversation.
      // Drop the session id and start over: the CLI's context resets to nothing, but the
      // conversation can continue.
      if (!isResumeLost(first) || !sessionId) return first;
      console.warn(
        `[turns] ${conv.agent} could not resume ${sessionId}; starting a new session: ${first.error}`,
      );
      convRepo.update(convRepo.rootOf(conversationId, userId), userId, { agentSessionId: '' });
      current = startRun(undefined);
      const second = await current.done;
      if (second.error) return second;
      return { ...second, blocks: withResumeLostNotice(second.blocks) };
    })(),
  };

  const entry: ActiveTurn = { turnId, conversationId, userId, running };
  active.set(conversationId, entry);
  byTurnId.set(turnId, entry);

  void running.done
    .then((result) => {
      convRepo.appendMessage(conversationId, userId, {
        role: 'assistant',
        blocks: result.blocks,
        createdAt: new Date().toISOString(),
        usage: result.usage,
        error: result.error,
        aborted: result.aborted || undefined,
      });

      // Through the gateway, usage was already recorded per upstream call, and recording it
      // again here would bill twice. The CLI's own turn total is the fallback for when the
      // gateway is not in the path.
      if (!viaGateway) {
        usageRepo.record({
          userId,
          conversationId,
          turnId,
          agent: conv.agent,
          model: conv.model,
          effort: conv.effort,
          usage: result.usage,
          source: 'cli',
          status: result.aborted ? 'aborted' : result.error ? 'error' : 'completed',
        });
      }

      if (result.aborted) {
        publish(conversationId, { type: 'turn.aborted', turnId });
      } else if (result.error) {
        publish(conversationId, { type: 'turn.error', turnId, message: result.error });
      } else {
        publish(conversationId, {
          type: 'turn.completed',
          turnId,
          usage: result.usage ?? {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            costUsd: 0,
            durationMs: 0,
            numTurns: 0,
          },
        });
      }

      // Usage changed, so push the current quota to refresh the usage bar
      publish(conversationId, { type: 'quota.updated', quota: quota.status(userId) });
      void maybeWarnQuota(userId).catch(() => {});

      /*
       * Name it, if nothing has yet. Not awaited: the turn is over as far as the user is
       * concerned, and the name arrives over the event stream a second later. It is one
       * call per conversation ever — see recap.nameIfNeeded — and it is fired here rather
       * than on a timer because this is the moment the questions to name it from exist.
       */
      void recap
        .nameIfNeeded(userId, conversationId)
        .then((title) => {
          if (title) publish(conversationId, { type: 'title.updated', conversationId, title });
        })
        .catch(() => {});
    })
    .catch((err: unknown) => {
      publish(conversationId, {
        type: 'turn.error',
        turnId,
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      active.delete(conversationId);
      byTurnId.delete(turnId);
    });

  return { turnId, userMessage };
}

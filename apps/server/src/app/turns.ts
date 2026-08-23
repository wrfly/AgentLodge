import path from 'node:path';
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
import * as providersRepo from '../core/db/providers.js';
import * as usersRepo from '../core/db/users.js';
import * as mail from './mail.js';
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
  const tpl = mail.quotaWarningMail({
    username: user.username,
    used: hit.used,
    limit: hit.limit,
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

export function isBusy(conversationId: string): boolean {
  return active.has(conversationId);
}

export function activeCountForUser(userId: string): number {
  let n = 0;
  for (const t of active.values()) if (t.userId === userId) n += 1;
  return n;
}

export function abortConversation(conversationId: string): boolean {
  const t = active.get(conversationId);
  if (!t) return false;
  t.running.abort();
  return true;
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
 * Its sibling, workspaces/<userId>/memory/, is the memory both CLIs read; see memory.ts.
 */
export function workspaceDir(userId: string, conversationId: string): string {
  return path.join(paths.workspaces, userId, conversationId);
}

export class QuotaExceededError extends Error {
  constructor(
    message: string,
    readonly status: quota.QuotaStatus,
  ) {
    super(message);
  }
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
  if (active.has(conversationId)) throw new Error('This conversation is already generating');

  const verdict = quota.check(userId);
  if (!verdict.allow) throw new QuotaExceededError(verdict.reason!, verdict.status);

  const adapter = getAdapter(conv.agent);
  if (!adapter) throw new Error(`Unknown agent: ${conv.agent}`);

  const turnId = crypto.randomUUID();
  const cwd = workspaceDir(userId, conversationId);
  // Every turn: the agent may have written memory during the last one, the codex rendering
  // may be stale, and a new conversation has no link in it yet
  await memory.tidy(userId);
  await memory.snapshot(userId, 'agent');
  await memory.linkInto(cwd, userId);

  const isFirst = conv.messageCount === 0;
  const userMessage = convRepo.appendMessage(conversationId, userId, {
    role: 'user',
    blocks: [{ kind: 'text', blockId: 0, text }],
    createdAt: new Date().toISOString(),
  })!;

  if (isFirst) {
    const title = convRepo.deriveTitle(text);
    convRepo.update(conversationId, userId, { title });
    publish(conversationId, { type: 'title.updated', conversationId, title });
  }

  publish(conversationId, { type: 'turn.started', turnId });

  // A ticket is only signed when the gateway is enabled; with no active upstream the CLI
  // uses its own configuration
  const viaGateway = gatewayEnabled();
  const runtimeToken = viaGateway
    ? await signRuntimeToken(
        { sub: userId, cid: conversationId, tid: turnId, agent: conv.agent },
        config.runtimeTokenTtlMs,
      )
    : undefined;

  // Container mode: make sure this user's container is up and convert host paths to
  // container paths
  let containerName: string | undefined;
  let containerCwd: string | undefined;
  if (containers.enabled()) {
    containerName = await containers.ensure(userId);
    containerCwd = containers.toContainerPath(userId, cwd);
    containers.touch(userId);
  }

  const startRun = (resumeSessionId?: string) =>
    adapter.run({
      prompt: text,
      cwd,
      containerName,
      containerCwd,
      memoryDir: containers.enabled() ? memory.containerDir() : memory.dir(userId),
      resumeSessionId,
      // No model on the conversation, then the active provider's default, then the
      // environment, then whatever the CLI decides
      model: conv.model || providersRepo.active()?.defaultModel || config.model || undefined,
      effort: conv.effort || undefined,
      runtimeToken,
      onEvent: (e) => publish(conversationId, e),
      onSessionId: (sid) => {
        // Refreshed every turn: in some versions resume forks a new session id
        if (convRepo.meta(conversationId, userId)?.agentSessionId !== sid) {
          convRepo.update(conversationId, userId, { agentSessionId: sid });
        }
      },
    });

  // An abort has to reach whichever process is actually running — there may be a second
  // attempt below
  let current = startRun(conv.agentSessionId);
  const running: RunningTurn = {
    abort: () => current.abort(),
    done: (async () => {
      const first = await current.done;
      // The CLI's session record is gone — container rebuilt, CLI upgraded, HOME wiped —
      // and resuming again would produce the same error forever, wedging the conversation.
      // Drop the session id and start over: the CLI's context resets to nothing, but the
      // conversation can continue.
      if (!isResumeLost(first) || !conv.agentSessionId) return first;
      console.warn(
        `[turns] ${conv.agent} could not resume ${conv.agentSessionId}; starting a new session: ${first.error}`,
      );
      convRepo.update(conversationId, userId, { agentSessionId: '' });
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

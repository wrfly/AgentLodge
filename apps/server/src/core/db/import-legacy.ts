import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from '../config.js';
import { flag, get, nowIso, run, tx } from './index.js';
import type { StoredMessage } from '../protocol.js';

/**
 * A one-off import of the early JSON files into SQLite.
 *
 * The source directory is renamed to *.imported rather than deleted, so it is still there
 * if something went wrong. Rows whose id already exists are skipped, which makes repeated
 * starts safe.
 */

interface LegacyUser {
  id: string;
  email: string;
  username: string;
  passwordHash: string;
  role: string;
  status: string;
  inviteCodeId?: string;
  createdAt: string;
  lastLoginAt?: string;
  quota?: { tokenLimit: number | null };
}

interface LegacyInvite {
  id: string;
  code: string;
  createdBy?: string;
  note?: string;
  maxUses: number;
  usedCount: number;
  expiresAt?: string;
  presetRole: string;
  presetTokenLimit: number | null;
  disabled: boolean;
  createdAt: string;
}

interface LegacyConversation {
  id: string;
  userId: string;
  agent: string;
  title: string;
  agentSessionId?: string;
  model?: string;
  effort?: string;
  createdAt: string;
  updatedAt: string;
  messages: StoredMessage[];
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function importLegacy(): void {
  let users = 0;
  let invites = 0;
  let convs = 0;
  let msgs = 0;

  const authDir = path.join(config.dataDir, 'auth');

  // ---- users ----
  const legacyUsers = readJson<LegacyUser[]>(path.join(authDir, 'users.json')) ?? [];
  for (const u of legacyUsers) {
    if (get('select 1 as x from users where id = ?', u.id)) continue;
    if (get('select 1 as x from users where email = ?', u.email)) continue;
    run(
      `insert into users (id, email, username, password_hash, role, status, invite_code_id, created_at, last_login_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      u.id,
      u.email,
      u.username,
      u.passwordHash,
      u.role,
      u.status,
      u.inviteCodeId ?? null,
      u.createdAt,
      u.lastLoginAt ?? null,
    );
    run(
      `insert into user_quotas (user_id, token_limit, period, hard_stop, updated_at)
       values (?, ?, 'monthly', 1, ?)`,
      u.id,
      u.quota?.tokenLimit ?? null,
      nowIso(),
    );
    users += 1;
  }

  // ---- invite codes ----
  const legacyInvites = readJson<LegacyInvite[]>(path.join(authDir, 'invites.json')) ?? [];
  for (const i of legacyInvites) {
    if (get('select 1 as x from invite_codes where code = ?', i.code)) continue;
    run(
      `insert into invite_codes
         (id, code, created_by, note, max_uses, used_count, expires_at,
          preset_role, preset_token_limit, disabled, created_at)
       values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      i.id,
      i.code,
      i.createdBy ?? null,
      i.note ?? null,
      i.maxUses,
      i.usedCount,
      i.expiresAt ?? null,
      i.presetRole,
      i.presetTokenLimit,
      flag(i.disabled),
      i.createdAt,
    );
    invites += 1;
  }

  // Login sessions are not migrated: everyone signs in once more, which costs almost
  // nothing and is safer

  // ---- conversations and messages ----
  const convDir = paths.conversations;
  if (fs.existsSync(convDir)) {
    for (const f of fs.readdirSync(convDir)) {
      if (!f.endsWith('.json')) continue;
      const c = readJson<LegacyConversation>(path.join(convDir, f));
      if (!c?.id || !c.userId || !c.agent) continue;
      if (get('select 1 as x from conversations where id = ?', c.id)) continue;
      // No user (deleted by hand, say) means no import — the foreign key would refuse it
      if (!get('select 1 as x from users where id = ?', c.userId)) continue;

      tx(() => {
        run(
          `insert into conversations
             (id, user_id, agent, title, agent_session_id, model, effort, status, created_at, updated_at, last_message_at)
           values (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
          c.id,
          c.userId,
          c.agent,
          c.title,
          c.agentSessionId ?? null,
          c.model ?? null,
          c.effort ?? null,
          c.createdAt,
          c.updatedAt,
          c.messages.at(-1)?.createdAt ?? null,
        );
        c.messages.forEach((m, seq) => {
          run(
            `insert into messages (id, conversation_id, seq, role, blocks, usage, error, aborted, created_at)
             values (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            m.id,
            c.id,
            seq,
            m.role,
            JSON.stringify(m.blocks),
            m.usage ? JSON.stringify(m.usage) : null,
            m.error ?? null,
            flag(Boolean(m.aborted)),
            m.createdAt,
          );
          msgs += 1;

          // Backfill historical usage so the personal usage page has a history to draw
          if (m.role === 'assistant' && m.usage) {
            run(
              `insert into usage_records
                 (user_id, conversation_id, agent, model, effort,
                  input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens,
                  billable_tokens, cost_usd, duration_ms, num_turns, status, created_at, day)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              c.userId,
              c.id,
              c.agent,
              c.model ?? null,
              c.effort ?? null,
              m.usage.inputTokens,
              m.usage.cacheReadTokens,
              m.usage.cacheCreationTokens,
              m.usage.outputTokens,
              Math.round(
                m.usage.inputTokens +
                  m.usage.cacheReadTokens * 0.1 +
                  m.usage.cacheCreationTokens +
                  m.usage.outputTokens * 1.5,
              ),
              m.usage.costUsd,
              m.usage.durationMs,
              m.usage.numTurns,
              m.error ? 'error' : m.aborted ? 'aborted' : 'completed',
              m.createdAt,
              m.createdAt.slice(0, 10),
            );
          }
        });
      });
      convs += 1;
    }
  }

  if (users || invites || convs) {
    console.log(
      `[db] imported from JSON: ${users} users · ${invites} invite codes · ${convs} conversations · ${msgs} messages`,
    );
    // Archive the source so the next start does not scan it again
    for (const dir of [authDir, convDir]) {
      if (!fs.existsSync(dir)) continue;
      const archived = `${dir}.imported-${Date.now()}`;
      try {
        fs.renameSync(dir, archived);
        console.log(`[db] source directory archived as ${path.basename(archived)}`);
      } catch (err) {
        console.warn(`[db] could not archive ${dir} (harmless):`, err);
      }
    }
  }
}

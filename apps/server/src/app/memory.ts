import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../core/config.js';

/**
 * Per-user memory, the equivalent of Claude.ai's.
 *
 * Not implemented as prompt injection but as files written **above** the user's working
 * directories:
 *
 *   workspaces/<userId>/MEMORY.md   ← what the user edits in the interface
 *   workspaces/<userId>/CLAUDE.md   ← a mirrored copy; Claude Code walks upward and finds it
 *   workspaces/<userId>/AGENTS.md   ← a mirrored copy, which Codex reads
 *   workspaces/<userId>/<convId>/   ← one working directory per conversation
 *
 * Each CLI loads it through its own native mechanism, so no prompt is rewritten and no
 * conversation history is consumed. An edit applies from the next turn.
 */

const HEADER = `<!-- This file is managed from AgentLodge's Memory page.
Claude Code and Codex both read it at the start of every conversation.
Write what you want remembered for the long run: who you are, technical preferences,
project background, tone of voice. -->
`;

export const DEFAULT_MEMORY = `${HEADER}
# About me

<!-- e.g. I am a backend engineer and mostly write Go and TypeScript. -->

# Preferences

<!-- e.g. Answer in English; do not add redundant comments to code; prefer macOS for shell examples. -->

# Project background

<!-- e.g. I am building a multi-tenant AI chat service on Fastify and SQLite. -->
`;

export const MAX_BYTES = 64 * 1024;

function userDir(userId: string): string {
  return path.join(paths.workspaces, userId);
}

export function memoryPath(userId: string): string {
  return path.join(userDir(userId), 'MEMORY.md');
}

/** Each CLI's own native memory filename */
const MIRRORS = ['CLAUDE.md', 'AGENTS.md'];

export async function read(userId: string): Promise<string> {
  try {
    return await fs.readFile(memoryPath(userId), 'utf8');
  } catch {
    return '';
  }
}

export async function write(userId: string, content: string): Promise<void> {
  const dir = userDir(userId);
  await fs.mkdir(dir, { recursive: true });

  const trimmed = content.slice(0, MAX_BYTES);
  await fs.writeFile(memoryPath(userId), trimmed, 'utf8');

  // Mirror it to the filenames both CLIs look for
  await Promise.all(
    MIRRORS.map((name) => fs.writeFile(path.join(dir, name), trimmed, 'utf8').catch(() => {})),
  );
}

export async function clear(userId: string): Promise<void> {
  const dir = userDir(userId);
  await Promise.all(
    ['MEMORY.md', ...MIRRORS].map((name) => fs.rm(path.join(dir, name), { force: true })),
  );
}

/** A commented template on first visit, rather than a blank page */
export async function ensureInitialized(userId: string): Promise<string> {
  const existing = await read(userId);
  if (existing) return existing;
  await write(userId, DEFAULT_MEMORY);
  return DEFAULT_MEMORY;
}

export interface MemoryStats {
  bytes: number;
  lines: number;
  /** How much is left once HTML comments and blank lines are removed — how "is this still just the template" is decided */
  meaningfulLines: number;
  updatedAt?: string;
}

export async function stats(userId: string): Promise<MemoryStats> {
  const content = await read(userId);
  let updatedAt: string | undefined;
  try {
    updatedAt = (await fs.stat(memoryPath(userId))).mtime.toISOString();
  } catch {
    /* No such file */
  }
  const withoutComments = content.replace(/<!--[\s\S]*?-->/g, '');
  return {
    bytes: Buffer.byteLength(content, 'utf8'),
    lines: content ? content.split('\n').length : 0,
    meaningfulLines: withoutComments
      .split('\n')
      .filter((l) => l.trim() && !l.trim().startsWith('#')).length,
    updatedAt,
  };
}

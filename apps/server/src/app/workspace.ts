import fs from 'node:fs/promises';
import { constants as fsc } from 'node:fs';
import path from 'node:path';
import { workspaceDir } from './turns.js';

/**
 * Browsing a conversation's working directory.
 *
 * Claude Code and Codex write code, reports and data files there. Without this layer none
 * of it reaches the user, which makes the work pointless.
 */

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 512 * 1024;
const MAX_ENTRIES = 500;

/** Noise that is kept out of the listing */
const IGNORED = new Set(['.git', 'node_modules', '.DS_Store', '__pycache__', '.venv', 'venv']);

export interface FileEntry {
  /** Path relative to the working directory, separated by / */
  path: string;
  name: string;
  size: number;
  modifiedAt: string;
  isDirectory: boolean;
}

/** Strictly inside root; equal is not enough, since that is the directory itself */
function inside(target: string, root: string): boolean {
  return target !== root && target.startsWith(root + path.sep);
}

/** realpath, or null when the path does not exist (or cannot be read) */
async function realOf(p: string): Promise<string | null> {
  try {
    return await fs.realpath(p);
  } catch {
    return null;
  }
}

/**
 * Does the deepest existing ancestor of `target` still resolve inside the workspace?
 *
 * Checking the final component is not enough on its own: `linkdir/notes.txt` has a perfectly
 * ordinary last component, and every bit of the escaping happens one level up.
 */
async function ancestorInside(target: string, realRoot: string): Promise<boolean> {
  let dir = path.dirname(target);
  for (;;) {
    const real = await realOf(dir);
    if (real) return real === realRoot || inside(real, realRoot);
    const up = path.dirname(dir);
    if (up === dir) return false;
    dir = up;
  }
}

/**
 * Resolve a user-supplied relative path and confirm it did not escape the working
 * directory.
 *
 * This is the only guard against traversal, so every endpoint that takes a path goes
 * through it.
 *
 * **`..` is not the whole of traversal.** The workspace is a bind mount the agent container
 * writes to, and an agent will happily run `ln -s /data/agentlodge.db notes.txt`. The link
 * is a string, resolved by whoever follows it — and the process that follows it here is
 * **app**, in its own filesystem, where that path is the database holding every user's
 * conversations and the encrypted upstream keys. A lexical check passes such a path without
 * hesitation, because lexically there is nothing wrong with it.
 *
 * So symlinks are resolved and containment is checked again, the way core/secret-file.ts
 * does for key files. `follow: false` is for operations that act on the link itself rather
 * than what it points at — deleting a bad symlink has to keep working.
 */
export async function resolveInside(
  userId: string,
  conversationId: string,
  rel: string,
  opts: { follow?: boolean } = {},
): Promise<string | null> {
  // The root is realpath'd too, so a DATA_DIR that itself sits under a symlink still
  // compares equal rather than failing everything
  const realRoot = await realOf(workspaceDir(userId, conversationId));
  if (!realRoot) return null;

  const target = path.resolve(realRoot, rel);
  if (!inside(target, realRoot)) return null;
  if (!(await ancestorInside(target, realRoot))) return null;

  if (opts.follow !== false) {
    const real = await realOf(target);
    // Not existing is fine — an upload destination does not yet. Existing has to stay in.
    if (real && !inside(real, realRoot)) return null;
  }
  return target;
}

/**
 * Open flags that refuse a symlink at the final component.
 *
 * resolveInside already rejects one, but between that check and the open there is a window
 * an agent could win by swapping the file. O_NOFOLLOW closes it in the kernel, which is
 * where a check like this belongs.
 */
export const O_READ_NOFOLLOW = fsc.O_RDONLY | fsc.O_NOFOLLOW;
export const O_WRITE_NOFOLLOW = fsc.O_WRONLY | fsc.O_CREAT | fsc.O_TRUNC | fsc.O_NOFOLLOW;

export async function list(userId: string, conversationId: string): Promise<FileEntry[]> {
  const root = workspaceDir(userId, conversationId);
  const realRoot = (await realOf(root)) ?? path.resolve(root);
  const out: FileEntry[] = [];

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > 6 || out.length >= MAX_ENTRIES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_ENTRIES) return;
      if (IGNORED.has(e.name)) continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      const abs = path.join(dir, e.name);
      // A symlink out of the workspace is not listed at all. Reporting it would show the
      // size and mtime of a file in app's filesystem, and offer it for download.
      if (e.isSymbolicLink()) {
        const real = await realOf(abs);
        if (!real || !inside(real, realRoot)) continue;
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({
        path: rel,
        name: e.name,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        isDirectory: e.isDirectory(),
      });
      if (e.isDirectory()) await walk(abs, rel, depth + 1);
    }
  }

  await walk(root, '', 0);
  // Directories first, then newest first — what the agent just wrote ends up at the top
  return out.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return b.modifiedAt.localeCompare(a.modifiedAt);
  });
}

const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.yaml', '.yml', '.toml', '.ini', '.env',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs', '.java', '.kt',
  '.c', '.h', '.cpp', '.hpp', '.cs', '.php', '.swift', '.sh', '.bash', '.zsh', '.fish',
  '.sql', '.html', '.htm', '.css', '.scss', '.less', '.xml', '.svg', '.csv', '.tsv',
  '.log', '.diff', '.patch', '.gitignore', '.dockerfile',
]);

export function isTextFile(name: string): boolean {
  const ext = path.extname(name).toLowerCase();
  if (TEXT_EXT.has(ext)) return true;
  // No extension (Makefile, Dockerfile and the like) is treated as text too
  return ext === '' && !name.startsWith('.');
}

export interface FilePreview {
  path: string;
  size: number;
  truncated: boolean;
  /** A binary file returns metadata only, never contents */
  content: string | null;
  binary: boolean;
}

export async function preview(
  userId: string,
  conversationId: string,
  rel: string,
): Promise<FilePreview | null> {
  const abs = await resolveInside(userId, conversationId, rel);
  if (!abs) return null;

  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return null;

  const binary = !isTextFile(path.basename(abs));
  if (binary) {
    return { path: rel, size: stat.size, truncated: false, content: null, binary: true };
  }

  let handle;
  try {
    handle = await fs.open(abs, O_READ_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const len = Math.min(stat.size, MAX_PREVIEW_BYTES);
    const buf = Buffer.alloc(len);
    await handle.read(buf, 0, len, 0);
    return {
      path: rel,
      size: stat.size,
      truncated: stat.size > MAX_PREVIEW_BYTES,
      content: buf.toString('utf8'),
      binary: false,
    };
  } finally {
    await handle.close();
  }
}

export async function remove(
  userId: string,
  conversationId: string,
  rel: string,
): Promise<boolean> {
  // follow: false — fs.rm unlinks the symlink rather than what it points at, and somebody
  // has to be able to clear a bad one out of their own workspace
  const abs = await resolveInside(userId, conversationId, rel, { follow: false });
  if (!abs) return false;
  await fs.rm(abs, { recursive: true, force: true });
  return true;
}

/** An uploaded filename is sanitised: no path separators, no dotfiles */
export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[/\\]/g, '_').replace(/^\.+/, '');
  return base.slice(0, 200) || 'upload';
}

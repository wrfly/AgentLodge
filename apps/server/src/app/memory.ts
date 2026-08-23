import fs from 'node:fs/promises';
import path from 'node:path';
import { paths } from '../core/config.js';

/**
 * Per-user long-term memory.
 *
 * The store is Claude Code's own: a directory of one fact per file with an index beside
 * them. We do not reimplement it — we point it somewhere useful and put a window on it.
 *
 *   workspaces/<userId>/memory/MEMORY.md     the index
 *   workspaces/<userId>/memory/<slug>.md     one fact, YAML frontmatter then prose
 *   workspaces/<userId>/<convId>/memory  ─→  a link to it, so codex can edit it too
 *   workspaces/<userId>/<convId>/AGENTS.md   the same facts rendered out, for codex to load
 *
 * Claude Code is aimed at the directory with CLAUDE_COWORK_MEMORY_PATH_OVERRIDE, which
 * replaces the path it would otherwise derive from the working directory. That default is
 * the reason this exists: our working directory is per conversation, so out of the box each
 * conversation would keep a memory of its own and none of them would carry over.
 *
 * With the override in place the model writes memory unprompted, in the middle of a turn,
 * and recalls it in later sessions — measured, both. So there is no summarising pass here:
 * a second system re-reading old messages days later would cost a metered call to do the
 * same job with less context.
 *
 * Codex has no equivalent, so it gets the facts inlined into AGENTS.md and the same
 * directory to write into.
 */

export const MEMORY_ENV = 'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE';

/** The index's filename, fixed by Claude Code */
const INDEX = 'MEMORY.md';

/** Enough for a real memory, small enough that it cannot crowd out a conversation */
export const MAX_RECORD_BYTES = 8 * 1024;
export const MAX_RECORDS = 60;

export function dir(userId: string): string {
  return path.join(paths.workspaces, userId, 'memory');
}

/** The same directory as the agent sees it: the container mounts the user directory at /workspace */
export function containerDir(): string {
  return '/workspace/memory';
}

export interface MemoryRecord {
  /** Filename within the directory, which is also its identity */
  file: string;
  /** What the index calls it — the only human-readable name there is */
  title: string;
  /** The one-line hook the index carries beside the title */
  hook: string;
  description: string;
  /** user / feedback / project / reference, as Claude Code classifies them */
  type: string;
  body: string;
  updatedAt?: string;
}

/* ---------------- Reading ---------------- */

interface Front {
  name?: string;
  description?: string;
  type?: string;
  /** Everything as written, so an edit does not drop fields we do not model */
  raw?: string;
}

/**
 * Pull the fields we show out of the frontmatter.
 *
 * Deliberately not a YAML parser: this reads files another program writes, and the parts we
 * care about are three scalars. Anything richer is kept verbatim and written back untouched.
 */
export function parseFront(text: string): { front: Front; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!m) return { front: {}, body: text.trim() };

  const raw = m[1]!;
  const scalar = (key: string, indented = false): string | undefined => {
    const re = new RegExp(`^${indented ? '\\s+' : ''}${key}:\\s*(.*)$`, 'm');
    const v = re.exec(raw)?.[1]?.trim();
    if (!v) return undefined;
    return v.replace(/^["'](.*)["']$/, '$1');
  };
  return {
    front: { name: scalar('name'), description: scalar('description'), type: scalar('type', true), raw },
    body: text.slice(m[0].length).trim(),
  };
}

/** `- [Title](file.md) — hook` in either dash */
const INDEX_LINE = /^\s*[-*]\s*\[([^\]]*)\]\(([^)]+)\)\s*(?:[—–-]\s*(.*))?$/;

interface IndexEntry {
  title: string;
  hook: string;
}

async function readIndex(userId: string): Promise<{ prefix: string; entries: Map<string, IndexEntry> }> {
  const entries = new Map<string, IndexEntry>();
  let text = '';
  try {
    text = await fs.readFile(path.join(dir(userId), INDEX), 'utf8');
  } catch {
    return { prefix: '', entries };
  }

  const prefix: string[] = [];
  let seenEntry = false;
  for (const line of text.split('\n')) {
    const m = INDEX_LINE.exec(line);
    if (m) {
      seenEntry = true;
      entries.set(path.basename(m[2]!), { title: m[1]!.trim(), hook: (m[3] ?? '').trim() });
    } else if (!seenEntry) {
      prefix.push(line);
    }
  }
  return { prefix: prefix.join('\n').trim(), entries };
}

export async function list(userId: string): Promise<MemoryRecord[]> {
  const d = dir(userId);
  let names: string[];
  try {
    names = (await fs.readdir(d)).filter((n) => n.endsWith('.md') && n !== INDEX);
  } catch {
    return [];
  }

  const { entries } = await readIndex(userId);
  const out: MemoryRecord[] = [];
  for (const file of names.sort()) {
    let text: string;
    let updatedAt: string | undefined;
    try {
      text = await fs.readFile(path.join(d, file), 'utf8');
      updatedAt = (await fs.stat(path.join(d, file))).mtime.toISOString();
    } catch {
      continue;
    }
    const { front, body } = parseFront(text);
    const indexed = entries.get(file);
    out.push({
      file,
      title: indexed?.title || front.name || file.replace(/\.md$/, ''),
      hook: indexed?.hook ?? '',
      description: front.description ?? '',
      type: front.type ?? 'user',
      body,
      updatedAt,
    });
  }
  return out;
}

/* ---------------- Writing ---------------- */

/** A filename from a title, falling back to a number when it romanises to nothing */
export function slugOf(title: string, taken: Set<string>): string {
  const base =
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'memory';
  let name = `${base}.md`;
  for (let n = 2; taken.has(name); n++) name = `${base}-${n}.md`;
  return name;
}

function frontmatterFor(rec: MemoryRecord, previous?: Front): string {
  // Keep what another writer put there, and only update what this edit changes
  if (previous?.raw) {
    return previous.raw
      .replace(/^description:.*$/m, `description: ${rec.description || rec.title}`)
      .replace(/^(\s+)modified:.*$/m, `$1modified: ${new Date().toISOString()}`);
  }
  return [
    `name: ${rec.file.replace(/\.md$/, '')}`,
    `description: ${rec.description || rec.title}`,
    'metadata:',
    '  node_type: memory',
    `  type: ${rec.type || 'user'}`,
    `  modified: ${new Date().toISOString()}`,
  ].join('\n');
}

export interface SaveInput {
  /** Absent creates a new record */
  file?: string;
  title: string;
  body: string;
  hook?: string;
  description?: string;
  type?: string;
}

export async function save(userId: string, input: SaveInput): Promise<MemoryRecord> {
  const d = dir(userId);
  await fs.mkdir(d, { recursive: true });
  // Before: whatever the agent did since we last looked, so this edit does not absorb it.
  // After: the state undo comes back to.
  await snapshot(userId, 'agent');

  const existing = input.file ? await one(userId, input.file) : undefined;
  const taken = new Set((await list(userId)).map((r) => r.file));
  const file = existing?.file ?? slugOf(input.title, taken);

  let previous: Front | undefined;
  if (existing) {
    try {
      previous = parseFront(await fs.readFile(path.join(d, file), 'utf8')).front;
    } catch {
      /* Gone since it was listed */
    }
  }

  const rec: MemoryRecord = {
    file,
    title: input.title.trim() || file.replace(/\.md$/, ''),
    hook: (input.hook ?? existing?.hook ?? '').trim(),
    description: (input.description ?? existing?.description ?? '').trim(),
    type: input.type ?? existing?.type ?? 'user',
    body: input.body.trim(),
  };

  const text = `---\n${frontmatterFor(rec, previous)}\n---\n\n${rec.body}\n`.slice(0, MAX_RECORD_BYTES);
  await fs.writeFile(path.join(d, file), text, 'utf8');
  await reindex(userId, { [file]: { title: rec.title, hook: rec.hook } });
  await snapshot(userId, 'user');
  return rec;
}

export async function one(userId: string, file: string): Promise<MemoryRecord | undefined> {
  return (await list(userId)).find((r) => r.file === safeName(file));
}

export async function remove(userId: string, file: string): Promise<void> {
  await snapshot(userId, 'agent');
  await fs.rm(path.join(dir(userId), safeName(file)), { force: true });
  await reindex(userId);
  await snapshot(userId, 'user');
}

/** No path separators and no dot-dot: the name comes from a request */
function safeName(file: string): string {
  return path.basename(file).replace(/[^\w.-]/g, '');
}

/**
 * Rewrite the index from the files that are actually there.
 *
 * Claude Code maintains this itself; we rebuild it after our own edits so a record the page
 * added or deleted is not left dangling in a list the model reads at the start of every
 * conversation.
 */
export async function reindex(
  userId: string,
  overrides: Record<string, IndexEntry> = {},
): Promise<void> {
  const { prefix, entries } = await readIndex(userId);
  const records = await list(userId);
  const lines = records.map((r) => {
    const e = overrides[r.file] ?? entries.get(r.file);
    const title = e?.title || r.title;
    const hook = (e?.hook || r.hook || r.description).trim();
    return `- [${title}](${r.file})${hook ? ` — ${hook}` : ''}`;
  });
  const head = prefix || '# Memory Index';
  await fs.mkdir(dir(userId), { recursive: true });
  await fs.writeFile(path.join(dir(userId), INDEX), `${head}\n\n${lines.join('\n')}\n`, 'utf8');
}

export async function clear(userId: string): Promise<void> {
  await snapshot(userId, 'agent');
  await fs.rm(dir(userId), { recursive: true, force: true });
  await fs.mkdir(dir(userId), { recursive: true });
  await snapshot(userId, 'user');
}

/* ---------------- What codex reads ---------------- */

const CODEX_HEADER = `<!-- The user's long-term memory, and how to change it.

Each fact is one file in ./memory/, listed in ./memory/MEMORY.md. When the user asks you to
remember something, add a file there and a line to the index; when they ask you to forget
something, delete the file and its line. Say that you did. Write in the user's language.

Everything below is generated from those files — editing this file has no effect. -->`;

export async function renderForCodex(userId: string): Promise<string> {
  const records = await list(userId);
  if (records.length === 0) return `${CODEX_HEADER}\n`;

  const body = records
    .map((r) => `## ${r.title}\n\n${r.body}`)
    .join('\n\n');
  return `${CODEX_HEADER}\n\n# Long-term memory\n\n${body}\n`;
}

/* ---------------- Putting it in front of the agent ---------------- */

/**
 * Prepare a conversation's working directory.
 *
 * The link is relative so it resolves the same on the host and inside the container, whose
 * mounts are not laid out alike. AGENTS.md is a real file rather than a link because codex
 * needs the facts inlined — it has no way to go and read them on demand.
 */
export async function linkInto(convDir: string, userId: string): Promise<void> {
  await fs.mkdir(dir(userId), { recursive: true });
  await fs.mkdir(convDir, { recursive: true });

  const link = path.join(convDir, 'memory');
  try {
    if ((await fs.readlink(link)) !== '../memory') {
      await fs.rm(link, { force: true });
      await fs.symlink('../memory', link);
    }
  } catch {
    // Not a link. A real directory or file of that name is the user's, so it stays.
    if (!(await exists(link))) await fs.symlink('../memory', link).catch(() => {});
  }

  await fs.writeFile(path.join(convDir, 'AGENTS.md'), await renderForCodex(userId), 'utf8').catch(() => {});
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Clear the user directory of anything that shadows the memory.
 *
 * A CLAUDE.md or AGENTS.md one level above the working directory is picked up by Claude Code
 * walking upward, and would be loaded alongside what the memory system already provides.
 * Nothing puts a file of either name there on purpose.
 */
export async function tidy(userId: string): Promise<void> {
  const d = path.join(paths.workspaces, userId);
  await Promise.all(
    ['CLAUDE.md', 'AGENTS.md', 'MEMORY.md', '.memory-auto.json'].map((n) =>
      fs.rm(path.join(d, n), { force: true }).catch(() => {}),
    ),
  );
}

/* ---------------- History ---------------- */

export type Author = 'user' | 'agent';

export interface Revision {
  at: string;
  by: Author;
  /** Every file in the directory as it was, so undo is a restore rather than a replay */
  files: Record<string, string>;
}

const MAX_HISTORY = 20;

interface Sidecar {
  history: Revision[];
}

function sidecarPath(userId: string): string {
  return path.join(paths.memory, `${userId}.json`);
}

async function loadSidecar(userId: string): Promise<Sidecar> {
  try {
    const raw = JSON.parse(await fs.readFile(sidecarPath(userId), 'utf8')) as Partial<Sidecar>;
    return { history: raw.history ?? [] };
  } catch {
    return { history: [] };
  }
}

async function saveSidecar(userId: string, s: Sidecar): Promise<void> {
  await fs.mkdir(paths.memory, { recursive: true });
  await fs.writeFile(sidecarPath(userId), JSON.stringify(s), 'utf8');
}

/** Every file in the memory directory, keyed by name */
async function readAll(userId: string): Promise<Record<string, string>> {
  const d = dir(userId);
  const out: Record<string, string> = {};
  let names: string[];
  try {
    names = await fs.readdir(d);
  } catch {
    return out;
  }
  for (const n of names.filter((x) => x.endsWith('.md'))) {
    try {
      out[n] = await fs.readFile(path.join(d, n), 'utf8');
    } catch {
      /* Gone between the listing and the read */
    }
  }
  return out;
}

const same = (a: Record<string, string>, b: Record<string, string>): boolean =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * Record the directory as it stands, if it has changed since the last time.
 *
 * Called before our own writes and at the start of every turn — the second is what catches
 * the agent, which writes these files directly and never goes through this module.
 */
export async function snapshot(userId: string, by: Author): Promise<boolean> {
  const files = await readAll(userId);
  const s = await loadSidecar(userId);
  const last = s.history[s.history.length - 1];
  if (last && same(last.files, files)) return false;
  // An empty directory is recorded too: it is the state the first undo has to return to

  s.history.push({ at: new Date().toISOString(), by, files });
  if (s.history.length > MAX_HISTORY) s.history = s.history.slice(-MAX_HISTORY);
  await saveSidecar(userId, s);
  return true;
}

export async function history(userId: string): Promise<Revision[]> {
  return (await loadSidecar(userId)).history;
}

/** Put the directory back the way the newest snapshot has it */
export async function undo(userId: string): Promise<boolean> {
  await snapshot(userId, 'agent');
  const s = await loadSidecar(userId);
  const target = s.history[s.history.length - 2];
  if (!target) return false;

  const d = dir(userId);
  await fs.mkdir(d, { recursive: true });
  for (const name of Object.keys(await readAll(userId))) {
    if (!(name in target.files)) await fs.rm(path.join(d, name), { force: true });
  }
  for (const [name, content] of Object.entries(target.files)) {
    await fs.writeFile(path.join(d, name), content, 'utf8');
  }
  await snapshot(userId, 'user');
  return true;
}

export interface MemoryStats {
  records: number;
  bytes: number;
  updatedAt?: string;
}

export async function stats(userId: string): Promise<MemoryStats> {
  const files = await readAll(userId);
  let updatedAt: string | undefined;
  try {
    updatedAt = (await fs.stat(dir(userId))).mtime.toISOString();
  } catch {
    /* No directory yet */
  }
  return {
    records: Object.keys(files).filter((n) => n !== INDEX).length,
    bytes: Object.values(files).reduce((n, t) => n + Buffer.byteLength(t, 'utf8'), 0),
    updatedAt,
  };
}

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

/**
 * Reading a key out of a file.
 *
 * Why this exists: an upstream key is usually **not something a person types** — it
 * comes from a docker/podman secret, a cloud secret-manager sidecar, or another
 * container writing into a shared volume. Copy-pasting one into the console has two
 * problems in those cases:
 *
 *   1. the key travels through a browser and into our database (encrypted, but it is
 *      still one more copy)
 *   2. the producer rotates the file and we keep the old value until somebody
 *      remembers to go and change it
 *
 * So what is stored is **a reference, not a value**: the database holds a path and the
 * file is read at the moment it is needed. Another container changes the contents and
 * the next request uses them — no restart, no configuration change.
 *
 * The cost is that the path becomes admin-controlled input, and whatever is read goes
 * out as Authorization to an upstream address the admin also chose. "Any path" would
 * therefore mean an administrator can ship any file in the container to a server of
 * their choosing: the database, JWT_SECRET, host credentials. Admin is already a
 * powerful role, but not that powerful. Hence the allowlist — see roots().
 */

/** Size ceiling for a key file. Real keys are on the order of 100 bytes; this stops a slip that points at the database. */
const MAX_BYTES = 16 * 1024;

/** Listing limits, so a large mounted volume cannot stall the console */
const MAX_DEPTH = 3;
const MAX_ENTRIES = 200;

/**
 * Directories a key may be read from.
 *
 * Two defaults, both usable without touching compose:
 *   <DATA_DIR>/secrets   a subdirectory of the data volume, which app and gateway both mount already
 *   /run/secrets         where docker/podman secrets go by convention
 *
 * Anywhere else — a separately mounted shared volume, say — is added with
 * SECRET_FILE_ROOTS, colon-separated like PATH. **Both containers need the same value**:
 * app validates paths and lists directories with it, gateway does the actual reading.
 * Set on one side only, the console looks fine and the request finds no key.
 */
export function roots(): string[] {
  return config.secretFileRoots.length > 0
    ? config.secretFileRoots
    : [path.join(config.dataDir, 'secrets'), '/run/secrets'];
}

/** Resolve symlinks; when that fails (missing, no permission) fall back to the original path and let the checks below report it */
function realOrSelf(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

function inside(child: string, parent: string): boolean {
  // SECRET_FILE_ROOTS=/ is how you write "no restriction"; joining sep onto the root
  // would give '//', so it needs its own case
  if (parent === path.sep) return child.startsWith(path.sep);
  return child === parent || child.startsWith(parent + path.sep);
}

export interface SecretFile {
  /** The normalised absolute path */
  path: string;
  size: number;
  mtime: string;
  /**
   * First 8 hex digits of the contents' sha256.
   *
   * Answers "is this the same file / has it changed" without revealing anything. The
   * console displays it.
   */
  fingerprint: string;
  /** Masked preview, in the same shape as a secret in system settings */
  preview: string;
}

export interface SecretFileProblem {
  path: string;
  error: string;
  /**
   * path = decidable from the path alone (not absolute, not in the allowlist).
   *        Refused on save, because it would be just as wrong on another machine.
   * io   = needs the filesystem to know (missing, no permission, wrong contents).
   *        **Warns without blocking**: the gateway is what reads the key, and app is
   *        free not to mount that volume — one fewer process able to see a secret is
   *        better. App not seeing it is not the same as it being misconfigured.
   */
  code: 'path' | 'io';
}

function mask(v: string): string {
  if (v.length <= 8) return '••••';
  return `${v.slice(0, 4)}••••${v.slice(-4)}`;
}

/**
 * Validate the path, then read the contents.
 *
 * Failure returns `{ error }` rather than throwing: every reason has to reach the
 * administrator verbatim, and "cannot read it" and "read it and it was empty" are
 * entirely different things to debug.
 */
export function readSecretFile(input: string): { file: SecretFile; value: string } | SecretFileProblem {
  const raw = (input ?? '').trim();
  const fail = (error: string): SecretFileProblem => ({ path: raw, error, code: 'path' });

  if (!raw) return fail('No path given');
  if (!path.isAbsolute(raw)) return fail('Must be an absolute path, as seen inside the container');

  // resolve folds away `..`, so the prefix check below cannot be walked around with
  // /data/secrets/../../etc
  const abs = path.resolve(raw);
  const allowed = roots().map((r) => ({ raw: r, real: realOrSelf(path.resolve(r)) }));
  if (!allowed.some((r) => inside(abs, path.resolve(r.raw)))) {
    return {
      path: abs,
      error: `Not in an allowed directory (readable: ${roots().join(', ')})`,
      code: 'path',
    };
  }

  let st: fs.Stats;
  try {
    st = fs.statSync(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return {
      path: abs,
      error:
        code === 'ENOENT'
          ? 'No such file'
          : code === 'EACCES'
            ? 'No permission to read it'
            : `Cannot read it: ${code ?? e}`,
      code: 'io',
    };
  }

  // A symlink can point outside the allowlist, so the resolved path is checked again.
  // The earlier check still earns its place: a path that is not in the allowlist at all
  // deserves to be told so, rather than stat'ed first.
  const real = realOrSelf(abs);
  if (!allowed.some((r) => inside(real, r.real))) {
    return {
      path: abs,
      error: `A symlink pointing outside the allowlist (it resolves to ${real})`,
      code: 'path',
    };
  }

  if (st.isDirectory()) return { path: abs, error: 'This is a directory — point at a file', code: 'io' };
  if (!st.isFile()) return { path: abs, error: 'Not a regular file', code: 'io' };
  if (st.size > MAX_BYTES)
    return {
      path: abs,
      error: `Too large (${st.size} bytes); a key file should not exceed ${MAX_BYTES}`,
      code: 'io',
    };

  let text: string;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { path: abs, error: `Read failed: ${(e as NodeJS.ErrnoException).code ?? e}`, code: 'io' };
  }

  // BOM plus surrounding whitespace. `echo key > f` leaves a newline and is the most
  // common way to write one of these, so it has to be tolerated
  const value = text.replace(/^\uFEFF/, '').trim();
  if (!value) return { path: abs, error: 'The file is empty', code: 'io' };

  /*
   * The key ends up as an HTTP header. A newline in it makes undici throw "invalid
   * header value" a long way from the configuration that caused it, so stop it here —
   * and while we are at it, name the likely mistake of pointing at a JSON credentials
   * file.
   */
  if (/[\u0000-\u001f\u007f]/.test(value)) {
    return {
      path: abs,
      error:
        'The contents are not a single-line token (there are newlines or control characters). '
        + 'This field wants the key itself, not a JSON credentials file.',
      code: 'io',
    };
  }

  return {
    value,
    file: {
      path: abs,
      size: st.size,
      mtime: st.mtime.toISOString(),
      fingerprint: crypto.createHash('sha256').update(value).digest('hex').slice(0, 8),
      preview: mask(value),
    },
  };
}

/** Status without the value — for the console list and the check before saving */
export function inspect(input: string): SecretFile | SecretFileProblem {
  const r = readSecretFile(input);
  return 'error' in r ? r : r.file;
}

export interface RootView {
  path: string;
  exists: boolean;
  note?: string;
}

/**
 * Usable files in the allowlisted directories, for the console's dropdown.
 *
 * A hand-typed path is easy to get wrong, and getting it wrong shows up as an upstream
 * 401 — far too long a chain to debug. Listing what is actually in the mounted volumes
 * lets it be clicked instead.
 */
export function listCandidates(): { roots: RootView[]; files: Array<SecretFile | SecretFileProblem> } {
  const rootViews: RootView[] = [];
  const files: Array<SecretFile | SecretFileProblem> = [];
  let budget = MAX_ENTRIES;

  for (const root of roots()) {
    const abs = path.resolve(root);
    let ok = false;
    try {
      ok = fs.statSync(abs).isDirectory();
    } catch {
      ok = false;
    }
    rootViews.push({
      path: abs,
      exists: ok,
      note: ok ? undefined : 'Missing or unreadable — mount it and it appears here',
    });
    if (!ok) continue;

    const walk = (dir: string, depth: number): void => {
      if (depth > MAX_DEPTH || budget <= 0) return;
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (budget <= 0) return;
        if (e.name.startsWith('.')) continue;
        const full = path.join(dir, e.name);
        // Dirent gives no type for a symlink, so go by stat throughout (readSecretFile
        // checks again anyway)
        let st: fs.Stats;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        if (st.isDirectory()) {
          walk(full, depth + 1);
          continue;
        }
        budget--;
        const r = readSecretFile(full);
        files.push('error' in r ? r : r.file);
      }
    };
    walk(abs, 1);
  }

  return { roots: rootViews, files };
}

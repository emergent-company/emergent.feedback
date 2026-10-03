import { existsSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

/**
 * Walk up from `start` until a `.git` entry is found (file or directory —
 * worktrees keep `.git` as a plain file), and return that directory as the
 * repository root. Falls back to `process.cwd()` when no `.git` is found.
 */
export function findRepoRoot(start: string): string {
  const abs = resolve(start);

  let dir = abs;
  // If `start` names an existing regular file, begin the search from its
  // containing directory. Otherwise treat it as a directory.
  if (existsSync(abs) && !statSync(abs).isDirectory()) {
    dir = dirname(abs);
  }

  while (true) {
    if (existsSync(resolve(dir, '.git'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return process.cwd();
}

/**
 * Return `file` relative to `root`, normalized to POSIX separators and with
 * any leading `./` stripped. Never emits a leading `/`.
 *
 * Returns `undefined` when `file` is outside `root`: `relative()` yields a
 * `..` traversal segment (or an absolute path when `file` lives on a different
 * Windows drive), which cannot identify a file within the repo and would leak
 * the external filesystem layout.
 */
export function toRepoRelative(file: string, root: string): string | undefined {
  const rel = relative(resolve(root), resolve(file));

  // Outside `root`: a `..` traversal segment, or an absolute path on a
  // different Windows drive.
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    return undefined;
  }

  // `file` is `root` itself — no meaningful relative path exists.
  if (!rel) {
    return undefined;
  }

  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

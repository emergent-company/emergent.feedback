import { existsSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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
 */
export function toRepoRelative(file: string, root: string): string {
  let rel = relative(resolve(root), resolve(file));
  if (!rel) {
    // `file` is the root itself or resolution produced nothing usable —
    // fall back to the full resolved path so we never emit an empty source.
    rel = resolve(file);
  }
  return rel.replace(/\\/g, '/').replace(/^\.\//, '');
}

// ============================================
// OpenSwarm - Trusted repository write scopes
// ============================================

import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { canonicalConflictScopeEntry, normalizeConflictScope } from './conflictScope.js';

/** A direct KG scope larger than this is a context hint, not a safe reservation. */
export const MAX_VALIDATED_DIRECT_FILES = 8;

/**
 * Keep only existing regular files whose real path stays inside the repository.
 * This turns KG/drafter hints into a repository-relative reservation instead of
 * trusting generated, stale, absolute, or symlink-escaped paths.
 */
export async function canonicalExistingRepoFiles(
  projectPath: string,
  candidates: readonly string[],
): Promise<string[]> {
  let root: string;
  try {
    root = await realpath(projectPath);
  } catch {
    return [];
  }

  const files = new Set<string>();
  for (const raw of candidates) {
    if (typeof raw !== 'string') continue;
    const syntactic = canonicalConflictScopeEntry(raw);
    if (!syntactic) continue;
    try {
      // Keep original casing for the filesystem lookup; the canonical form is
      // lowercased only after the real path is proven repository-local.
      const lookup = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
      const resolved = await realpath(resolve(root, lookup));
      const repoRelative = relative(root, resolved);
      if (
        !repoRelative
        || repoRelative === '..'
        || repoRelative.startsWith(`..${sep}`)
        || isAbsolute(repoRelative)
        || !(await stat(resolved)).isFile()
      ) continue;
      const canonical = canonicalConflictScopeEntry(repoRelative);
      if (canonical) files.add(canonical);
    } catch {
      // A stale/nonexistent hint cannot reserve a write boundary.
    }
  }
  return [...files].sort();
}

/** Narrow companion-test allowance retained from the worker boundary. */
function isTestForScopedFile(file: string, scoped: string): boolean {
  const match = scoped.match(/^(.*?)([^/]+)\.([cm]?[jt]sx?)$/);
  if (!match) return false;
  const [, dir, base, ext] = match;
  const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `^${escape(dir)}${escape(base)}(\\.[^/]+)?\\.(test|spec)\\.${escape(ext)}$`,
  ).test(file);
}

/** Return original Git paths that fall outside a trusted write reservation. */
export function filesOutsideWriteScope(
  files: readonly string[],
  fileScope: readonly string[] = [],
): string[] {
  const scope = [...normalizeConflictScope(fileScope)];
  if (scope.length === 0) return [];
  return files.filter((raw) => {
    const file = canonicalConflictScopeEntry(raw);
    if (!file) return true;
    return !scope.some((allowed) =>
      file === allowed
      || file.startsWith(`${allowed}/`)
      || isTestForScopedFile(file, allowed));
  });
}

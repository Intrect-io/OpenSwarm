// ============================================
// OpenSwarm - Canonical predicted write scopes
// ============================================

import path from 'node:path';

export const UNKNOWN_SCOPE_MARKER = 'unknown-file-scope';

const VOLATILE_SCOPE_SEGMENTS = new Set([
  'trash',
  'worktree',
  '.openswarm',
  'node_modules',
  'dist',
  'build',
  'coverage',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);
const VOLATILE_SCOPE_PREFIXES = ['worktree_'];

function isVolatileScopePath(value: string): boolean {
  const parts = value.split('/').filter(Boolean);
  return parts.some((part) =>
    VOLATILE_SCOPE_SEGMENTS.has(part)
    || VOLATILE_SCOPE_PREFIXES.some((prefix) => part.startsWith(prefix)));
}

/**
 * Canonicalize one repository-relative file or directory scope. Absolute paths,
 * traversal outside the repository, and the explicit unknown marker are unsafe.
 */
export function canonicalConflictScopeEntry(raw: string): string | null {
  const value = raw.trim().replace(/\\/g, '/');
  if (!value || value === UNKNOWN_SCOPE_MARKER) return null;
  if (/^\.\/*$/.test(value)) return '';
  if (value.startsWith('/') || value.startsWith('//') || /^[A-Za-z]:\//.test(value)) return null;
  const normalized = path.posix.normalize(value).replace(/^\.\//, '').toLowerCase();
  if (!normalized || normalized === '..' || normalized.startsWith('../')) return null;
  if (isVolatileScopePath(normalized)) return '';
  return normalized.replace(/\/$/, '');
}

/**
 * Normalize a scope as one unit. A syntactically unsafe string makes the whole
 * write set unknown (empty) so callers fail closed; blank/non-string noise and
 * volatile generated paths are ignored.
 */
export function normalizeConflictScope(entries: unknown): Set<string> {
  if (!Array.isArray(entries)) return new Set();
  const scope = new Set<string>();
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const normalized = canonicalConflictScopeEntry(entry);
    if (normalized === null) return new Set();
    if (normalized) scope.add(normalized);
  }
  return scope;
}

/** Segment-boundary ancestor/descendant scopes overlap; sibling prefixes do not. */
export function conflictScopeEntriesOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function conflictScopesOverlap(left: Set<string>, right: Set<string>): boolean {
  for (const leftEntry of left) {
    for (const rightEntry of right) {
      if (conflictScopeEntriesOverlap(leftEntry, rightEntry)) return true;
    }
  }
  return false;
}

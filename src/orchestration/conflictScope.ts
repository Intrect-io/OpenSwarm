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

// A documentation path is never implementation ownership (AGT-4422).
//
// cgf-portal 2026-09-18: every issue there tells the PR to update
// docs/REQUIREMENTS-LEDGER.md, so the ledger sat in every draft's file plan and
// in every open PR's file list. One open hand PR touching it superseded every
// cgf task — the duplicate-implementation gate had become a mutex on a file
// that every change appends to and that a merge resolves by rebase. Two
// changes to a ledger are not two implementations of the same thing.
const DOCUMENTATION_SEGMENTS = new Set(['docs', 'doc']);
const DOCUMENTATION_EXTENSION_RE = /\.(?:md|mdx|rst|adoc)$/i;
const DOCUMENTATION_BASENAME_RE = /^(?:readme|changelog|license|licence|notice|contributing)(?:[.\-_].*)?$/i;

/** A file or directory that documents the code rather than being it. */
export function isDocumentationPath(entry: string): boolean {
  const parts = entry.replace(/\\/g, '/').replace(/^\.\//, '').split('/').filter(Boolean);
  if (parts.some((part) => DOCUMENTATION_SEGMENTS.has(part.toLowerCase()))) return true;
  const base = parts[parts.length - 1] ?? '';
  return DOCUMENTATION_EXTENSION_RE.test(base) || DOCUMENTATION_BASENAME_RE.test(base);
}

/**
 * Segment-boundary ancestor/descendant scopes overlap; sibling prefixes do
 * not; a documentation path overlaps nothing (see isDocumentationPath).
 */
export function conflictScopeEntriesOverlap(left: string, right: string): boolean {
  if (isDocumentationPath(left) || isDocumentationPath(right)) return false;
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

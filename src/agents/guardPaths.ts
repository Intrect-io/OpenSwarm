// ============================================
// OpenSwarm - Pipeline guard path containment (AGT-3441)
// Changed-file paths come from the worker's report. Before a guard opens one,
// it must name a file inside the project: not absolute, no `..` escape, and no
// symlinked ancestor (or the file itself) that resolves outside the project.
// ============================================

import { realpathSync } from 'node:fs';
import { dirname, isAbsolute, normalize, relative, resolve } from 'node:path';

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function within(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * Lexical check: a project-relative path with no absolute prefix, no `..`
 * escape and no NUL byte. Returns the normalized relative path, or null.
 */
export function lexicallyContainedPath(projectPath: string, filePath: string): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) return null;
  const cleaned = normalize(filePath).replace(/\\/g, '/').replace(/^\.\//, '');
  const absolute = isAbsolute(cleaned) ? cleaned : resolve(projectPath, cleaned);
  const rel = normalize(relative(projectPath, absolute)).replace(/\\/g, '/');
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return null;
  return rel;
}

/**
 * Physical check: the nearest existing path on the way to `rel` (the file
 * itself when it exists) must resolve inside the real project root, so a
 * symlinked directory or file cannot redirect a guard read outside it.
 */
export function physicallyContained(projectPath: string, rel: string): boolean {
  const root = realpathOrNull(projectPath);
  if (!root) return false;
  let probe = resolve(projectPath, rel);
  for (;;) {
    const real = realpathOrNull(probe);
    if (real) return within(root, real);
    const parent = dirname(probe);
    if (parent === probe || !within(resolve(projectPath), parent)) return false;
    probe = parent;
  }
}

/** Lexical + physical containment; returns the relative path or null. */
export function containedProjectPath(projectPath: string, filePath: string): string | null {
  const rel = lexicallyContainedPath(projectPath, filePath);
  return rel && physicallyContained(projectPath, rel) ? rel : null;
}

/** Split worker-reported changed files into contained and escaping paths. */
export function partitionChangedPaths(
  projectPath: string,
  files: readonly string[],
): { contained: string[]; escaped: string[] } {
  const contained: string[] = [];
  const escaped: string[] = [];
  for (const file of files) {
    const rel = containedProjectPath(projectPath, file);
    if (rel) contained.push(rel);
    else escaped.push(String(file));
  }
  return { contained, escaped };
}


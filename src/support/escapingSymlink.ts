/**
 * One escaping-symlink policy, shared by the verify sandbox and the commit path.
 *
 * The verify sandbox has rejected escaping links since AGT-4407; the commit
 * path did not, so `apps/portal/node_modules` — a mode-120000 blob whose
 * content is `/Users/unohee/dev/cgf-portal/apps/portal/node_modules` — reached
 * the AX-1556 branch and blocked its publication (AGT-4431). Anyone who checks
 * that branch out on another machine gets a dangling link.
 *
 * Two call sites, one predicate: a second copy would drift, and the operator
 * had already stripped this class of link out of a hand PR once.
 */

import { dirname, isAbsolute, resolve, sep } from 'node:path';

/**
 * True when a link cannot be honoured inside `root`.
 *
 * Purely lexical, so it answers for a staged index entry whose target is the
 * blob's content and whose file may no longer be on disk. An absolute target
 * escapes by definition: it names a path on one machine.
 */
export function symlinkTargetEscapes(input: {
  /** Absolute, resolved root the link must stay inside. */
  root: string;
  /** Absolute path of the link itself, used to resolve a relative target. */
  linkPath: string;
  /** The link's target exactly as `readlink` or the git blob reports it. */
  target: string;
}): boolean {
  if (isAbsolute(input.target)) return true;
  const resolved = resolve(dirname(input.linkPath), input.target);
  return resolved !== input.root && !resolved.startsWith(`${input.root}${sep}`);
}

/** True when a git index mode denotes a symbolic link. */
export function isSymlinkMode(mode: string): boolean {
  return mode === '120000';
}

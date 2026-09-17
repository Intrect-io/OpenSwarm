// Cross-worktree executable audit (AGT-4043)
//
// Every task runs in its own worktree at `<repo>/worktree/<id>/`. A worker whose
// worktree came up without a toolchain has been seen borrowing another task's
// venv (`/work/cgf-portal/worktree/<other id>/apps/pipelines/.venv/bin/ruff`).
// For a linter that takes paths as arguments that only reads the wrong binary;
// for pytest it imports the other tree's packages and passes against source the
// worker never touched. The harness cannot tell those two apart from the
// command text, so it makes every such reference visible: an audit line in the
// daemon log and a note on the tool result the model reads.

import { sep } from 'node:path';

/** `…/worktree/<id>/…` — the id is the path segment right after `worktree`. */
const WORKTREE_PATH_RE = /(?:^|[\s"'`=:(])((?:\/[^\s"'`;|&<>()]*?)?\/worktree\/([^\s"'`;|&<>()/]+)(?:\/[^\s"'`;|&<>()]*)?)/g;

/** The worktree id `cwd` sits in, or `null` when it is not under a `worktree/` directory. */
export function ownWorktreeId(cwd: string): string | null {
  const segments = cwd.split(sep === '\\' ? /[\\/]/ : '/');
  const index = segments.lastIndexOf('worktree');
  if (index < 0 || index + 1 >= segments.length || !segments[index + 1]) return null;
  return segments[index + 1];
}

/**
 * Absolute paths in `command` that reach into a worktree other than the one
 * `cwd` belongs to. When `cwd` is not itself a worktree, every worktree
 * reference is foreign. Deduplicated, in order of appearance.
 */
export function foreignWorktreeReferences(command: string, cwd: string): string[] {
  const own = ownWorktreeId(cwd);
  const out: string[] = [];
  for (const match of command.matchAll(WORKTREE_PATH_RE)) {
    const [, path, id] = match;
    if (id === own) continue;
    if (!out.includes(path)) out.push(path);
  }
  return out;
}

/**
 * The note appended to a bash tool result whose command referenced another
 * worktree, or `null` when there is nothing to say.
 */
export function crossWorktreeAuditNote(command: string, cwd: string): string | null {
  const foreign = foreignWorktreeReferences(command, cwd);
  if (foreign.length === 0) return null;
  return `[audit] This command referenced another task's worktree: ${foreign.join(', ')}. `
    + `Executables and packages there belong to a different checkout — pytest run through them imports that tree, not this one. `
    + `Use this worktree's own dependencies (node_modules/.venv are shared into it).`;
}

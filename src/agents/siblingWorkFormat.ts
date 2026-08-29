// Pure half of the sibling-work advisory: parsing, selection and rendering.
//
// Split from the collector so the prompt templates can render this without
// importing a module that reaches for child_process. They did, and a suite
// that partially mocks `child_process` then failed to even load the prompts,
// because `promisify(execFile)` runs at module scope. (Caught by CI.)

import { resolve } from 'node:path';

/** One worktree of a repository, as reported by `git worktree list`. */
export interface WorktreeEntry {
  path: string;
  branch?: string;
}

/** A sibling worktree and what it currently has uncommitted. */
export interface SiblingWork {
  identifier: string;
  files: string[];
}

/** Keep the injected block context, not payload. */
export const MAX_SIBLINGS = 8;
export const MAX_FILES_PER_SIBLING = 12;

/**
 * Parse `git worktree list --porcelain -z`.
 *
 * Git is asked rather than the run ledger on purpose: git knows every worktree
 * of the repository, including ones no run owns (the main checkout, a worktree
 * left behind by an abandoned run), and those hold edits that conflict exactly
 * as much. It is also reachable from inside a worktree, which the ledger is not.
 *
 * `-z` because the line-based form cannot represent a path containing a
 * newline: measured against real git, such a path splits across two lines and
 * the parser reads a truncated directory that does not exist, so a real overlap
 * goes unseen. With `-z` each attribute is one NUL-terminated field and the
 * path survives whole.
 *
 * Note that unlike `status --porcelain`, this command does NOT C-quote unusual
 * paths — spaces, quotes and non-ASCII were all verified to come through
 * literally in both forms — so the field is used as-is rather than unescaped.
 * (Newline case caught by the fresh PR review.)
 */
export function parseWorktreeList(porcelainZ: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const field of porcelainZ.split('\0')) {
    if (field.startsWith('worktree ')) {
      // Not trimmed: a trailing space is part of the path, and trimming it
      // either hides a real overlap or makes us report our own edits as a
      // peer's.
      current = { path: field.slice('worktree '.length) };
      entries.push(current);
    } else if (field.startsWith('branch ') && current) {
      // A ref name cannot contain whitespace, so trimming here is safe.
      current.branch = field.slice('branch '.length).trim();
    }
  }

  return entries.filter((entry) => entry.path.length > 0);
}

/**
 * The issue identifier a branch was cut for, e.g.
 * `refs/heads/swarm/AX-1062-receivables` -> `AX-1062`.
 *
 * Falls back to the short branch name: a worktree on a hand-made branch still
 * holds conflicting edits, and naming it by its branch is more use to the
 * worker than dropping it for not matching a convention.
 */
export function identifierFromBranch(branch?: string): string | undefined {
  if (!branch) return undefined;
  const short = branch.replace(/^refs\/heads\//, '');
  if (!short) return undefined;
  const match = /(?:^|\/)([A-Z][A-Z0-9]*-\d+)(?:[-/]|$)/.exec(short);
  return match ? match[1] : short;
}

/**
 * Every worktree of this repository except the one we are working in.
 *
 * Both sides go through the same canonicaliser, so a worktree reached by a
 * different spelling is still recognised as ourselves — reporting our own edits
 * back to us would read as a conflict with a phantom peer. The canonicaliser is
 * a parameter so the decision stays testable without symlinks on disk.
 */
export function selectSiblingWorktrees(
  entries: readonly WorktreeEntry[],
  selfPath: string,
  canonicalise: (path: string) => string = resolve,
): WorktreeEntry[] {
  const self = canonicalise(selfPath);
  return entries.filter((entry) => canonicalise(entry.path) !== self);
}

/**
 * Paths OpenSwarm generates inside a repository, which every managed worktree
 * carries and which tell a worker nothing about what a peer is building.
 *
 * Measured on the live host the moment this shipped: 16 of 23 reported file
 * entries were `.openswarm-preserved`, and 15 of 19 siblings had nothing else
 * at all — so the advisory was 79% noise, and the four siblings doing real work
 * were being pushed past the display cap by housekeeping. The synthetic
 * fixtures could not show this; only the production distribution did.
 *
 * An explicit list, not a `.openswarm/` prefix. That directory also holds
 * `verify.yaml`, which is repository-owned configuration a task may genuinely
 * change (README, and `deterministicTester`'s VERIFY_INPUTS) — hiding a sibling's
 * edit to it would suppress exactly the conflict this advisory exists to report.
 * Between over- and under-filtering, an unrecognised path is therefore shown.
 * (Caught by the commit-gate review.)
 */
const GENERATED_PATHS: ReadonlySet<string> = new Set([
  '.openswarm-preserved',
  '.openswarm/repo-snapshot.json',
  '.openswarm/repo.graphql',
]);

export function isBookkeepingPath(path: string): boolean {
  // `openswarm.json` without the dot is the repository's own config — a task may
  // legitimately edit it, so it is deliberately not matched here.
  return GENERATED_PATHS.has(path) || path.startsWith('.openswarm/audit/');
}

/** Drop OpenSwarm's bookkeeping from a worktree's changed-file list. */
export function withoutBookkeeping(files: readonly string[]): string[] {
  return files.filter((file) => !isBookkeepingPath(file));
}

/**
 * Render the advisory block, or an empty string when there is nothing to say.
 *
 * Empty rather than a "no siblings" sentence: a worker running alone is the
 * common case, and a paragraph saying nothing is happening would be noise in
 * most prompts.
 */
export function formatSiblingWork(siblings: readonly SiblingWork[]): string {
  // No early return for the empty case: slice -> map -> join already yields the
  // empty string, and a guard for it is a branch no test can distinguish.
  const withFiles = siblings.filter((sibling) => sibling.files.length > 0);
  const lines = withFiles.slice(0, MAX_SIBLINGS).map((sibling) => {
    const shown = sibling.files.slice(0, MAX_FILES_PER_SIBLING);
    const omitted = sibling.files.length - shown.length;
    return `  ${sibling.identifier} — ${shown.join(', ')}${omitted > 0 ? `, +${omitted} more` : ''}`;
  });

  const dropped = withFiles.length - Math.min(withFiles.length, MAX_SIBLINGS);
  if (dropped > 0) lines.push(`  (+${dropped} more worktree${dropped === 1 ? '' : 's'})`);

  return lines.join('\n');
}

/**
 * Uncommitted paths in one worktree, from `git status --porcelain -z`.
 *
 * `-z` rather than plain porcelain: without it git C-quotes any path holding a
 * space, quote, backslash or non-ASCII byte (`"src/a\tb.ts"`), and prints a
 * rename as `old -> new` on one line — so a filename containing ` -> ` splits
 * in the wrong place. Both would name a file that does not exist, which is
 * worse than saying nothing. With `-z` each field is literal and NUL-separated,
 * and a rename is two fields: the new path, then the original.
 * (Caught by the commit-gate review.)
 */
export function parseChangedFiles(porcelainZ: string): string[] {
  const fields = porcelainZ.split('\0').filter((field) => field.length > 0);
  const files: string[] = [];

  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i];
    const status = entry.slice(0, 2);
    // `XY ` — two status codes and a space. Not trimmed: a path may legitimately
    // end in a space, and trimming would name a different file.
    const path = entry.slice(3);
    if (path) files.push(path);
    // A rename or copy is followed by its source path as a separate field. That
    // path is where the content came from, not somewhere this worktree is
    // writing, so it is consumed rather than reported.
    if (status.includes('R') || status.includes('C')) i++;
  }

  return files;
}

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';

const execFileAsync = promisify(execFile);

const GIT_LIMITS = { timeout: 5_000, maxBuffer: 1024 * 1024 } as const;

/**
 * What timeout to give one git call: whatever is left of the scan's budget,
 * never more than the per-command cap and never zero — `0` means "no timeout"
 * to child_process, which is the opposite of what an exhausted budget wants.
 */
export function commandTimeoutMs(remainingMs: number, cap: number = GIT_LIMITS.timeout): number {
  return Math.max(1, Math.min(cap, remainingMs));
}

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
 * Parse `git worktree list --porcelain`.
 *
 * Git is asked rather than the run ledger on purpose: git knows every worktree
 * of the repository, including ones no run owns (the main checkout, a worktree
 * left behind by an abandoned run), and those hold edits that conflict exactly
 * as much. It is also reachable from inside a worktree, which the ledger is not.
 */
export function parseWorktreeList(porcelain: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  for (const rawLine of porcelain.split('\n')) {
    // Only \r is stripped, for a checkout written with CRLF endings. The path
    // itself is NOT trimmed: measured against real git, `worktree list
    // --porcelain` emits paths literally and unquoted, trailing space included,
    // so trimming corrupts a legitimate path — which then either fails to match
    // ourselves (and we report our own edits as a peer's) or points `git status`
    // at a directory that does not exist (and a real overlap goes unseen).
    // (Caught by the fresh PR review.)
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line.startsWith('worktree ')) {
      current = { path: line.slice('worktree '.length) };
      entries.push(current);
    } else if (line.startsWith('branch ') && current) {
      // A ref name cannot contain whitespace, so trimming here is safe.
      current.branch = line.slice('branch '.length).trim();
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
 * Paths are resolved before comparison so a worktree reached by a different
 * spelling is still recognised as ourselves — reporting our own edits back to
 * us would read as a conflict with a phantom peer.
 */
export function selectSiblingWorktrees(entries: readonly WorktreeEntry[], selfPath: string): WorktreeEntry[] {
  const self = resolve(selfPath);
  return entries.filter((entry) => resolve(entry.path) !== self);
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

/** How many `git status` calls may be in flight at once. */
export const STATUS_CONCURRENCY = 8;

/**
 * Total wall-clock this scan may spend, across all worktrees.
 *
 * The per-command timeout alone does not bound it: with N worktrees the scan
 * runs ceil(N / STATUS_CONCURRENCY) batches, so a repository full of stalled or
 * unreachable worktrees could add minutes — and this runs ahead of *every*
 * worker attempt. Past the budget the remaining worktrees are reported as
 * clean rather than waited for, which is the right trade for an advisory: a
 * partial list is useful, a delayed dispatch is not.
 *
 * Enforced on both edges, because skipping only *unstarted* worktrees still
 * lets the commands already running overrun it: every git invocation is given
 * whatever is left of the budget as its own timeout, so the scan cannot outlive
 * this figure by more than process teardown.
 * (Both caught by the commit-gate review.)
 */
export const TOTAL_BUDGET_MS = 5_000;

/** Run `worker` over every item, at most `limit` in flight. */
async function mapWithLimit<T, R>(items: readonly T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = Array.from({ length: items.length });
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (let i = next++; i < items.length; i = next++) results[i] = await worker(items[i]);
  });
  await Promise.all(runners);
  return results;
}

/**
 * What every other worktree of this repository is currently editing.
 *
 * Best effort throughout: this decorates a prompt, so a removed worktree, a
 * failing git, or a repository mid-rebase costs that one sibling its line and
 * nothing more.
 *
 * Every sibling is inspected, and only then are the dirty ones capped. Capping
 * the worktree list first was wrong: this host runs 25 worktrees against a cap
 * of 8, so a dirty worktree sitting past the cut was dropped without a trace —
 * and silently omitting a conflict is the one failure this feature exists to
 * prevent. It also left `formatSiblingWork`'s "+N more" count unreachable in
 * production, since the list could never exceed the cap. (Caught by the
 * commit-gate review.)
 *
 * Cost stays bounded by `STATUS_CONCURRENCY` rather than by truncation: at most
 * that many `git status` processes run at once, however many worktrees exist.
 */
export async function collectSiblingWork(
  worktreePath: string,
  // Seams, defaulted to git. Injected only by the tests, which need to cover
  // the ordering property below without 25 real worktrees on disk.
  io: {
    listWorktrees?: (cwd: string) => Promise<string>;
    readStatus?: (cwd: string) => Promise<string>;
    budgetMs?: number;
    now?: () => number;
  } = {},
): Promise<SiblingWork[]> {
  const now = io.now ?? Date.now;
  const deadline = now() + (io.budgetMs ?? TOTAL_BUDGET_MS);
  const remaining = () => deadline - now();

  const listWorktrees = io.listWorktrees ?? (async (cwd: string) => (
    (await execFileAsync('git', ['-C', cwd, 'worktree', 'list', '--porcelain'], {
      ...GIT_LIMITS, timeout: commandTimeoutMs(remaining()),
    })).stdout
  ));
  const readStatus = io.readStatus ?? (async (cwd: string) => (
    (await execFileAsync('git', ['-C', cwd, 'status', '--porcelain', '-z'], {
      ...GIT_LIMITS, timeout: commandTimeoutMs(remaining()),
    })).stdout
  ));

  let entries: WorktreeEntry[];
  try {
    entries = selectSiblingWorktrees(parseWorktreeList(await listWorktrees(worktreePath)), worktreePath);
  } catch {
    return [];
  }

  const collected = await mapWithLimit(entries, STATUS_CONCURRENCY, async (entry) => {
    const identifier = identifierFromBranch(entry.branch) ?? entry.path;
    // Checked before starting, not after: the budget caps how many batches are
    // begun, so the scan overruns by at most one in-flight command.
    if (now() >= deadline) return { identifier, files: [] };
    try {
      return { identifier, files: parseChangedFiles(await readStatus(entry.path)) };
    } catch {
      return { identifier, files: [] };
    }
  });

  return collected.filter((sibling) => sibling.files.length > 0);
}

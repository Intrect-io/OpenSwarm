import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  parseChangedFiles, parseWorktreeList, identifierFromBranch, selectSiblingWorktrees,
  type SiblingWork, type WorktreeEntry,
} from './siblingWorkFormat.js';

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

/**
 * Canonicalise a path for comparison: symlinks resolved where the path exists,
 * lexical normalisation where it does not.
 *
 * `resolve` alone is not enough. git always reports a worktree by its *real*
 * path — verified by asking through a symlink, which still answered with the
 * resolved directory — while the dispatched project path can carry a symlinked
 * component (on macOS `/var` alone is one). Comparing the two forms lexically
 * makes them differ, and the current worktree is then scanned and reported as
 * a conflicting peer. (Caught by the fresh PR review.)
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    // A worktree git still lists but that is gone from disk; lexical is the
    // best available, and it is only used to tell it apart from ourselves.
    return resolve(path);
  }
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
    (await execFileAsync('git', ['-C', cwd, 'worktree', 'list', '--porcelain', '-z'], {
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
    entries = selectSiblingWorktrees(parseWorktreeList(await listWorktrees(worktreePath)), worktreePath, canonicalPath);
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

export * from './siblingWorkFormat.js';

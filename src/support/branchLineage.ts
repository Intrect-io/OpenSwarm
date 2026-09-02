// ============================================
// OpenSwarm - Branch lineage across reopened issues
// ============================================
//
// An issue whose pull request already merged can come back: the operator
// moves the card to Todo for follow-up work, or redispatches it. The runner
// used to resume the preserved worktree and push the SAME branch name again —
// but that branch is consumed. Its commits are already in the base (squashed,
// under new hashes), the remote branch still exists at the merged head, and
// `push --force-with-lease` with no lease information is rejected as "stale
// info". On vela cgf-portal AX-855 reached attempt 64 and AX-863 attempt 44
// this way (2026-09-02), each attempt paying for a full worker run.
//
// Follow-up work therefore starts on a fresh branch name, cut from the base
// like a first attempt: `<name>-r2`, `-r3`, … The stale preserved worktree and
// its markers are removed (the work is reachable from the merged PR); the
// local branch is left alone.

import { execFile } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { findPullRequestForBranch } from './worktreeManager.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 5 * 60_000 });
  return stdout;
}

/**
 * Remove a preserved worktree that sits on a consumed branch, plus every
 * active-worktree marker filed under the issue.
 *
 * This deliberately does NOT go through the ownership-aware
 * `removePreservedWorktreeAt`: that path keeps a tree whenever a marker's pid
 * looks alive, and markers left by earlier container generations name pids
 * that are alive again in this one — on vela the 2026-08-28 marker for
 * AX-863 (ownerPid 7) kept the stale tree, `createWorktree` then threw
 * "requires reconciliation", and attempt 45 was lost. The caller runs after
 * the durable claim, so every other executor of this issue is already fenced
 * out by the lease; the tree's commits live on its local branch and in the
 * merged PR. Nothing recoverable is at stake.
 */
export async function retireConsumedWorktree(repoPath: string, issueId: string, worktreePath: string): Promise<void> {
  try {
    await git(repoPath, 'worktree', 'remove', '--force', worktreePath);
  } catch {
    rmSync(worktreePath, { recursive: true, force: true });
  }
  await git(repoPath, 'worktree', 'prune').catch(() => {});
  try {
    const commonRaw = (await git(repoPath, 'rev-parse', '--git-common-dir')).trim();
    const commonDir = isAbsolute(commonRaw) ? commonRaw : resolve(repoPath, commonRaw);
    rmSync(join(commonDir, 'openswarm', 'active-worktrees', issueId), { recursive: true, force: true });
  } catch (error) {
    console.warn(`[Worktree] Could not clear stale markers for ${issueId}: ${error instanceof Error ? error.message : String(error)}`);
  }
  console.log(`[Worktree] Retired consumed worktree: ${worktreePath}`);
}

/** Highest follow-up suffix tried before giving up and reusing the last name. */
const MAX_LINEAGE = 20;

export interface AttemptBranch {
  branchName: string;
  /** Pull requests, oldest first, that consumed the earlier names. */
  consumedPullRequests: string[];
}

type PullRequestLookup = (repoPath: string, branchName: string) => Promise<{ url: string; state: string } | null>;

/**
 * Pick the branch this attempt may publish from. A name whose pull request is
 * MERGED or CLOSED is consumed and the next `-rN` name is tried; an OPEN pull
 * request (or none) keeps the name, which is the normal resume path. A GitHub
 * lookup failure keeps the base name — the same fail-open the file-overlap
 * check uses, and no worse than the previous behaviour.
 */
export async function resolveAttemptBranchName(
  repoPath: string,
  baseName: string,
  lookup: PullRequestLookup = findPullRequestForBranch,
): Promise<AttemptBranch> {
  const consumed: string[] = [];
  for (let n = 1; n <= MAX_LINEAGE; n += 1) {
    const candidate = n === 1 ? baseName : `${baseName}-r${n}`;
    let pr: { url: string; state: string } | null;
    try {
      pr = await lookup(repoPath, candidate);
    } catch (error) {
      console.warn(`[Worktree] Could not check pull requests for ${candidate}; keeping it: ${error instanceof Error ? error.message : String(error)}`);
      return { branchName: candidate, consumedPullRequests: consumed };
    }
    if (pr && (pr.state === 'MERGED' || pr.state === 'CLOSED')) {
      consumed.push(pr.url);
      continue;
    }
    return { branchName: candidate, consumedPullRequests: consumed };
  }
  return { branchName: `${baseName}-r${MAX_LINEAGE}`, consumedPullRequests: consumed };
}

/**
 * Resolve the branch for an attempt and retire a preserved worktree that still
 * sits on a consumed name, so `createWorktree` cuts the new branch from the
 * base instead of throwing "requires reconciliation" over the old tree.
 */
export async function prepareAttemptBranch(
  repoPath: string,
  issueId: string,
  baseName: string,
  deps: { lookup?: PullRequestLookup; retire?: (repoPath: string, issueId: string, worktreePath: string) => Promise<void> } = {},
): Promise<string> {
  const lineage = await resolveAttemptBranchName(repoPath, baseName, deps.lookup);
  if (lineage.consumedPullRequests.length > 0) {
    console.log(
      `[Worktree] ${baseName} is consumed by ${lineage.consumedPullRequests.join(', ')}; `
      + `follow-up work continues on ${lineage.branchName}`,
    );
    const stale = join(repoPath, 'worktree', issueId);
    if (existsSync(stale)) {
      try {
        await (deps.retire ?? retireConsumedWorktree)(repoPath, issueId, stale);
      } catch (error) {
        // createWorktree will refuse the stale tree and the run retries as
        // infra_error — the same outcome as before, now with the cause logged.
        console.warn(`[Worktree] Could not retire ${stale}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  return lineage.branchName;
}

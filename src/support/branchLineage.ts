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
// like a first attempt: `<name>-r2`, `-r3`, … The stale preserved worktree is
// removed (it is reachable from the merged PR); its local branch is left alone.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { findPullRequestForBranch, removePreservedWorktreeAt } from './worktreeManager.js';

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
  deps: { lookup?: PullRequestLookup; retire?: (worktreePath: string) => Promise<void> } = {},
): Promise<string> {
  const lineage = await resolveAttemptBranchName(repoPath, baseName, deps.lookup);
  if (lineage.consumedPullRequests.length > 0) {
    console.log(
      `[Worktree] ${baseName} is consumed by ${lineage.consumedPullRequests.join(', ')}; `
      + `follow-up work continues on ${lineage.branchName}`,
    );
    const stale = join(repoPath, 'worktree', issueId);
    if (existsSync(stale)) await (deps.retire ?? removePreservedWorktreeAt)(stale);
  }
  return lineage.branchName;
}

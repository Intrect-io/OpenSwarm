// ============================================
// OpenSwarm — open pull requests that already own a planned change
// ============================================
//
// Split out of worktreeManager.ts, which sits at the 1500-line cap.

import { isBranchForIssue, isSwarmBranch } from './branchNaming.js';
import { isDocumentationPath } from '../orchestration/conflictScope.js';
import { gh } from './ghPullRequests.js';
import type { FileOverlap } from './fileOverlap.js';

export interface OpenPRFileOverlap extends FileOverlap {
  number: number;
  url: string;
}

/**
 * Check planned files before a worker branch is created. This is intentionally
 * fail-open when GitHub is unavailable, but a successful query lets the runner
 * avoid producing another divergent implementation of the same files.
 */
export async function findOpenPRFileOverlaps(
  repoPath: string,
  plannedFiles: string[],
  /**
   * Which open PRs count as competing work.
   *
   * A PR reserves its files while a worker is editing them, and `publishOnPark`
   * leaves a PR behind long after its worker exits — so an open PR alone is not
   * evidence of anyone editing. Two exclusions follow: the dispatched issue's
   * own PR (AGT-4095), and a `swarm/*` PR whose run no longer holds a lease
   * (AGT-4097).
   *
   * A branch outside the `swarm/` namespace — a human's, another tool's — has
   * no run to consult, so it always reserves.
   *
   * `activeIssueIdentifiers` distinguishes "none are active" from "I cannot
   * tell": an array, **including an empty one**, asserts it is the complete set
   * of held leases; `undefined` means the caller has no ledger to ask, and
   * every `swarm/*` PR keeps reserving. Getting those two confused would empty
   * the gate on any caller that simply never wired the accessor.
   */
  competing: {
    selfIssueIdentifier?: string;
    /** Issues whose runs a worker currently holds; undefined when unknowable. */
    activeIssueIdentifiers?: readonly string[];
  } = {},
): Promise<OpenPRFileOverlap[]> {
  // A documentation path is never ownership (AGT-4422): the requirements
  // ledger every cgf-portal PR updates made one open hand PR supersede every
  // task in the repository.
  const planned = new Set(plannedFiles.map((f) => f.replace(/^\.\//, '')).filter((f) => !isDocumentationPath(f)));
  if (planned.size === 0) return [];
  try {
    // `files` is available on `gh pr list --json`; fetch every scope in one API
    // request instead of running an unbounded `gh pr diff` loop.
    // gh paginates internally up to the requested limit. 1,000 is a deliberate
    // safety ceiling well above GitHub's practical open-PR queue sizes while
    // keeping one bounded request and covering the former 100-PR blind spot.
    const raw = await gh(repoPath, 'pr', 'list', '--state', 'open', '--json', 'number,url,headRefName,files', '--limit', '1000');
    const prs: { number: number; url: string; headRefName: string; files?: { path: string }[] }[] = JSON.parse(raw || '[]');
    const overlaps: OpenPRFileOverlap[] = [];
    for (const pr of prs) {
      if (competing.selfIssueIdentifier && isBranchForIssue(pr.headRefName, competing.selfIssueIdentifier)) continue;
      const active = competing.activeIssueIdentifiers;
      const heldByAWorker = active === undefined
        || active.some((id) => isBranchForIssue(pr.headRefName, id));
      if (isSwarmBranch(pr.headRefName) && !heldByAWorker) continue;
      const shared = (pr.files ?? []).map((f) => f.path).filter((f) => planned.has(f.replace(/^\.\//, '')));
      if (shared.length === 0) continue;
      if (!isSwarmBranch(pr.headRefName) && shared.length * 2 < planned.size) {
        // A human's PR that brushes the plan is not a second implementation of
        // it (AGT-4422): cgf-portal #552 shared 1 of AX-1526's 24 files — the
        // job-schedule registry every scheduling issue appends to — and that
        // superseded the task. The daemon-vs-daemon rule stays as it was.
        console.log(`[Worktree] Open PR #${pr.number} (${pr.headRefName}) shares ${shared.length} of ${planned.size} planned files — below the ownership threshold, not a duplicate: ${shared.join(', ')}`);
        continue;
      }
      overlaps.push({ number: pr.number, url: pr.url, label: `PR #${pr.number} (${pr.headRefName})`, files: shared });
    }
    return overlaps;
  } catch (err) {
    console.warn('[Worktree] Preflight open-PR overlap check skipped:', err);
    return [];
  }
}

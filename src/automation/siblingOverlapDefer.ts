// ============================================
// OpenSwarm — serialize an approved run behind an open sibling PR (AGT-4786)
// ============================================
//
// On 2026-10-20 cgf-portal got parallel swarm PRs over the same files (#1341
// vs #1320): the body listed the overlap as advisory and both were published.
// Two open PRs editing the same files are two implementations of one change;
// whichever merges second conflicts or silently reverts the first.
//
// So an approved run whose changed files overlap an open sibling `swarm/*` PR
// opens no PR. It ends `deferred` with a `retryAt`, which the coordinator turns
// into RETRY_AT and the scheduler re-queues; the runner preserves the worktree
// (a WIP commit on the swarm branch, the directory kept while it holds
// uncommitted edits), and the retry resumes from that branch once the sibling
// has merged or closed.
//
// Decisions:
// - Overlap: deferred with a doubling delay (30 min → 4 h). After
//   MAX_OVERLAP_DEFERRALS consecutive overlap deferrals the run publishes
//   normally — the PR body still lists the overlap (INT-2392) — because every
//   deferral re-runs the worker and reviewer, and `deferred` attempts count
//   neither toward the failure circuit nor the cost estimate, so nothing else
//   would ever stop it.
// - Lookup failure (git or GitHub cannot answer): fail safe, defer — a
//   publication we cannot check is the one this gate exists to stop. Capped at
//   MAX_LOOKUP_FAILURE_DEFERRALS consecutive failures, after which it
//   publishes: the PR path needs the same GitHub, so a lasting outage fails
//   there loudly instead of deferring forever.
// - A branch that already has its own open PR is not gated: the publication
//   reuses that PR and opens nothing new, and gating it would deadlock two
//   parked drafts that each see the other.
// - Counts are per issue and process-local: a restart resets them, which at
//   worst allows another full set of deferrals. A publish resets them.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { broadcastEvent } from '../core/eventHub.js';
import { gh } from '../support/ghPullRequests.js';
import { isSwarmBranch } from '../support/branchNaming.js';
import { findOpenPRFileOverlaps, type OpenPRFileOverlap } from '../support/openPullRequestOverlaps.js';
import { resolveBaseRef, type WorktreeInfo } from '../support/worktreeManager.js';

const execFileAsync = promisify(execFile);

export const MAX_OVERLAP_DEFERRALS = 4;
export const MAX_LOOKUP_FAILURE_DEFERRALS = 3;
export const OVERLAP_DEFER_BASE_MS = 30 * 60_000;
export const LOOKUP_FAILURE_DEFER_MS = 10 * 60_000;

export interface SiblingOverlapDeps {
  /** Repository-relative files this branch changes, committed or not. */
  changedFiles?: (info: WorktreeInfo) => Promise<string[]>;
  /** URL of an open PR whose head is this branch, or null. Throws when it cannot tell. */
  ownOpenPullRequest?: (info: WorktreeInfo) => Promise<string | null>;
  /** Open PRs sharing those files. Throws when it cannot tell. */
  overlaps?: (repoPath: string, files: string[], selfIssueIdentifier: string | undefined) => Promise<OpenPRFileOverlap[]>;
  now?: () => number;
}

export type SiblingOverlapDecision =
  | { action: 'publish'; note?: string }
  | { action: 'defer'; retryAt: number; reason: string };

const deferrals = new Map<string, { overlap: number; lookup: number }>();

/** Test hook: forget every per-issue deferral count. */
export function resetSiblingOverlapDeferrals(): void {
  deferrals.clear();
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 60_000 });
  return stdout;
}

/** Changed since the branch left its base, including uncommitted and untracked files: the commit happens later. */
async function defaultChangedFiles(info: WorktreeInfo): Promise<string[]> {
  const base = await resolveBaseRef(info.worktreePath);
  const mergeBase = (await git(info.worktreePath, 'merge-base', base.ref, 'HEAD')).trim();
  const tracked = await git(info.worktreePath, 'diff', '--name-only', mergeBase);
  const untracked = await git(info.worktreePath, 'ls-files', '--others', '--exclude-standard');
  return [...new Set(`${tracked}\n${untracked}`.split('\n').map((f) => f.trim()).filter(Boolean))];
}

async function defaultOwnOpenPullRequest(info: WorktreeInfo): Promise<string | null> {
  const raw = await gh(info.worktreePath, 'pr', 'list', '--head', info.branchName, '--state', 'open', '--json', 'url', '--limit', '1');
  const rows = JSON.parse(raw || '[]') as Array<{ url?: string }>;
  return rows.find((row) => row.url)?.url ?? null;
}

function defaultOverlaps(repoPath: string, files: string[], selfIssueIdentifier: string | undefined): Promise<OpenPRFileOverlap[]> {
  // `activeIssueIdentifiers` left undefined: every open swarm PR reserves its
  // files, including a parked draft whose worker has exited — those are the
  // siblings the 2026-10-20 night published next to.
  return findOpenPRFileOverlaps(repoPath, files, { selfIssueIdentifier }, { throwOnLookupFailure: true });
}

function describeOverlaps(overlaps: OpenPRFileOverlap[]): string {
  return overlaps
    .map((o) => `${o.url} (${o.headRefName}): ${[...o.files].sort().map((f) => `\`${f}\``).join(', ')}`)
    .sort()
    .join('; ');
}

/** Should this approved run publish now, or wait for an open sibling swarm PR? Never throws. */
export async function siblingOverlapDecision(
  info: WorktreeInfo,
  issueIdentifier: string | undefined,
  deps: SiblingOverlapDeps = {},
): Promise<SiblingOverlapDecision> {
  const now = (deps.now ?? Date.now)();
  const key = issueIdentifier || info.branchName;
  const count = deferrals.get(key) ?? { overlap: 0, lookup: 0 };
  let siblings: OpenPRFileOverlap[];
  try {
    if (await (deps.ownOpenPullRequest ?? defaultOwnOpenPullRequest)(info)) {
      deferrals.delete(key);
      return { action: 'publish' };
    }
    const files = await (deps.changedFiles ?? defaultChangedFiles)(info);
    siblings = files.length === 0
      ? []
      : (await (deps.overlaps ?? defaultOverlaps)(info.worktreePath, files, issueIdentifier))
        .filter((o) => isSwarmBranch(o.headRefName) && o.headRefName !== info.branchName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    if (count.lookup >= MAX_LOOKUP_FAILURE_DEFERRALS) {
      deferrals.delete(key);
      return { action: 'publish', note: `sibling overlap lookup failed ${count.lookup + 1} times in a row; publishing anyway: ${detail}` };
    }
    deferrals.set(key, { ...count, lookup: count.lookup + 1 });
    return {
      action: 'defer',
      retryAt: now + LOOKUP_FAILURE_DEFER_MS,
      reason: `could not check open sibling PRs for file overlap (${count.lookup + 1}/${MAX_LOOKUP_FAILURE_DEFERRALS}), so no PR was opened: ${detail}`,
    };
  }
  if (siblings.length === 0) {
    deferrals.delete(key);
    return { action: 'publish' };
  }
  const described = describeOverlaps(siblings);
  if (count.overlap >= MAX_OVERLAP_DEFERRALS) {
    deferrals.delete(key);
    return { action: 'publish', note: `still overlaps an open sibling PR after ${count.overlap} deferrals; publishing with the overlap listed: ${described}` };
  }
  deferrals.set(key, { overlap: count.overlap + 1, lookup: 0 });
  return {
    action: 'defer',
    retryAt: now + OVERLAP_DEFER_BASE_MS * 2 ** count.overlap,
    reason: `approved, but its files overlap an open sibling PR, so no PR was opened (deferral ${count.overlap + 1}/${MAX_OVERLAP_DEFERRALS}): ${described}`,
  };
}

/** The result fields the defer writes. */
export interface DeferrableResult {
  success?: boolean;
  finalStatus?: string;
  failureDetail?: string;
  retryAt?: number;
}

/**
 * Apply {@link siblingOverlapDecision} to an approved run. Returns true when
 * the run was deferred: `finalStatus: 'deferred'` with a `retryAt`, which the
 * coordinator schedules as RETRY_AT and the runner preserves like any run that
 * did not end approved. The reason names the overlapping PRs once, in the log
 * line and in `failureDetail`, which the ledger records.
 */
export async function deferForSiblingOverlap(
  info: WorktreeInfo,
  task: { id: string; issueId?: string; issueIdentifier?: string },
  result: DeferrableResult,
  deps?: SiblingOverlapDeps,
): Promise<boolean> {
  const decision = await siblingOverlapDecision(info, task.issueIdentifier, deps);
  const taskId = task.issueId || task.id;
  if (decision.action === 'publish') {
    if (decision.note) {
      console.warn(`[Runner] ${task.issueIdentifier}: ${decision.note}`);
      broadcastEvent({ type: 'log', data: { taskId, stage: 'pr', line: decision.note } });
    }
    return false;
  }
  result.success = false;
  result.finalStatus = 'deferred';
  result.retryAt = decision.retryAt;
  result.failureDetail = `publication: ${decision.reason}`;
  const line = `Publication deferred until ${new Date(decision.retryAt).toISOString()}: ${decision.reason}`;
  console.warn(`[Runner] ${task.issueIdentifier}: ${line}`);
  broadcastEvent({ type: 'log', data: { taskId, stage: 'pr', line } });
  return true;
}

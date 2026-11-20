// ============================================
// OpenSwarm - Keep an unfinished run's work on the remote, without a PR (AGT-4786)
// ============================================
//
// #844 stopped failed, rejected, infra_error and rate_limited runs from opening
// draft PRs: on 2026-10-20 they made 25 of them in one night. It left the work
// on the local swarm branch only (preserveWorktree's WIP commit), because the
// secret-leak guard that must precede any push lived inside
// commitAndCreatePRWithHead. This is that follow-up.
//
// After the worktree is preserved, an unfinished run:
// - pushes its swarm branch, once the fences the PR path uses pass (write
//   scope, sensitive data and unsafe binary data, all checked against the
//   branch ref, so they work whether or not preserveWorktree kept the
//   directory). The WIP commit runs with --no-verify and no staging guard, so
//   the binary check here is the only one that sees it;
// - never pushes onto a branch an open pull request tracks: a retry of an
//   issue that already has a reviewed PR would otherwise land failed WIP on
//   it. A lookup that cannot answer keeps the branch local (fail closed);
// - posts one summary comment on the issue: what ended the run, the branch,
//   and how far it is ahead of the base. Keyed per issue, branch head and
//   whether it was pushed, so neither a retried post nor a retried run with no
//   new commits repeats it, while a later push of a held head still says so.
// No PR. A fence refusal keeps the branch local and says why in the comment.
// Never throws: the run's outcome is already decided.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import { resolveBaseRef } from '../support/worktreeManager.js';
import { assertBranchWithinWriteScope } from '../support/publicationScopeFence.js';
import { assertNoSensitiveDataOnBranch } from '../support/sensitiveDataFence.js';
import { unsafeBinaryDataOnBranch } from '../support/unsafeBinaryData.js';
import { gh } from '../support/ghPullRequests.js';
import { summarizeFailure } from './publishOnPark.js';
import { enforcedFileScope, type FileScopeSource } from '../orchestration/writeScope.js';
import type { ITaskSource } from './taskSource.js';

const execFileAsync = promisify(execFile);

/** Outcomes that are a run not finishing, as opposed to a park, a cancel or a hand-off. */
const UNFINISHED_STATUSES = new Set(['failed', 'rejected', 'infra_error', 'rate_limited']);

type UnfinishedResult = Pick<PipelineResult, 'success' | 'finalStatus' | 'prUrl' | 'operatorPark' | 'failureDetail' | 'sessionId'>
  & { workerResult?: { executionOutcomeUnknown?: boolean }; reviewResult?: { executionOutcomeUnknown?: boolean }; testerResult?: { executionOutcomeUnknown?: boolean } };

export function shouldKeepUnfinishedOnRemote(result: UnfinishedResult | undefined): boolean {
  if (!result || result.success || !UNFINISHED_STATUSES.has(String(result.finalStatus))) return false;
  if (result.prUrl) return false; // already has a remote home
  if (result.operatorPark) return false; // the park path publishes it
  // A run that lost its lease is not this executor's to publish: a newer
  // generation owns the branch (the pre-#844 path refused these too).
  if (/lease fence|lease lost|lease expired/i.test(result.failureDetail ?? '')) return false;
  // A sandbox whose outcome is unknown may have written anything; do not push it.
  if (result.workerResult?.executionOutcomeUnknown || result.reviewResult?.executionOutcomeUnknown || result.testerResult?.executionOutcomeUnknown) return false;
  return true;
}

export interface UnfinishedBranchDeps {
  git?: (cwd: string, ...args: string[]) => Promise<string>;
  resolveBase?: (repoPath: string) => Promise<{ remote: string; branch: string; ref: string }>;
  source?: Pick<ITaskSource, 'addComment'> | null;
  checkScope?: (repoPath: string, baseRef: string, fileScope: readonly string[] | undefined, head: string) => Promise<void>;
  checkSensitive?: (repoPath: string, baseRef: string, head: string) => Promise<void>;
  /** Unsafe binary data (.duckdb/.parquet/.pkl/.pt) the branch adds over its base. */
  unsafeBinary?: (repoPath: string, baseRef: string, head: string) => Promise<string[]>;
  /** URL of an open pull request whose head is this branch, or null. Throws when it cannot tell. */
  openPullRequest?: (repoPath: string, branch: string) => Promise<string | null>;
}

export interface UnfinishedBranchOutcome {
  pushed: boolean;
  commitsAhead: number;
  commented: boolean;
  heldReason?: string;
}

interface UnfinishedTask {
  issueId?: string;
  issueIdentifier?: string;
  fileScope?: string[];
  fileScopeSource?: FileScopeSource;
}

async function defaultOpenPullRequest(repoPath: string, branch: string): Promise<string | null> {
  const raw = await gh(repoPath, 'pr', 'list', '--head', branch, '--state', 'open', '--json', 'url', '--limit', '1');
  const rows = JSON.parse(raw || '[]') as Array<{ url?: string }>;
  return rows.find((row) => row.url)?.url ?? null;
}

async function defaultGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: 5 * 60_000 });
  return stdout;
}

export function unfinishedRunComment(input: {
  status: string;
  branch: string;
  commitsAhead: number;
  baseRef: string;
  pushed: boolean;
  heldReason?: string;
  failure?: string;
}): string {
  const where = input.commitsAhead === 0
    ? `No commits on \`${input.branch}\` beyond \`${input.baseRef}\`, so there is nothing to keep.`
    : input.pushed
      ? `The work is on \`${input.branch}\` (${input.commitsAhead} commit${input.commitsAhead === 1 ? '' : 's'} ahead of \`${input.baseRef}\`), pushed to the remote. No pull request was opened.`
      : `The work stays on the local branch \`${input.branch}\` (${input.commitsAhead} commit${input.commitsAhead === 1 ? '' : 's'} ahead of \`${input.baseRef}\`) and was not pushed: ${input.heldReason}`;
  return [
    `🧭 **[OpenSwarm] Run ended \`${input.status}\`. No pull request.**`,
    '',
    where,
    '',
    `What ended it: ${summarizeFailure(input.failure)}`,
  ].join('\n');
}

export async function keepUnfinishedWorkOnRemote(
  info: Pick<WorktreeInfo, 'originalPath' | 'branchName'>,
  task: UnfinishedTask,
  result: UnfinishedResult,
  deps: UnfinishedBranchDeps = {},
): Promise<UnfinishedBranchOutcome> {
  const outcome: UnfinishedBranchOutcome = { pushed: false, commitsAhead: 0, commented: false };
  if (!shouldKeepUnfinishedOnRemote(result)) return outcome;
  const git = deps.git ?? defaultGit;
  const repo = info.originalPath;
  const branch = info.branchName;
  let baseRef = 'the base branch';
  let headSha: string | undefined;
  try {
    const base = await (deps.resolveBase ?? resolveBaseRef)(repo);
    baseRef = base.ref;
    outcome.commitsAhead = parseInt((await git(repo, 'rev-list', '--count', `${base.ref}..${branch}`)).trim(), 10) || 0;
    headSha = (await git(repo, 'rev-parse', '--verify', `${branch}^{commit}`).catch(() => '')).trim() || undefined;
    if (outcome.commitsAhead > 0) {
      try {
        await (deps.checkScope ?? assertBranchWithinWriteScope)(repo, base.ref, enforcedFileScope(task), branch);
        await (deps.checkSensitive ?? assertNoSensitiveDataOnBranch)(repo, base.ref, branch);
        const binaries = await (deps.unsafeBinary ?? unsafeBinaryDataOnBranch)(repo, base.ref, branch);
        if (binaries.length > 0) {
          throw new Error(`the branch carries unsafe binary data the PR path never publishes (INT-2430): ${binaries.join(', ')}`);
        }
        let openPr: string | null;
        try {
          openPr = await (deps.openPullRequest ?? defaultOpenPullRequest)(repo, branch);
        } catch (error) {
          throw new Error(`could not check for an open pull request on the branch, so it was not pushed: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (openPr) {
          throw new Error(`an open pull request (${openPr}) already tracks this branch; pushing unfinished work would land on it`);
        }
        await git(repo, 'push', '-u', base.remote, `${branch}:${branch}`, '--force-with-lease');
        outcome.pushed = true;
      } catch (error) {
        outcome.heldReason = error instanceof Error ? error.message : String(error);
      }
    }
  } catch (error) {
    outcome.heldReason = `could not inspect the branch: ${error instanceof Error ? error.message : String(error)}`;
  }

  const source = deps.source;
  if (source && task.issueId) {
    try {
      await source.addComment(task.issueId, unfinishedRunComment({
        status: String(result.finalStatus),
        branch,
        commitsAhead: outcome.commitsAhead,
        baseRef,
        pushed: outcome.pushed,
        heldReason: outcome.heldReason,
        failure: result.failureDetail,
      }), `unfinished-run:${task.issueId}:${headSha ?? result.sessionId}:${outcome.pushed ? 'pushed' : 'local'}`);
      outcome.commented = true;
    } catch (error) {
      console.warn(`[Runner] Unfinished-run comment failed for ${task.issueIdentifier ?? task.issueId}:`, error);
    }
  }
  console.log(`[Runner] Unfinished run ${task.issueIdentifier ?? task.issueId}: ${outcome.pushed ? `pushed ${branch}` : `kept ${branch} local${outcome.heldReason ? ` (${outcome.heldReason})` : ''}`}, no PR`);
  return outcome;
}

// ============================================
// OpenSwarm - Reactive sibling integration
// ============================================

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  getOpenPRsOrThrow,
  getPRMergeability,
  type PRInfo,
  type PRMergeability,
} from '../github/index.js';
import { safeConsole as console } from '../support/safeLog.js';
import type { OwnedPR } from './prOwnership.js';

const execFileAsync = promisify(execFile);

async function defaultGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

export type IntegrationConflictEvidence = {
  repo: string;
  prNumber: number;
  branch: string;
  issueIdentifier: string;
  mergedPRNumber: number;
  mergedBranch: string;
  mergeCommitOid: string;
  baseBranch: string;
  baseOid: string;
  expectedHeadOid: string;
  conflictFiles: string[];
};

export type IntegrationSiblingResult = {
  repo: string;
  prNumber: number;
  branch: string;
  issueIdentifier?: string;
  status:
    | 'rebased'
    | 'already-current'
    | 'conflict-routed'
    | 'skipped-active'
    | 'skipped-fork'
    | 'mergeability-unknown'
    | 'failed';
  mergeability?: PRMergeability;
  conflictFiles?: string[];
  error?: string;
};

export type IntegrationPassResult = {
  repo: string;
  mergedPRNumber: number;
  mergeCommitOid: string;
  results: IntegrationSiblingResult[];
  /** False means a later scan must resume this durable merge event. */
  complete: boolean;
};

export type MergedPREvent = {
  repo: string;
  prNumber: number;
  branch: string;
  baseBranch: string;
  mergeCommitOid: string;
};

export interface IntegrationCoordinatorConfig {
  /** Undefined means the durable lease authority is unavailable; fail closed. */
  getActiveLeaseBranches(projectPath: string): string[] | undefined | Promise<string[] | undefined>;
  getActiveLeaseIdentifiers(projectPath: string): string[] | undefined | Promise<string[] | undefined>;
  routeConflict(evidence: IntegrationConflictEvidence): Promise<void>;
  listOpenPRs?: (repo: string, limit: number) => Promise<PRInfo[]>;
  readMergeability?: (repo: string, prNumber: number) => Promise<PRMergeability>;
  git?: (cwd: string, ...args: string[]) => Promise<string>;
  wait?: (milliseconds: number) => Promise<void>;
  mergeabilityAttempts?: number;
  mergeabilityPollMs?: number;
  scratchRoot?: () => string | Promise<string>;
}

function parseWorktreeBranches(porcelain: string): Set<string> {
  const branches = new Set<string>();
  for (const line of porcelain.split('\n')) {
    if (!line.startsWith('branch refs/heads/')) continue;
    branches.add(line.slice('branch refs/heads/'.length));
  }
  return branches;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exitCode(error: unknown): number | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? Number((error as { code?: unknown }).code)
    : undefined;
}

/**
 * Rebases open, owned sibling PRs only after another owned PR is observed
 * merged. Every sibling gets a detached scratch worktree; the repository's
 * shared checkout is never checked out, reset, or merged in place.
 */
export class IntegrationCoordinator {
  private readonly git: (cwd: string, ...args: string[]) => Promise<string>;
  private readonly listOpenPRs: (repo: string, limit: number) => Promise<PRInfo[]>;
  private readonly readMergeability: (repo: string, prNumber: number) => Promise<PRMergeability>;
  private readonly wait: (milliseconds: number) => Promise<void>;

  constructor(private readonly config: IntegrationCoordinatorConfig) {
    this.git = config.git ?? defaultGit;
    this.listOpenPRs = config.listOpenPRs ?? getOpenPRsOrThrow;
    this.readMergeability = config.readMergeability ?? getPRMergeability;
    this.wait = config.wait ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  }

  async integrate(
    event: MergedPREvent,
    projectPath: string,
    ownedPRs: readonly OwnedPR[],
  ): Promise<IntegrationPassResult> {
    const ownedByNumber = new Map(ownedPRs.map((pr) => [pr.prNumber, pr]));
    const open = await this.listOpenPRs(event.repo, 1_000);
    const siblings = open.filter((pr) =>
      pr.number !== event.prNumber
      && ownedByNumber.has(pr.number)
      && (pr.baseBranch == null || pr.baseBranch === event.baseBranch));

    const results: IntegrationSiblingResult[] = [];
    for (const sibling of siblings) {
      const owned = ownedByNumber.get(sibling.number)!;
      if (sibling.isFork) {
        results.push(this.result(sibling, owned, 'skipped-fork'));
        continue;
      }
      try {
        results.push(await this.integrateSibling(event, sibling, owned, projectPath));
      } catch (error) {
        const message = errorMessage(error);
        console.error(`[IntegrationCoordinator] ${event.repo}#${sibling.number} failed:`, message);
        results.push(this.result(sibling, owned, 'failed', { error: message }));
      }
    }

    return {
      repo: event.repo,
      mergedPRNumber: event.prNumber,
      mergeCommitOid: event.mergeCommitOid,
      results,
      complete: results.every((result) =>
        result.status === 'rebased'
        || result.status === 'already-current'
        || result.status === 'conflict-routed'
        || result.status === 'skipped-fork'),
    };
  }

  private async integrateSibling(
    event: MergedPREvent,
    sibling: PRInfo,
    owned: OwnedPR,
    projectPath: string,
  ): Promise<IntegrationSiblingResult> {
    if (!owned.issueIdentifier) {
      return this.result(sibling, owned, 'failed', {
        error: 'Owning issue identifier is unavailable; active lease ownership cannot be verified',
      });
    }
    const activeReason = await this.activeReason(projectPath, sibling.branch, owned.issueIdentifier);
    if (activeReason) {
      return this.result(sibling, owned, 'skipped-active', { error: activeReason });
    }

    const scratchId = randomUUID();
    const scratchRoot = this.config.scratchRoot
      ? await this.config.scratchRoot()
      : await mkdtemp(join(tmpdir(), 'openswarm-integration-'));
    const worktreePath = join(scratchRoot, 'worktree');
    const headRef = `refs/openswarm/integration/${scratchId}/head`;
    const baseRef = `refs/openswarm/integration/${scratchId}/base`;
    let worktreeAdded = false;

    try {
      await this.git(
        projectPath,
        'fetch', 'origin',
        `pull/${sibling.number}/head:${headRef}`,
        `refs/heads/${event.baseBranch}:${baseRef}`,
      );
      const expectedHeadOid = (await this.git(projectPath, 'rev-parse', headRef)).trim();
      const baseOid = (await this.git(projectPath, 'rev-parse', baseRef)).trim();

      if (await this.isAncestor(projectPath, baseOid, expectedHeadOid)) {
        return await this.withMergeability(sibling, owned, 'already-current');
      }

      await this.git(projectPath, 'worktree', 'add', '--detach', worktreePath, expectedHeadOid);
      worktreeAdded = true;
      try {
        await this.git(worktreePath, 'rebase', baseOid);
      } catch (error) {
        const conflictFiles = (await this.git(worktreePath, 'diff', '--name-only', '--diff-filter=U'))
          .split('\n').map((file) => file.trim()).filter(Boolean);
        await this.abortRebase(worktreePath);
        if (conflictFiles.length === 0) throw error;
        if (!owned.issueIdentifier) {
          throw new Error(`Cannot route integration conflict: ${event.repo}#${sibling.number} has no owning issue identifier`);
        }
        await this.config.routeConflict({
          repo: event.repo,
          prNumber: sibling.number,
          branch: sibling.branch,
          issueIdentifier: owned.issueIdentifier,
          mergedPRNumber: event.prNumber,
          mergedBranch: event.branch,
          mergeCommitOid: event.mergeCommitOid,
          baseBranch: event.baseBranch,
          baseOid,
          expectedHeadOid,
          conflictFiles,
        });
        return this.result(sibling, owned, 'conflict-routed', { conflictFiles });
      }

      // Re-read both authorities immediately before the only remote mutation.
      // A worker may have claimed or checked out this branch while the rebase ran.
      const pushBlocker = await this.activeReason(projectPath, sibling.branch, owned.issueIdentifier);
      if (pushBlocker) {
        return this.result(sibling, owned, 'skipped-active', { error: pushBlocker });
      }
      await this.git(
        worktreePath,
        'push', 'origin', `HEAD:refs/heads/${sibling.branch}`,
        `--force-with-lease=refs/heads/${sibling.branch}:${expectedHeadOid}`,
      );
      return await this.withMergeability(sibling, owned, 'rebased');
    } finally {
      if (worktreeAdded) {
        try {
          await this.git(projectPath, 'worktree', 'remove', '--force', worktreePath);
        } catch (error) {
          console.error(`[IntegrationCoordinator] Failed to remove scratch worktree ${worktreePath}:`, errorMessage(error));
        }
      }
      for (const ref of [headRef, baseRef]) {
        try {
          await this.git(projectPath, 'update-ref', '-d', ref);
        } catch (error) {
          console.error(`[IntegrationCoordinator] Failed to remove scratch ref ${ref}:`, errorMessage(error));
        }
      }
      await rm(scratchRoot, { recursive: true, force: true }).catch((error) =>
        console.error(`[IntegrationCoordinator] Failed to remove scratch root ${scratchRoot}:`, errorMessage(error)));
    }
  }

  private async activeReason(projectPath: string, branch: string, issueIdentifier: string): Promise<string | null> {
    const [leaseBranches, leaseIdentifiers] = await Promise.all([
      this.config.getActiveLeaseBranches(projectPath),
      this.config.getActiveLeaseIdentifiers(projectPath),
    ]);
    if (leaseBranches === undefined || leaseIdentifiers === undefined) return 'durable lease state unavailable';
    if (leaseBranches.includes(branch)) return 'branch has an active durable worker lease';
    if (leaseIdentifiers.includes(issueIdentifier)) return 'owning issue has an active durable worker lease';
    const worktreeBranches = parseWorktreeBranches(await this.git(projectPath, 'worktree', 'list', '--porcelain'));
    return worktreeBranches.has(branch) ? 'branch is checked out in an active worktree' : null;
  }

  private async isAncestor(projectPath: string, ancestor: string, descendant: string): Promise<boolean> {
    try {
      await this.git(projectPath, 'merge-base', '--is-ancestor', ancestor, descendant);
      return true;
    } catch (error) {
      if (exitCode(error) === 1) return false;
      throw error;
    }
  }

  private async abortRebase(worktreePath: string): Promise<void> {
    try {
      await this.git(worktreePath, 'rebase', '--abort');
    } catch (error) {
      console.error(`[IntegrationCoordinator] Failed to abort rebase in ${worktreePath}:`, errorMessage(error));
    }
  }

  private async withMergeability(
    sibling: PRInfo,
    owned: OwnedPR,
    successStatus: 'rebased' | 'already-current',
  ): Promise<IntegrationSiblingResult> {
    const attempts = Math.max(1, this.config.mergeabilityAttempts ?? 3);
    let mergeability: PRMergeability = 'UNKNOWN';
    for (let attempt = 0; attempt < attempts; attempt++) {
      mergeability = await this.readMergeability(sibling.repo, sibling.number);
      if (mergeability !== 'UNKNOWN') break;
      if (attempt + 1 < attempts) await this.wait(this.config.mergeabilityPollMs ?? 2_000);
    }
    if (mergeability === 'UNKNOWN') {
      return this.result(sibling, owned, 'mergeability-unknown', { mergeability });
    }
    if (mergeability === 'CONFLICTING') {
      return this.result(sibling, owned, 'failed', {
        mergeability,
        error: 'GitHub still reports CONFLICTING after integration',
      });
    }
    return this.result(sibling, owned, successStatus, { mergeability });
  }

  private result(
    sibling: PRInfo,
    owned: OwnedPR,
    status: IntegrationSiblingResult['status'],
    extra: Partial<IntegrationSiblingResult> = {},
  ): IntegrationSiblingResult {
    return {
      repo: sibling.repo,
      prNumber: sibling.number,
      branch: sibling.branch,
      issueIdentifier: owned.issueIdentifier,
      status,
      ...extra,
    };
  }
}

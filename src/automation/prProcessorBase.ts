import { Cron } from 'croner';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';
import { createPipelineFromConfig } from '../agents/pairPipeline.js';
import {
  commentOnPROrThrow,
  getMergedPRsOrThrow,
  getPRBaseBranchOrThrow,
  type PRInfo,
} from '../github/index.js';
import { runReviewCommand, formatReviewOutput } from '../cli/reviewCommand.js';
import {
  captureReviewFileHashes,
  loadReviewHistory,
  renderReviewHistoryContext,
  saveReviewHistory,
} from '../cli/reviewHistory.js';
import type { DefaultRolesConfig, ConflictResolverConfig, SecurityAuditConfig } from '../core/types.js';
import { ConflictResolver } from './conflictResolver.js';
import { DEFAULT_SECURITY_AUDIT_CONFIG } from '../verify/securityAudit.js';
import {
  IntegrationCoordinator,
  type IntegrationCoordinatorConfig,
} from './integrationCoordinator.js';
import { getOwnedPRsForRepo } from './prOwnership.js';
import { ghRepoView, gitExec, PRState, PRStateSchema, PR_STATE_PATH } from './prProcessorShared.js';

export interface PRProcessorConfig {
  repos: string[];
  schedule: string;
  maxIterations: number;
  roles?: DefaultRolesConfig;
  maxRetries?: number;          // Max retry attempts per PR (default: 3)
  ciTimeoutMs?: number;         // CI completion timeout (default: 10min)
  ciPollIntervalMs?: number;    // CI polling interval (default: 30s)
  conflictResolver?: ConflictResolverConfig;
  repoMappings?: Record<string, string>; // Custom repo → local path mappings
  /** Inherited autonomous CodeQL policy for every PR remediation pipeline. */
  securityAudit?: SecurityAuditConfig;
  /** Runtime-only wiring to the durable runner; not a user configuration surface. */
  postMergeIntegration?: Pick<IntegrationCoordinatorConfig,
    'getActiveLeaseBranches' | 'getActiveLeaseIdentifiers' | 'withIntegrationReservation' | 'routeConflict'>;
  /**
   * Called once when an owned PR is observed as newly merged (not the historical
   * baseline). Marks the tracker Done — open≠shipped (AGT-4077).
   */
  onOwnedPullRequestMerged?: (info: {
    repo: string;
    prNumber: number;
    branch: string;
    mergeCommitOid: string;
    issueIdentifier?: string;
  }) => Promise<void>;
}

export abstract class PRProcessorBase {
  protected config: PRProcessorConfig;
  protected cronJob: Cron | null = null;
  protected initialRunTimer: NodeJS.Timeout | null = null;
  protected processing = false;
  protected conflictResolver: ConflictResolver | null = null;
  protected integrationCoordinator: IntegrationCoordinator | null = null;
  protected currentPR: string | null = null;
  protected lastRun: number | null = null;
  protected nextRun: number | null = null;
  protected readonly integrationStartedAt = Date.now();

  constructor(config: PRProcessorConfig) {
    this.config = config;
    if (config.conflictResolver?.enabled) {
      this.conflictResolver = new ConflictResolver(config.conflictResolver);
      console.log(`[PRProcessor] ConflictResolver enabled (mode: ${config.conflictResolver.ownershipMode}, maxAttempts: ${config.conflictResolver.maxResolutionAttempts})`);
    }
    if (config.postMergeIntegration) {
      this.integrationCoordinator = new IntegrationCoordinator({
        getActiveLeaseBranches: config.postMergeIntegration.getActiveLeaseBranches,
        getActiveLeaseIdentifiers: config.postMergeIntegration.getActiveLeaseIdentifiers,
        withIntegrationReservation: config.postMergeIntegration.withIntegrationReservation,
        routeConflict: config.postMergeIntegration.routeConflict,
      });
    }
  }

  /**
   * CI-failure and review-feedback repairs must use the same CodeQL policy as
   * ordinary autonomous work. Keeping the construction in one helper avoids a
   * future PR remediation path accidentally omitting the final argument.
   */
  protected createRemediationPipeline() {
    return createPipelineFromConfig(
      this.config.roles,
      this.config.maxIterations,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      this.config.securityAudit ?? DEFAULT_SECURITY_AUDIT_CONFIG,
    );
  }

  /**
   * Get current status (for dashboard)
   */
  getStatus() {
    return {
      processing: this.processing,
      currentPR: this.currentPR,
      lastRun: this.lastRun,
      nextRun: this.nextRun,
      schedule: this.config.schedule,
      repos: this.config.repos,
      conflictResolverEnabled: this.conflictResolver?.isEnabled() ?? false,
    };
  }

  /**
   * One-shot fix for a single PR (CLI `openswarm pr fix` / `pr watch`).
   * Skips cron cooldown and multi-repo scanning — runs processPR directly.
   * (INT-3282)
   */
  async fixOne(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number }> {
    const key = `${pr.repo}#${pr.number}`;
    const state: PRState = {
      prs: {
        [key]: {
          repo: pr.repo,
          prNumber: pr.number,
          status: 'processing',
          iterations: 0,
        },
      },
      integrations: {},
      integrationBaselines: {},
      updatedAt: new Date().toISOString(),
    };
    await this.processPR(pr, projectPath, state, key);
    const entry = state.prs[key];
    return {
      success: entry?.status === 'completed',
      error: entry?.lastError,
      iterations: entry?.iterations ?? 0,
    };
  }

  /**
   * One-shot review-feedback pass for a single PR (CLI `openswarm pr review`).
   * Runs only `processReviewFeedback` — unlike `fixOne`, it does not touch
   * conflicts or wait on CI, so it is safe to call as a lightweight "did a
   * reviewer (Claude, Codex, or a human CHANGES_REQUESTED) leave feedback I
   * haven't addressed yet?" check on demand. (INT-3282)
   *
   * Loads/saves the same durable state file the cron path uses (unlike
   * `fixOne`, which is throwaway-state only). The formal-review freshness
   * gate has no GitHub-visible "already addressed" marker to fall back on the
   * way comments do (no equivalent of the `FEEDBACK_ADDRESSED_MARKERS` scan),
   * so without a persisted watermark, every separate `pr review` invocation
   * would re-detect the same still-open CHANGES_REQUESTED review and
   * re-trigger a fix for it indefinitely.
   */
  async reviewOne(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number }> {
    const key = `${pr.repo}#${pr.number}`;
    const state = await this.loadState();
    state.prs[key] = {
      ...state.prs[key],
      repo: pr.repo,
      prNumber: pr.number,
      status: 'processing',
      iterations: 0,
    };
    await this.processReviewFeedback(pr, projectPath, state, key, 0);
    await this.saveState(state);
    const entry = state.prs[key];
    return {
      success: entry?.status === 'completed',
      error: entry?.lastError,
      iterations: entry?.iterations ?? 0,
    };
  }

  /**
   * One-shot brand-new code review of the PR's current diff (CLI `openswarm
   * pr review --fresh`) — independent of `reviewOne`, which only reacts to
   * feedback a reviewer already left. This runs the same reviewer agentic
   * loop `openswarm review` uses, against base..head, and posts the verdict
   * as a PR comment. Throwaway state: there is nothing to dedupe against
   * (unlike `reviewOne`'s watermark), so every call reviews fresh.
   *
   * Reviews inside a scratch `git worktree` rather than checking out
   * `projectPath` in place. `processPR`/`processReviewFeedback` do check out
   * in place (stash → checkout → restore), which is fine for them — they are
   * the caller's own PR branch, being actively fixed. A fresh review is
   * different: it inspects a PR from the caller's own working directory
   * without the caller asking to be moved anywhere, and a stash-based
   * approach a review-gate.yml comment thread found genuinely broken on
   * every axis it has: `git stash push -u` does not cover ignored files, so
   * a PR that adds a path the caller's `.gitignore` already claims (a
   * generated file, a local `.env`) gets silently overwritten by the
   * checkout and never restored; `stash apply` without `--index` un-stages
   * whatever the caller had staged for their next commit; and restoring an
   * already-detached HEAD by branch name is unreliable. A worktree sidesteps
   * all of it: nothing under `projectPath` is ever touched, so there is
   * nothing to preserve or restore. (INT-3282)
   *
   * `gateRan: false` marks the outcomes where NO verdict was produced — the
   * reviewer crashed, timed out, or returned nothing parseable. Callers must not
   * read those as "the reviewer requested changes"; conflating the two is what
   * made a broken review indistinguishable from a rejecting one. (INT-3914)
   */
  async freshReview(
    pr: PRInfo,
    projectPath: string,
  ): Promise<{ success: boolean; error?: string; iterations: number; gateRan?: boolean; changesRequested?: boolean }> {
    const key = `${pr.repo}#${pr.number}`;
    this.currentPR = key;

    // Set the moment a verdict exists, so the catch below can tell "the reviewer
    // produced nothing" from "the reviewer concluded and a later step failed".
    // (INT-3914)
    let verdictProduced = false;
    let changesRequested = false;
    let worktreePath: string | null = null;
    let prHeadRef: string | null = null;
    let baseRef: string | null = null;
    try {
      // `--repo`/`--number owner/repo#n` can target a different repository
      // than this checkout's `origin` — fetching `pull/<n>/head` would then
      // silently pull the wrong repo's PR (or fail) since it always reads
      // from the local `origin` remote regardless of `pr.repo`. Resolved by
      // handing `origin`'s own URL to `gh repo view` — a bare `gh repo view`
      // (what `resolveRepoName` does for the rest of this CLI surface) is not
      // documented to specifically pick `origin` when a repo has multiple
      // remotes configured, which would let this check pass against one
      // remote while `git fetch origin` below reads from another.
      const originUrl = (await gitExec(projectPath, 'remote', 'get-url', 'origin')).trim();
      const localRepo = await ghRepoView(projectPath, originUrl);
      if (localRepo !== pr.repo) {
        throw new Error(
          `Local origin (${originUrl} → ${localRepo}) does not match PR repo ${pr.repo} — refusing to fetch a possibly-wrong PR from the wrong repository`
        );
      }

      const base = await getPRBaseBranchOrThrow(pr.repo, pr.number);
      // Fetch the PR head via GitHub's own `refs/pull/<n>/head`, not
      // `pr.branch` directly: a fork-originated PR's branch does not exist
      // under `origin` at all, and even same-repo PRs would otherwise reuse
      // whatever a same-named local branch already points at (stale from a
      // prior checkout) instead of the PR's current head — silently
      // reviewing the wrong revision either way.
      //
      // Suffixed with a random id, not just the PR number: two overlapping
      // `pr review --fresh` calls for the same PR (two sessions, or a retry
      // racing the first attempt) would otherwise fetch into the exact same
      // ref names and could hand each other a mid-update or wrong-generation
      // SHA.
      const scratchId = randomUUID();
      prHeadRef = `refs/openswarm/pr-${pr.number}-review-${scratchId}`;
      baseRef = `refs/openswarm/pr-${pr.number}-base-${scratchId}`;
      // Both sides fetched into explicit local refs via `<src>:<dst>`, not a
      // bare branch name for the base — a bare name (a) updates the
      // `origin/<base>` remote-tracking ref only via the remote's configured
      // fetch refspec, which this method has no way to confirm is the normal
      // default for whatever repo it's pointed at, and (b) is ambiguous
      // between a branch and a same-named tag (`refs/heads/<base>` pins it).
      await gitExec(
        projectPath, 'fetch', 'origin',
        `pull/${pr.number}/head:${prHeadRef}`, `refs/heads/${base}:${baseRef}`,
      );

      const reviewedSha = (await gitExec(projectPath, 'rev-parse', prHeadRef)).trim();
      // The merge-base, not the base branch's current tip: the base branch
      // may have moved since the PR diverged, and a two-dot diff (what
      // getDiffText runs under the hood) against its tip would list every
      // commit merged into base since then as if the PR had made those
      // changes too. Same reasoning as review-gate.yml's `Resolve the PR
      // base` step.
      const mergeBase = (await gitExec(projectPath, 'merge-base', prHeadRef, baseRef)).trim();

      const scratchWorktree = join(tmpdir(), `openswarm-pr-review-${pr.number}-${scratchId}`);
      worktreePath = scratchWorktree;
      await gitExec(projectPath, 'worktree', 'add', '--detach', scratchWorktree, reviewedSha);

      const review = await runReviewCommand({
        path: scratchWorktree,
        base: mergeBase,
        // The scratch checkout is the reviewed repository, not OpenSwarm, so
        // config discovery there falls back to the unavailable `codex` CLI.
        // Preserve the daemon's explicitly configured PR reviewer adapter.
        adapter: this.config.roles?.reviewer?.adapter,
        // The checked-out content is another PR's diff — untrusted the same
        // way review-gate.yml's CI run is (INT-3189). Denying mutating tools,
        // including bash, keeps a malicious PR from using the reviewer's
        // shell access and provider credential as an attack surface.
        readOnly: true,
      }, {
        // Both overrides exist for the same reason: the review's cwd is the
        // scratch worktree that `finally` deletes, so the default paths write
        // history into a directory about to vanish and read it from one that was
        // just created empty. Every PR review was therefore unrecorded AND blind
        // to earlier ones. Point both at the real repository, while hashes keep
        // coming from the checkout actually under review. (INT-3914)
        loadHistory: async (_cwd, files) => {
          const [loaded, currentHashes] = await Promise.all([
            loadReviewHistory(projectPath),
            captureReviewFileHashes(scratchWorktree, files),
          ]);
          const rendered = renderReviewHistoryContext(loaded, files, currentHashes);
          return { context: rendered.context, records: rendered.matchingRecords, currentHashes };
        },
        saveHistory: (_cwd, files, reviewResult, base) =>
          saveReviewHistory(projectPath, {
            kind: 'pr',
            base,
            files,
            review: reviewResult,
            hashProjectPath: scratchWorktree,
          }),
      });

      if (!review) {
        // Deliberately gate-not-run rather than `openswarm review`'s exit-0
        // "nothing to review": for an OPEN PR an empty diff against the
        // merge-base is anomalous, not a clean pass, and reporting it as one
        // would be the same silent-approval failure this issue is about.
        return { success: false, error: `No diff found against ${base}`, iterations: 0, gateRan: false };
      }
      verdictProduced = true;
      // Remembered before the comment is posted. `success: false` covers both
      // "the reviewer objected" and "the review broke", and posting the
      // comment can fail on its own (403, rate limit) AFTER an approval — a
      // caller that acts on the verdict must not read that as an objection.
      changesRequested = review.decision !== 'approve';

      // Names the exact commit reviewed: a long-running review racing a new
      // push must not read as an approval of commits it never saw.
      await commentOnPROrThrow(
        pr.repo,
        pr.number,
        [
          `## 🔍 Fresh review of ${reviewedSha.slice(0, 7)} (\`openswarm pr review --fresh\`)`,
          '',
          formatReviewOutput(review, false),
        ].join('\n')
      );

      return {
        success: review.decision === 'approve',
        error: review.decision === 'approve' ? undefined : (review.feedback || 'Reviewer requested changes'),
        iterations: 0,
        gateRan: true,
        changesRequested,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PRProcessor] ${key} fresh review error:`, errorMsg);
      return { success: false, error: errorMsg, iterations: 0, gateRan: verdictProduced, changesRequested };
    } finally {
      if (worktreePath) {
        try {
          await gitExec(projectPath, 'worktree', 'remove', '--force', worktreePath);
        } catch (cleanupErr) {
          console.error(`[PRProcessor] Failed to remove scratch worktree ${worktreePath}:`, cleanupErr);
        }
      }
      // Best-effort — each ref is uniquely named per call, so a leaked one
      // costs disk, not correctness of a later run.
      for (const ref of [prHeadRef, baseRef]) {
        if (!ref) continue;
        try {
          await gitExec(projectPath, 'update-ref', '-d', ref);
        } catch (cleanupErr) {
          console.error(`[PRProcessor] Failed to remove scratch ref ${ref}:`, cleanupErr);
        }
      }
      this.currentPR = null;
    }
  }

  /**
   * Start schedule
   */
  start(): void {
    if (this.cronJob) {
      console.log('[PRProcessor] Already running');
      return;
    }
    console.log(`[PRProcessor] Starting (schedule: ${this.config.schedule})`);

    this.cronJob = new Cron(this.config.schedule, async () => {
      await this.processPRs();
    });

    // Initial run after 30 seconds
    this.initialRunTimer = setTimeout(() => {
      this.initialRunTimer = null;
      void this.processPRs().catch((err) => {
        console.error('[PRProcessor] Initial run error:', err);
      });
    }, 30_000);
    this.initialRunTimer.unref();
  }

  /**
   * Stop schedule
   */
  stop(): void {
    if (this.initialRunTimer) {
      clearTimeout(this.initialRunTimer);
      this.initialRunTimer = null;
    }
    if (this.cronJob) {
      this.cronJob.stop();
      this.cronJob = null;
    }
    console.log('[PRProcessor] Stopped');
  }

  abstract processPRs(): Promise<void>;
  protected abstract processPR(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string
  ): Promise<void>;
  protected abstract processReviewFeedback(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string,
    totalIterations: number
  ): Promise<void>;

  /**
   * Map repo to local project path
   */
  protected mapRepoToProject(repo: string): string | null {
    // Check custom mappings first
    if (this.config.repoMappings?.[repo]) {
      const mapped = this.config.repoMappings[repo].replace(/^~/, homedir());
      if (existsSync(mapped)) {
        return mapped;
      }
      console.log(`[PRProcessor] Custom mapping found but path does not exist: ${repo} → ${mapped}`);
    }

    // Fallback: "Intrect-io/STONKS" → "STONKS"
    const repoName = repo.split('/').pop();
    if (!repoName) return null;

    const candidate = resolve(homedir(), 'dev', repoName);
    if (existsSync(candidate)) {
      return candidate;
    }

    console.log(`[PRProcessor] No local directory for ${repo} (tried: ${candidate})`);
    return null;
  }

  /**
   * Observe each owned merge exactly once into durable PR state, then resume
   * only pending events. The first scan is a deployment baseline: historical
   * merges are recorded without rewriting every still-open branch.
   */
  protected async processMergedIntegrations(repo: string, state: PRState): Promise<void> {
    if (!this.integrationCoordinator) return;
    try {
      const [ownedPRs, mergedPRs] = await Promise.all([
        getOwnedPRsForRepo(repo),
        getMergedPRsOrThrow(repo, 1_000),
      ]);
      const ownedNumbers = new Set(ownedPRs.map((pr) => pr.prNumber));
      const ownedMerges = mergedPRs.filter((pr) => ownedNumbers.has(pr.number));
      const now = new Date().toISOString();

      if (!state.integrationBaselines[repo]) {
        for (const merged of ownedMerges) {
          if (!merged.mergeCommitOid) continue;
          const key = `${repo}#${merged.number}@${merged.mergeCommitOid}`;
          const mergedAt = merged.mergedAt ? new Date(merged.mergedAt).getTime() : Number.NaN;
          state.integrations[key] = {
            repo,
            mergedPRNumber: merged.number,
            mergedBranch: merged.branch,
            baseBranch: merged.baseBranch,
            mergeCommitOid: merged.mergeCommitOid,
            // Do not miss a merge in the interval between daemon start and
            // its first scheduled scan. Only older history is baseline.
            status: !Number.isNaN(mergedAt) && mergedAt >= this.integrationStartedAt
              ? 'pending'
              : 'baseline',
            attempts: 0,
            updatedAt: now,
          };
        }
        state.integrationBaselines[repo] = now;
        await this.saveState(state);
        console.log(`[IntegrationCoordinator] ${repo}: established post-merge baseline (${ownedMerges.length} owned merges observed)`);
      } else {
        let observedNewMerge = false;
        for (const merged of ownedMerges) {
          if (!merged.mergeCommitOid) {
            console.error(`[IntegrationCoordinator] ${repo}#${merged.number}: merged PR has no merge commit OID`);
            continue;
          }
          const key = `${repo}#${merged.number}@${merged.mergeCommitOid}`;
          if (state.integrations[key]) continue;
          state.integrations[key] = {
            repo,
            mergedPRNumber: merged.number,
            mergedBranch: merged.branch,
            baseBranch: merged.baseBranch,
            mergeCommitOid: merged.mergeCommitOid,
            status: 'pending',
            attempts: 0,
            updatedAt: now,
          };
          observedNewMerge = true;
          // Tracker Done waits for merge, not PR open (AGT-4077).
          const owned = ownedPRs.find((pr) => pr.prNumber === merged.number);
          if (this.config.onOwnedPullRequestMerged) {
            try {
              await this.config.onOwnedPullRequestMerged({
                repo,
                prNumber: merged.number,
                branch: merged.branch,
                mergeCommitOid: merged.mergeCommitOid,
                issueIdentifier: owned?.issueIdentifier,
              });
            } catch (err) {
              console.error(
                `[PRProcessor] onOwnedPullRequestMerged failed for ${repo}#${merged.number}:`,
                err,
              );
            }
          }
        }
        // Persist the event before any rebase/push. A daemon crash can resume a
        // pending event, but can never rediscover it as a second event.
        if (observedNewMerge) await this.saveState(state);
      }

      for (const [key, event] of Object.entries(state.integrations)) {
        if (event.repo !== repo || event.status !== 'pending') continue;
        const projectPath = this.mapRepoToProject(repo);
        if (!projectPath) {
          event.lastError = 'No local project path is available';
          event.updatedAt = new Date().toISOString();
          await this.saveState(state);
          continue;
        }
        try {
          const result = await this.integrationCoordinator.integrate({
            repo,
            prNumber: event.mergedPRNumber,
            branch: event.mergedBranch,
            baseBranch: event.baseBranch,
            mergeCommitOid: event.mergeCommitOid,
          }, projectPath, ownedPRs);
          event.attempts += 1;
          event.results = result.results;
          event.updatedAt = new Date().toISOString();
          event.lastError = result.complete
            ? undefined
            : result.results.filter((item) =>
              item.status === 'failed'
              || item.status === 'skipped-active'
              || item.status === 'mergeability-unknown')
              .map((item) => `${item.branch}: ${item.error ?? item.status}`).join('; ') || 'Integration pass deferred';
          if (result.complete) event.status = 'completed';
          await this.saveState(state);
          console.log(`[IntegrationCoordinator] ${key}: ${result.complete ? 'completed' : 'pending'} (${result.results.length} siblings)`);
        } catch (error) {
          event.attempts += 1;
          event.lastError = error instanceof Error ? error.message : String(error);
          event.updatedAt = new Date().toISOString();
          await this.saveState(state);
          console.error(`[IntegrationCoordinator] ${key} pass failed:`, event.lastError);
        }
      }
    } catch (error) {
      // GitHub/ownership discovery failure must not block ordinary PR repair.
      console.error(`[IntegrationCoordinator] ${repo} discovery failed:`, error);
    }
  }

  // ============================================
  // State Persistence
  // ============================================

  protected async loadState(): Promise<PRState> {
    try {
      const data = await readFile(PR_STATE_PATH, 'utf-8');
      return PRStateSchema.parse(JSON.parse(data));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`PR processor state is invalid at ${PR_STATE_PATH}`, { cause: error });
      }
      return { prs: {}, integrations: {}, integrationBaselines: {}, updatedAt: new Date().toISOString() };
    }
  }

  protected async saveState(state: PRState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    atomicWriteFileSync(PR_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  }
}

// ============================================
// OpenSwarm - PR Auto-Improvement Processor
// Open PR auto-improvement (Worker-Reviewer iteration loop)
// ============================================

import { Cron } from 'croner';
import { homedir, tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { safeConsole as console } from '../support/safeLog.js';

const execFileAsync = promisify(execFile);
/** Safe git command execution (no shell) */
async function gitExec(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

/**
 * Resolve `owner/repo` for a specific remote URL via `gh repo view <url>`,
 * rather than `gh repo view` with no argument. The bare form lets `gh` pick
 * whichever remote it considers "the" repository for `cwd`, which is not
 * documented to be `origin` specifically — a repo with more than one remote
 * configured could have `gh` resolve one while a subsequent `git fetch
 * origin ...` reads from another, defeating an identity check meant to catch
 * exactly that mismatch. Passing the caller's own resolved `origin` URL pins
 * both to the same remote.
 */
async function ghRepoView(cwd: string, remoteUrl: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'gh', ['repo', 'view', remoteUrl, '--json', 'nameWithOwner', '-q', '.nameWithOwner'], { cwd }
  );
  return stdout.trim();
}

export type PRIssueComment = {
  author: string;
  body: string;
  createdAt: string;
};

type AutoStash = {
  hash: string;
};

const CRITICAL_COMMENT_KEYWORDS = ['🔴', 'critical', '버그', 'bug', '수정 필요', 'must fix', '필수', 'required'];

/**
 * Bare substring matching on 'bug'/'critical'/'required' also fires inside
 * "debug", "bugfix", "prerequisite" — words with no bearing on whether a
 * comment is actionable review feedback. Word-boundary matching for the
 * single-token ASCII keywords fixes that without touching the multi-word
 * phrase or the Korean/emoji tokens, where `\b` isn't meaningful.
 */
function matchesCriticalKeyword(bodyLower: string): boolean {
  return CRITICAL_COMMENT_KEYWORDS.some((keyword) => {
    const kw = keyword.toLowerCase();
    return /^[a-z]+$/.test(kw) ? new RegExp(`\\b${kw}\\b`).test(bodyLower) : bodyLower.includes(kw);
  });
}
const FEEDBACK_ADDRESSED_MARKERS = [
  'Review feedback addressed',
  'Auto-fix completed - CI passing',
];

function parseStashList(output: string): Array<{ hash: string; ref: string; subject: string }> {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash = '', ref = '', subject = ''] = line.split('\x00');
      return { hash, ref, subject };
    })
    .filter((stash) => stash.hash && stash.ref);
}

async function stashLocalChanges(cwd: string, message: string): Promise<AutoStash | null> {
  try {
    const before = new Set(
      parseStashList(await gitExec(cwd, 'stash', 'list', '--format=%H%x00%gd%x00%s'))
        .map((stash) => stash.hash)
    );
    await gitExec(cwd, 'stash', 'push', '-u', '-m', message);
    const created = parseStashList(await gitExec(cwd, 'stash', 'list', '--format=%H%x00%gd%x00%s'))
      .find((stash) => !before.has(stash.hash) && stash.subject.includes(message));
    return created ? { hash: created.hash } : null;
  } catch {
    return null;
  }
}

async function restoreAutoStash(cwd: string, stash: AutoStash | null): Promise<void> {
  if (!stash) return;
  try {
    const stashRef = parseStashList(await gitExec(cwd, 'stash', 'list', '--format=%H%x00%gd%x00%s'))
      .find((entry) => entry.hash === stash.hash)?.ref;
    if (!stashRef) return;
    await gitExec(cwd, 'stash', 'apply', stashRef);
    await gitExec(cwd, 'stash', 'drop', stashRef);
  } catch (err) {
    console.error(`[PRProcessor] Failed to restore auto-stash ${stash.hash}:`, err);
  }
}

/** Known AI review-bot author name fragments. Codex comments were previously
 * invisible to critical-comment detection because this check only matched
 * "claude" — the `claude-review` action was the only bot in mind when it was
 * written, so a repo also running a Codex-based review action never had its
 * feedback picked up here at all. */
const REVIEW_BOT_AUTHOR_FRAGMENTS = ['claude', 'codex'];

export function isReviewBotComment(comment: PRIssueComment): boolean {
  const author = comment.author.toLowerCase();
  // Exact bare name (e.g. a PAT-based integration posting as "codex"), or a
  // GitHub App/bot account (GitHub always suffixes those "[bot]") whose name
  // contains the fragment. Plain substring matching without the [bot] anchor
  // would also treat a human account that merely contains "claude"/"codex" in
  // its username as an automated reviewer.
  return REVIEW_BOT_AUTHOR_FRAGMENTS.some((fragment) =>
    author === fragment || (author.endsWith('[bot]') && author.includes(fragment)));
}

export function getActiveCriticalComments(comments: PRIssueComment[]): PRIssueComment[] {
  const lastAddressedAt = comments.reduce<number | null>((latest, comment) => {
    if (!FEEDBACK_ADDRESSED_MARKERS.some((marker) => comment.body.includes(marker))) {
      return latest;
    }
    const createdAt = new Date(comment.createdAt).getTime();
    if (Number.isNaN(createdAt)) return latest;
    return latest === null || createdAt > latest ? createdAt : latest;
  }, null);

  return comments.filter((comment) => {
    const createdAt = new Date(comment.createdAt).getTime();
    if (lastAddressedAt !== null && (!Number.isNaN(createdAt) && createdAt <= lastAddressedAt)) {
      return false;
    }
    return isReviewBotComment(comment) && matchesCriticalKeyword(comment.body.toLowerCase());
  });
}

import {
  getOpenPRs,
  getPRContext,
  commentOnPR,
  commentOnPROrThrow,
  checkPRConflicts,
  waitForCICompletion,
  getPRBaseBranchOrThrow,
  getMergedPRsOrThrow,
  type PRInfo,
} from '../github/index.js';
import { runReviewCommand, formatReviewOutput } from '../cli/reviewCommand.js';
import {
  captureReviewFileHashes,
  loadReviewHistory,
  renderReviewHistoryContext,
  saveReviewHistory,
} from '../cli/reviewHistory.js';
import {
  createPipelineFromConfig,
} from '../agents/pairPipeline.js';
import { getScheduler } from '../orchestration/taskScheduler.js';
import { reportEvent } from '../discord/index.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DefaultRolesConfig, ConflictResolverConfig, SecurityAuditConfig } from '../core/types.js';
import { ConflictResolver } from './conflictResolver.js';
import { DEFAULT_SECURITY_AUDIT_CONFIG } from '../verify/securityAudit.js';
import {
  IntegrationCoordinator,
  type IntegrationCoordinatorConfig,
  type IntegrationSiblingResult,
} from './integrationCoordinator.js';
import { getOwnedPRsForRepo } from './prOwnership.js';

// Types

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
}

type PRStateEntry = {
  repo: string;
  prNumber: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  iterations: number;
  lastProcessed?: string;
  lastReviewFeedbackProcessed?: string;
  lastError?: string;
};

type PRState = {
  prs: Record<string, PRStateEntry>;
  integrations: Record<string, {
    repo: string;
    mergedPRNumber: number;
    mergedBranch: string;
    baseBranch: string;
    mergeCommitOid: string;
    status: 'baseline' | 'pending' | 'completed';
    attempts: number;
    updatedAt: string;
    results?: IntegrationSiblingResult[];
    lastError?: string;
  }>;
  integrationBaselines: Record<string, string>;
  updatedAt: string;
};

const PRStateEntrySchema = z.object({
  repo: z.string().min(1), prNumber: z.number().int().positive(),
  status: z.enum(['pending', 'processing', 'completed', 'failed']),
  iterations: z.number().int().nonnegative(),
  lastProcessed: z.string().optional(), lastReviewFeedbackProcessed: z.string().optional(), lastError: z.string().optional(),
});
const IntegrationStateEntrySchema = z.object({
  repo: z.string().min(1), mergedPRNumber: z.number().int().positive(),
  mergedBranch: z.string().min(1), baseBranch: z.string().min(1), mergeCommitOid: z.string().min(1),
  status: z.enum(['baseline', 'pending', 'completed']), attempts: z.number().int().nonnegative(),
  updatedAt: z.string(), results: z.array(z.unknown()).optional(), lastError: z.string().optional(),
});
const PRStateSchema = z.object({
  prs: z.record(z.string(), PRStateEntrySchema),
  integrations: z.record(z.string(), IntegrationStateEntrySchema).default({}),
  integrationBaselines: z.record(z.string(), z.string()).default({}),
  updatedAt: z.string(),
}) as z.ZodType<PRState>;

// Constants

const PR_STATE_PATH = resolve(homedir(), '.openswarm', 'pr-state.json');

// PR Processor

export class PRProcessor {
  private config: PRProcessorConfig;
  private cronJob: Cron | null = null;
  private initialRunTimer: NodeJS.Timeout | null = null;
  private processing = false;
  private conflictResolver: ConflictResolver | null = null;
  private integrationCoordinator: IntegrationCoordinator | null = null;
  private currentPR: string | null = null;
  private lastRun: number | null = null;
  private nextRun: number | null = null;
  private readonly integrationStartedAt = Date.now();

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
  private createRemediationPipeline() {
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
  ): Promise<{ success: boolean; error?: string; iterations: number; gateRan?: boolean }> {
    const key = `${pr.repo}#${pr.number}`;
    this.currentPR = key;

    // Set the moment a verdict exists, so the catch below can tell "the reviewer
    // produced nothing" from "the reviewer concluded and a later step failed".
    // (INT-3914)
    let verdictProduced = false;
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
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PRProcessor] ${key} fresh review error:`, errorMsg);
      return { success: false, error: errorMsg, iterations: 0, gateRan: verdictProduced };
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

  /**
   * Process open PRs across all repos
   */
  async processPRs(): Promise<void> {
    if (this.processing) {
      console.log('[PRProcessor] Already processing, skipping');
      return;
    }

    this.processing = true;
    this.lastRun = Date.now();
    this.currentPR = null;
    console.log('[PRProcessor] Checking PRs...');

    // Broadcast start event
    const { broadcastEvent } = await import('../core/eventHub.js');
    broadcastEvent({ type: 'pr_processor_start', data: { repos: this.config.repos } });

    try {
      const state = await this.loadState();

      for (const repo of this.config.repos) {
        const prs = await getOpenPRs(repo);
        if (prs.length === 0) {
          await this.processMergedIntegrations(repo, state);
          continue;
        }

        console.log(`[PRProcessor] ${repo}: ${prs.length} open PRs`);

        for (const pr of prs) {
          const key = `${repo}#${pr.number}`;

          // Check for merge conflicts first (always handle conflicts)
          const hasConflicts = await checkPRConflicts(repo, pr.number);

          // Check for review feedback (formal reviews with CHANGES_REQUESTED)
          const { getPRReviews, getPRComments } = await import('../github/github.js');
          const reviews = await getPRReviews(repo, pr.number);
          const latestReviews = new Map<string, typeof reviews[0]>();
          for (const review of reviews) {
            const existing = latestReviews.get(review.author);
            if (!existing || new Date(review.createdAt) > new Date(existing.createdAt)) {
              latestReviews.set(review.author, review);
            }
          }
          const hasFormalReviewFeedback = Array.from(latestReviews.values()).some(
            r => r.state === 'CHANGES_REQUESTED'
          );

          // Also check PR comments for review feedback (from claude-review action)
          const comments = await getPRComments(repo, pr.number);
          const existingState = state.prs[key];
          const hasCommentFeedback = getActiveCriticalComments(comments).some((comment) => {
            if (!existingState?.lastReviewFeedbackProcessed) return true;
            const createdAt = new Date(comment.createdAt).getTime();
            const lastProcessed = new Date(existingState.lastReviewFeedbackProcessed).getTime();
            return Number.isNaN(createdAt) || Number.isNaN(lastProcessed) || createdAt > lastProcessed;
          });

          const hasReviewFeedback = hasFormalReviewFeedback || hasCommentFeedback;

          // If no conflicts and no review feedback, check CI status — only process PRs with failures
          if (!hasConflicts && !hasReviewFeedback) {
            const { getPRChecks } = await import('../github/index.js');
            const checks = await getPRChecks(repo, pr.number);
            const hasFailure = checks.some(
              (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
            );
            if (!hasFailure && checks.length > 0) {
              console.log(`[PRProcessor] ${key}: no conflicts, no review feedback, and CI passing, skipping`);
              continue;
            }
          } else if (hasConflicts) {
            console.log(`[PRProcessor] ${key}: merge conflicts detected, will attempt resolution`);
          } else if (hasReviewFeedback) {
            console.log(`[PRProcessor] ${key}: review feedback detected, will address feedback`);
          }

          // Map repo to local project path
          const projectPath = this.mapRepoToProject(repo);
          if (!projectPath) {
            console.log(`[PRProcessor] ${key}: no local project found, skipping`);
            continue;
          }

          // TaskScheduler concurrency check
          try {
            const scheduler = getScheduler();
            if (scheduler.isProjectBusy(projectPath)) {
              console.log(`[PRProcessor] ${key}: project busy (Linear task running)`);
              continue;
            }
            if (!scheduler.hasAvailableSlot()) {
              console.log(`[PRProcessor] ${key}: no available slots`);
              break; // No available slots, stop entirely
            }
          } catch {
            // Ignore if scheduler not initialized
          }

          // Process PR
          state.prs[key] = {
            repo,
            prNumber: pr.number,
            status: 'processing',
            iterations: 0,
            lastProcessed: new Date().toISOString(),
          };
          await this.saveState(state);

          // If only review feedback (no conflicts, CI passing), handle review feedback directly
          if (hasReviewFeedback && !hasConflicts) {
            const { getPRChecks } = await import('../github/index.js');
            const checks = await getPRChecks(repo, pr.number);
            const hasFailure = checks.some(
              (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
            );
            if (!hasFailure && checks.length > 0) {
              // CI is passing, only need to handle review feedback
              console.log(`[PRProcessor] ${key}: Handling review feedback only (CI passing)`);
              await this.processReviewFeedback(pr, projectPath, state, key, 0);
              continue;
            }
          }

          // Otherwise, run full PR processing (handles conflicts, CI failures, then review feedback)
          await this.processPR(pr, projectPath, state, key);
        }
        // Run reactive integration after this repo's ordinary PR work. A merge
        // observed during the scan is therefore queued only after any sibling
        // remediation already in this cycle has durably finished.
        await this.processMergedIntegrations(repo, state);
      }

      // Cascade: check other owned PRs for conflicts after resolution
      if (this.conflictResolver?.cascadeEnabled()) {
        for (const repo of this.config.repos) {
          await this.conflictResolver.checkCascade(repo);
        }
      }

      await this.saveState(state);
    } catch (err) {
      console.error('[PRProcessor] Error:', err);
    } finally {
      this.processing = false;
      this.currentPR = null;

      // Calculate next run time
      if (this.cronJob) {
        const next = this.cronJob.nextRun();
        this.nextRun = next ? next.getTime() : null;
      }

      // Broadcast end event
      const { broadcastEvent } = await import('../core/eventHub.js');
      broadcastEvent({ type: 'pr_processor_end', data: { lastRun: this.lastRun, nextRun: this.nextRun } });
    }
  }

  /**
   * Process a single PR with auto-retry loop
   */
  private async processPR(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string
  ): Promise<void> {
    this.currentPR = key;
    console.log(`[PRProcessor] Processing ${key}: "${pr.title}"`);

    // Broadcast PR processing event
    const { broadcastEvent } = await import('../core/eventHub.js');
    broadcastEvent({ type: 'pr_processor_pr', data: { pr: key, title: pr.title } });

    // Save current branch (for restoration)
    let originalBranch = 'main';
    try {
      originalBranch = (await gitExec(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    } catch {
      // Fall back to main on failure
    }

    const maxRetries = this.config.maxRetries ?? 3;
    const ciTimeoutMs = this.config.ciTimeoutMs ?? 600_000; // 10 minutes
    const ciPollIntervalMs = this.config.ciPollIntervalMs ?? 30_000; // 30 seconds

    let totalIterations = 0;
    let lastError: string | undefined;
    let retryCount = 0;
    let autoStash: AutoStash | null = null;

    try {
      // 1. Fetch detailed PR context
      const details = await getPRContext(pr.repo, pr.number);
      if (!details) {
        state.prs[key].status = 'failed';
        state.prs[key].lastError = 'Failed to get PR context';
        return;
      }

      // 2. Check for merge conflicts
      const hasConflicts = await checkPRConflicts(pr.repo, pr.number);
      if (hasConflicts) {
        // Try auto-resolution if ConflictResolver is enabled
        if (this.conflictResolver?.isEnabled()) {
          const canResolve = await this.conflictResolver.canResolve(pr);
          if (canResolve) {
            console.log(`[PRProcessor] ${key}: conflicts detected, attempting auto-resolution...`);
            const resolved = await this.conflictResolver.resolve(pr, projectPath);
            if (resolved) {
              console.log(`[PRProcessor] ${key}: conflicts resolved, continuing to CI check...`);
              // Fall through to CI check flow below
            } else {
              // Resolution failed — escalation already handled by resolver
              state.prs[key].status = 'failed';
              state.prs[key].lastError = 'Conflict resolution failed';
              return;
            }
          } else {
            // Cannot resolve (not owned or max attempts)
            const conflictMsg = 'PR has merge conflicts - cannot auto-resolve (not owned or max attempts reached)';
            console.log(`[PRProcessor] ${key}: ${conflictMsg}`);
            await commentOnPR(pr.repo, pr.number, `## ⚠️ ${conflictMsg}\n\nPlease resolve conflicts manually.`);
            state.prs[key].status = 'failed';
            state.prs[key].lastError = conflictMsg;
            return;
          }
        } else {
          // No resolver available
          const conflictMsg = 'PR has merge conflicts - cannot auto-fix';
          console.log(`[PRProcessor] ${key}: ${conflictMsg}`);
          await commentOnPR(pr.repo, pr.number, `## ⚠️ ${conflictMsg}\n\nPlease resolve conflicts manually.`);
          state.prs[key].status = 'failed';
          state.prs[key].lastError = conflictMsg;
          return;
        }
      }

      // 3. git fetch + checkout PR branch
      await gitExec(projectPath, 'fetch', 'origin', pr.branch);

      // Stash local changes before checkout
      autoStash = await stashLocalChanges(
        projectPath,
        `PRProcessor auto-stash for ${key} at ${new Date().toISOString()}`
      );

      await gitExec(projectPath, 'checkout', pr.branch);

      // 4. Auto-retry loop
      while (retryCount < maxRetries) {
        retryCount++;
        console.log(`[PRProcessor] ${key}: Attempt ${retryCount}/${maxRetries}`);

        // 4a. Build TaskItem with current PR context
        const currentDetails = retryCount > 1 ? (await getPRContext(pr.repo, pr.number) || details) : details;
        const diffSnippet = currentDetails.diff.slice(0, 5000);
        const failedChecksList = currentDetails.failedChecks
          ?.map((c) => `- ${c.name}: ${c.conclusion}`)
          .join('\n') || 'N/A';
        const failedLogsSnippet = currentDetails.failedLogs?.slice(0, 3000) || '';

        const task: TaskItem = {
          id: `pr-${pr.repo}-${pr.number}-${retryCount}`,
          source: 'github_pr',
          title: `Fix PR #${pr.number}: ${pr.title}`,
          description: [
            `## PR Context (Attempt ${retryCount}/${maxRetries})`,
            `**Title:** ${pr.title}`,
            `**Branch:** ${pr.branch}`,
            `**Author:** ${currentDetails.author}`,
            '',
            currentDetails.body ? `**Description:**\n${currentDetails.body}\n` : '',
            `## Failed CI Checks`,
            failedChecksList,
            '',
            failedLogsSnippet ? `## Failed Logs (last 3000 chars)\n\`\`\`\n${failedLogsSnippet}\n\`\`\`\n` : '',
            `## Diff (first 5000 chars)`,
            '```diff',
            diffSnippet,
            '```',
            '',
            '## Instructions',
            'Fix CI failures. Do NOT change the overall approach or architecture.',
            'Focus on: type errors, lint errors, test failures, build errors.',
            'Make minimal changes to get CI passing.',
            retryCount > 1 ? `\n**Previous attempt failed - review the error logs above carefully.**` : '',
          ].join('\n'),
          priority: 2,
          projectPath,
          issueId: `pr-${pr.number}`,
          workflowId: undefined,
          createdAt: Date.now(),
        };

        // 4b. Run pipeline
        const pipeline = this.createRemediationPipeline();
        const result = await pipeline.run(task, projectPath);
        totalIterations += result.iterations;

        if (!result.success) {
          // Pipeline failed
          lastError = result.reviewResult?.feedback
            || result.workerResult?.error
            || 'Pipeline failed after max iterations';
          console.log(`[PRProcessor] ${key}: Pipeline failed - ${lastError}`);

          if (retryCount >= maxRetries) {
            break; // Max retries reached
          }

          // Retry
          console.log(`[PRProcessor] ${key}: Retrying...`);
          continue;
        }

        // 4c. Pipeline succeeded - push changes
        console.log(`[PRProcessor] ${key}: Pipeline succeeded, pushing changes...`);
        await gitExec(projectPath, 'push', 'origin', pr.branch);

        // 4d. Wait for CI completion
        console.log(`[PRProcessor] ${key}: Waiting for CI checks...`);
        const ciStatus = await waitForCICompletion(pr.repo, pr.number, {
          timeoutMs: ciTimeoutMs,
          pollIntervalMs: ciPollIntervalMs,
          onProgress: (status, elapsed) => {
            if (status.status === 'pending') {
              console.log(`[PRProcessor] ${key}: CI pending (${Math.floor(elapsed / 1000)}s elapsed)...`);
            }
          }
        });

        // 4e. Check CI result
        if (ciStatus.status === 'success') {
          // SUCCESS - all CI passed
          const summary = result.workerResult?.summary || 'CI issues fixed';
          const filesChanged = result.workerResult?.filesChanged?.join(', ') || 'N/A';

          await commentOnPR(
            pr.repo,
            pr.number,
            [
              `## ✅ Auto-fix completed - CI passing`,
              '',
              `**Summary:** ${summary}`,
              `**Files changed:** ${filesChanged}`,
              `**Total attempts:** ${retryCount}`,
              `**Total iterations:** ${totalIterations}`,
            ].join('\n')
          );

          await reportEvent({
            type: 'pr_improved',
            session: 'pr-processor',
            message: `**${pr.repo}#${pr.number}** "${pr.title}" CI fix completed (${retryCount} attempts)\n${summary}`,
            timestamp: Date.now(),
            url: pr.url,
          });

          // Process review feedback after CI success
          await this.processReviewFeedback(pr, projectPath, state, key, totalIterations);
          if (state.prs[key].status === 'failed') {
            console.log(`[PRProcessor] ${key}: Review feedback processing failed`);
            return;
          }

          state.prs[key].status = 'completed';
          state.prs[key].iterations = totalIterations;
          console.log(`[PRProcessor] ${key}: SUCCESS after ${retryCount} attempt(s)`);
          return;

        } else if (ciStatus.status === 'failure') {
          // CI failed - prepare for retry
          lastError = `CI checks failed: ${ciStatus.failedChecks.map(c => c.name).join(', ')}`;
          console.log(`[PRProcessor] ${key}: ${lastError}`);

          if (retryCount >= maxRetries) {
            break; // Max retries reached
          }

          // Fetch latest PR state before retry
          console.log(`[PRProcessor] ${key}: Retrying due to CI failure...`);
          await gitExec(projectPath, 'pull', 'origin', pr.branch);
          continue;

        } else {
          // CI timeout
          lastError = 'CI timeout - checks did not complete in time';
          console.log(`[PRProcessor] ${key}: ${lastError}`);
          break;
        }
      }

      // Max retries reached or CI timeout
      await commentOnPR(
        pr.repo,
        pr.number,
        [
          `## ❌ Auto-fix failed after ${retryCount} attempt(s)`,
          '',
          `**Total iterations:** ${totalIterations}`,
          `**Last error:** ${lastError || 'Unknown error'}`,
          '',
          'Manual intervention required.',
        ].join('\n')
      );

      await reportEvent({
        type: 'pr_failed',
        session: 'pr-processor',
        message: `**${pr.repo}#${pr.number}** "${pr.title}" auto-fix failed after ${retryCount} attempts\n${lastError || 'Unknown'}`,
        timestamp: Date.now(),
        url: pr.url,
      });

      state.prs[key].status = 'failed';
      state.prs[key].lastError = lastError;
      state.prs[key].iterations = totalIterations;
      console.log(`[PRProcessor] ${key}: FAILED after ${retryCount} attempt(s) - ${lastError}`);

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PRProcessor] ${key} error:`, errorMsg);
      state.prs[key].status = 'failed';
      state.prs[key].lastError = errorMsg;

    } finally {
      // Restore branch
      let restoredBranch = false;
      try {
        await gitExec(projectPath, 'checkout', originalBranch);
        restoredBranch = true;
      } catch (restoreErr) {
        console.error(`[PRProcessor] Failed to restore branch ${originalBranch}:`, restoreErr);
      }
      if (restoredBranch) {
        await restoreAutoStash(projectPath, autoStash);
      }
    }
  }

  /**
   * Process review feedback and iterate until all reviews are approved
   */
  private async processReviewFeedback(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string,
    totalIterations: number
  ): Promise<void> {
    const MAX_REVIEW_ITERATIONS = 5;
    let reviewIteration = 0;
    let autoStash: AutoStash | null = null;

    // Save current branch for restoration
    let originalBranch = 'main';
    try {
      originalBranch = (await gitExec(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    } catch {
      // Fall back to main on failure
    }

    try {
      // git fetch + checkout PR branch
      await gitExec(projectPath, 'fetch', 'origin', pr.branch);

      // Stash local changes before checkout
      autoStash = await stashLocalChanges(
        projectPath,
        `PRProcessor review feedback for ${key} at ${new Date().toISOString()}`
      );

      await gitExec(projectPath, 'checkout', pr.branch);

    while (reviewIteration < MAX_REVIEW_ITERATIONS) {
      reviewIteration++;
      console.log(`[PRProcessor] ${key}: Checking review feedback (iteration ${reviewIteration}/${MAX_REVIEW_ITERATIONS})...`);

      // Captured before the fetch below, not after the pipeline run finishes.
      // The pipeline can take minutes; feedback submitted while it is running
      // is invisible to THIS iteration (it was not fetched yet) but must not
      // be stamped "processed" once we mark this round done, or it silently
      // never gets picked up on the next iteration either.
      const fetchStartedAt = new Date().toISOString();

      // Get PR reviews and comments
      const { getPRReviews, getPRReviewComments, getPRComments } = await import('../github/github.js');
      const reviews = await getPRReviews(pr.repo, pr.number);
      const prComments = await getPRComments(pr.repo, pr.number);

      // Find latest reviews per user (only consider latest review from each reviewer)
      const latestReviews = new Map<string, typeof reviews[0]>();
      for (const review of reviews) {
        const existing = latestReviews.get(review.author);
        if (!existing || new Date(review.createdAt) > new Date(existing.createdAt)) {
          latestReviews.set(review.author, review);
        }
      }

      // Check for active critical feedback in PR comments (from claude-review action)
      const lastReviewFeedbackProcessed = state.prs[key]?.lastReviewFeedbackProcessed;
      const stillFresh = (createdAtIso: string): boolean => {
        if (!lastReviewFeedbackProcessed) return true;
        const createdAt = new Date(createdAtIso).getTime();
        const lastProcessed = new Date(lastReviewFeedbackProcessed).getTime();
        return Number.isNaN(createdAt) || Number.isNaN(lastProcessed) || createdAt > lastProcessed;
      };

      // Check if any reviews request changes. A CHANGES_REQUESTED review stays
      // in that state until the reviewer re-reviews — pushing a fix does not
      // clear it — so without this freshness gate a formal review keeps
      // "requesting changes" on every iteration even after it was already
      // addressed, and the loop can never report success: it just re-fixes the
      // same feedback until MAX_REVIEW_ITERATIONS gives up.
      const changesRequested = Array.from(latestReviews.values())
        .filter(r => r.state === 'CHANGES_REQUESTED')
        .filter(r => stillFresh(r.createdAt));

      const criticalComments = getActiveCriticalComments(prComments).filter((comment) => stillFresh(comment.createdAt));

      if (changesRequested.length === 0 && criticalComments.length === 0) {
        console.log(`[PRProcessor] ${key}: No changes requested - all reviews approved or no critical feedback`);
        state.prs[key].status = 'completed';
        state.prs[key].iterations = totalIterations;
        return;
      }

      console.log(`[PRProcessor] ${key}: Found ${changesRequested.length} review(s) requesting changes, ${criticalComments.length} critical comment(s)`);

      // Get review comments for detailed feedback
      const comments = await getPRReviewComments(pr.repo, pr.number);

      // Build feedback summary
      const feedbackLines: string[] = [];

      // Add formal review feedback
      for (const review of changesRequested) {
        feedbackLines.push(`### Review by ${review.author}`);
        if (review.body) {
          feedbackLines.push(review.body);
        }

        // Add specific line comments from this reviewer
        const reviewerComments = comments.filter(c => c.author === review.author);
        if (reviewerComments.length > 0) {
          feedbackLines.push('\n**Specific comments:**');
          for (const comment of reviewerComments) {
            if (comment.path && comment.line) {
              feedbackLines.push(`- \`${comment.path}:${comment.line}\`: ${comment.body}`);
            } else {
              feedbackLines.push(`- ${comment.body}`);
            }
          }
        }
        feedbackLines.push('');
      }

      // Add critical PR comments feedback
      if (criticalComments.length > 0) {
        feedbackLines.push(`### Critical Feedback from PR Comments`);
        for (const comment of criticalComments) {
          feedbackLines.push(`**Comment by ${comment.author}:**`);
          feedbackLines.push(comment.body);
          feedbackLines.push('');
        }
      }

      const feedbackSummary = feedbackLines.join('\n');

      // Get current PR context
      const { getPRContext } = await import('../github/github.js');
      const details = await getPRContext(pr.repo, pr.number);
      if (!details) {
        console.log(`[PRProcessor] ${key}: Failed to get PR context for review iteration`);
        state.prs[key].status = 'failed';
        state.prs[key].iterations = totalIterations;
        state.prs[key].lastError = `Failed to fetch PR context for ${key} (iteration ${reviewIteration})`;
        return;
      }

      const diffSnippet = details.diff.slice(0, 5000);

      // Build TaskItem with review feedback
      const task: TaskItem = {
        id: `pr-review-${pr.repo}-${pr.number}-${reviewIteration}`,
        source: 'github_pr_review',
        title: `Address review feedback for PR #${pr.number}: ${pr.title}`,
        description: [
          `## Review Feedback (Iteration ${reviewIteration}/${MAX_REVIEW_ITERATIONS})`,
          `**PR:** ${pr.repo}#${pr.number} - ${pr.title}`,
          `**Branch:** ${pr.branch}`,
          '',
          `## Requested Changes`,
          feedbackSummary,
          '',
          `## Current Diff (first 5000 chars)`,
          '```diff',
          diffSnippet,
          '```',
          '',
          '## Instructions',
          'Address all review feedback points above.',
          'Make the requested changes while maintaining code quality.',
          'DO NOT change unrelated code or architecture.',
          'Focus on addressing the specific points raised by reviewers.',
        ].join('\n'),
        priority: 2,
        projectPath,
        issueId: `pr-${pr.number}`,
        workflowId: undefined,
        createdAt: Date.now(),
      };

      // Run pipeline to address feedback
      console.log(`[PRProcessor] ${key}: Running pipeline to address review feedback...`);
      const pipeline = this.createRemediationPipeline();
      const result = await pipeline.run(task, projectPath);
      totalIterations += result.iterations;

      if (!result.success) {
        const error = result.reviewResult?.feedback || result.workerResult?.error || 'Pipeline failed';
        console.log(`[PRProcessor] ${key}: Failed to address review feedback - ${error}`);

        await commentOnPR(
          pr.repo,
          pr.number,
          [
            `## ⚠️ Failed to address review feedback (iteration ${reviewIteration})`,
            '',
            `**Error:** ${error}`,
            '',
            'Manual intervention required.',
          ].join('\n')
        );
        state.prs[key].status = 'failed';
        state.prs[key].iterations = totalIterations;
        state.prs[key].lastError = error;
        return;
      }

      // Push changes
      console.log(`[PRProcessor] ${key}: Pushing review feedback changes...`);
      await gitExec(projectPath, 'push', 'origin', pr.branch);

      // Comment on PR
      const summary = result.workerResult?.summary || 'Review feedback addressed';
      const filesChanged = result.workerResult?.filesChanged?.join(', ') || 'N/A';

      await commentOnPR(
        pr.repo,
        pr.number,
        [
          `## 🔄 Review feedback addressed (iteration ${reviewIteration})`,
          '',
          `**Summary:** ${summary}`,
          `**Files changed:** ${filesChanged}`,
          '',
          'Please re-review.',
        ].join('\n')
      );

      console.log(`[PRProcessor] ${key}: Review feedback iteration ${reviewIteration} complete`);
      // fetchStartedAt, not now() — see its declaration above.
      state.prs[key].lastReviewFeedbackProcessed = fetchStartedAt;

      // Small delay before checking reviews again
      await new Promise(resolve => setTimeout(resolve, 5000));
    }

      // Max iterations reached
      console.log(`[PRProcessor] ${key}: Max review iterations (${MAX_REVIEW_ITERATIONS}) reached`);
      await commentOnPR(
        pr.repo,
        pr.number,
        [
          `## ⚠️ Max review feedback iterations reached`,
          '',
          `Attempted to address review feedback ${MAX_REVIEW_ITERATIONS} times.`,
          'Please review manually and provide additional guidance if needed.',
        ].join('\n')
      );

      // Update state
      state.prs[key].status = 'failed';
      state.prs[key].iterations = totalIterations;
      state.prs[key].lastError = `Max review feedback iterations (${MAX_REVIEW_ITERATIONS}) reached`;

    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PRProcessor] ${key} review feedback error:`, errorMsg);
      state.prs[key].status = 'failed';
      state.prs[key].lastError = errorMsg;

    } finally {
      // Restore branch
      let restoredBranch = false;
      try {
        await gitExec(projectPath, 'checkout', originalBranch);
        restoredBranch = true;
      } catch (restoreErr) {
        console.error(`[PRProcessor] Failed to restore branch ${originalBranch}:`, restoreErr);
      }
      if (restoredBranch) {
        await restoreAutoStash(projectPath, autoStash);
      }
    }
  }

  /**
   * Map repo to local project path
   */
  private mapRepoToProject(repo: string): string | null {
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
  private async processMergedIntegrations(repo: string, state: PRState): Promise<void> {
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

  private async loadState(): Promise<PRState> {
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

  private async saveState(state: PRState): Promise<void> {
    state.updatedAt = new Date().toISOString();
    atomicWriteFileSync(PR_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  }
}

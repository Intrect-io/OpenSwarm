// ============================================
// OpenSwarm - PR Processor
// Created: 2026-04-03
// Purpose: PR conflict resolution, review feedback processing, CI monitoring
// Dependencies: git, gh CLI, @linear/sdk
// ============================================

import { execSync, spawn } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname, basename, resolve } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { withStoreLock } from '../taskState/store.js';

// ============================================
// Types & Interfaces
// ============================================

interface PRInfo {
  repo: string;
  number: number;
  title: string;
  branch: string;
  base: string;
  author: string;
  body: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
}

interface AutoStash {
  index: string;
  message: string;
}

interface PRIssueComment {
  id: string;
  body: string;
  author: string;
  createdAt: string;
  updatedAt: string;
}

interface IntegrationSiblingResult {
  prNumber: number;
  repo: string;
  status: string;
  error?: string;
}

interface PRState {
  prs: Record<string, {
    repo: string;
    prNumber: number;
    status: 'pending' | 'processing' | 'completed' | 'failed';
    iterations: number;
    lastProcessed?: string;
    lastReviewFeedbackProcessed?: string;
    lastError?: string;
  }>;
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
}

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
const STATE_FILE = '.openswarm/pr-state.json';
const CI_POLL_INTERVAL = 30_000;
const CI_TIMEOUT = 600_000;
const MAX_RETRIES = 3;
const FEEDBACK_ADDRESSED_MARKERS = [
  '<!-- openswarm:feedback-addressed -->',
  '<!-- openswarm:addressed -->',
];

// ============================================
// Utility Functions
// ============================================

function gitExec(cwd: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr.trim()}`));
    });
    child.on('error', reject);
  });
}

function ghRepoView(cwd: string, remoteUrl: string): Promise<string> {
  return gitExec(cwd, 'remote', 'get-url', 'origin');
}

function matchesCriticalKeyword(bodyLower: string): boolean {
  return /critical|urgent|security|vulnerability|p0|blocker/i.test(bodyLower);
}

function parseStashList(output: string): Array<{ index: string; message: string }> {
  return output.split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^stash@\{(\d+)\}: (.+)$/);
    return match ? { index: match[1], message: match[2] } : { index: '', message: line };
  });
}

async function stashLocalChanges(cwd: string, message: string): Promise<AutoStash | null> {
  const status = await gitExec(cwd, 'status', '--porcelain');
  if (!status.trim()) return null;
  await gitExec(cwd, 'stash', 'push', '-u', '-m', message);
  const list = await gitExec(cwd, 'stash', 'list');
  const stashes = parseStashList(list);
  const created = stashes.find((s) => s.message === message);
  return created ? { index: created.index, message } : null;
}

async function restoreAutoStash(cwd: string, stash: AutoStash | null): Promise<void> {
  if (!stash) return;
  try {
    await gitExec(cwd, 'stash', 'pop', `stash@{${stash.index}}`);
  } catch {
    // Stash may have been dropped already
  }
}

function isReviewBotComment(comment: PRIssueComment): boolean {
  return comment.author === 'openswarm[bot]' || comment.author === 'openswarm';
}

function getActiveCriticalComments(comments: PRIssueComment[]): PRIssueComment[] {
  return comments.filter((c) => {
    if (!isReviewBotComment(c)) return false;
    const body = c.body.toLowerCase();
    return matchesCriticalKeyword(body);
  });
}

interface PRProcessorConfig {
  maxRetries?: number;
  ciTimeoutMs?: number;
  ciPollIntervalMs?: number;
  enabledProjects?: string[];
}

// ============================================
// PRProcessor Class
// ============================================

export class PRProcessor {
  private config: PRProcessorConfig;
  private currentPR: string | null = null;

  constructor(config: PRProcessorConfig = {}) {
    this.config = {
      maxRetries: config.maxRetries ?? MAX_RETRIES,
      ciTimeoutMs: config.ciTimeoutMs ?? CI_TIMEOUT,
      ciPollIntervalMs: config.ciPollIntervalMs ?? CI_POLL_INTERVAL,
      enabledProjects: config.enabledProjects,
    };
  }

  /**
   * One-shot fix for a single PR (CLI `openswarm pr fix`).
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
    // Acquire cross-process lease before any state mutation (one-shot fix path)
    await withStoreLock('prProcessor-fixOne', async () => {
      await this.processPR(pr, projectPath, state, key);
    });
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
   * Process a single PR: fetch, review, fix, verify CI
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
        // Try to resolve conflicts
        const resolver = await this.getConflictResolver(pr);
        if (resolver) {
          const resolved = await resolver.resolve(pr, projectPath);
          if (!resolved) {
            state.prs[key].status = 'failed';
            state.prs[key].lastError = 'Conflict resolution failed';
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
      autoStash = await stashLocalChanges(projectPath, `PRProcessor: ${key}`);

      // Checkout PR branch
      await gitExec(projectPath, 'checkout', pr.branch);

      // 4. Run review + fix loop
      for (let iteration = 0; iteration < maxRetries; iteration++) {
        totalIterations++;
        console.log(`[PRProcessor] ${key}: Iteration ${iteration + 1}/${maxRetries}`);

        // Run review
        const reviewResult = await this.runReview(pr, projectPath);
        if (!reviewResult.hasIssues) {
          console.log(`[PRProcessor] ${key}: No issues found`);
          break;
        }

        // Apply fixes
        const fixResult = await this.applyFixes(pr, projectPath, reviewResult);
        if (!fixResult.changesMade) {
          console.log(`[PRProcessor] ${key}: No changes made`);
          break;
        }

        // Commit and push
        await this.commitAndPush(pr, projectPath, iteration);

        // Wait for CI
        const ciResult = await this.waitForCI(pr, projectPath, ciTimeoutMs, ciPollIntervalMs);
        if (ciResult.passed) {
          console.log(`[PRProcessor] ${key}: CI passed`);
          break;
        }

        lastError = ciResult.error;
        if (iteration < maxRetries - 1) {
          console.log(`[PRProcessor] ${key}: CI failed, retrying...`);
        }
      }

      // 5. Final status
      state.prs[key].status = lastError ? 'failed' : 'completed';
      state.prs[key].lastError = lastError;
      state.prs[key].iterations = totalIterations;
      state.prs[key].lastProcessed = new Date().toISOString();

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PRProcessor] ${key}: Error:`, message);
      state.prs[key].status = 'failed';
      state.prs[key].lastError = message;
    } finally {
      // Restore original branch
      try {
        await gitExec(projectPath, 'checkout', originalBranch);
      } catch {
        // Ignore checkout errors in cleanup
      }
      await restoreAutoStash(projectPath, autoStash);
      this.currentPR = null;
    }
  }

  /**
   * Process review feedback for a single PR
   */
  private async processReviewFeedback(
    pr: PRInfo,
    projectPath: string,
    state: PRState,
    key: string,
    maxIterations: number
  ): Promise<void> {
    this.currentPR = key;
    console.log(`[PRProcessor] Processing review feedback for ${key}: "${pr.title}"`);

    let originalBranch = 'main';
    try {
      originalBranch = (await gitExec(projectPath, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    } catch {
      // Fall back to main on failure
    }

    let autoStash: AutoStash | null = null;

    try {
      // Fetch PR branch
      await gitExec(projectPath, 'fetch', 'origin', pr.branch);

      // Stash local changes before checkout
      autoStash = await stashLocalChanges(projectPath, `PRProcessor-review: ${key}`);

      // Checkout PR branch
      await gitExec(projectPath, 'checkout', pr.branch);

      // Get review comments
      const comments = await getPRComments(pr.repo, pr.number);
      const reviewComments = comments.filter((c) => !isReviewBotComment(c));

      if (reviewComments.length === 0) {
        console.log(`[PRProcessor] ${key}: No review comments found`);
        state.prs[key].status = 'completed';
        state.prs[key].lastReviewFeedbackProcessed = new Date().toISOString();
        return;
      }

      // Check if feedback was already addressed
      const existingComments = await getPRComments(pr.repo, pr.number);
      const addressed = existingComments.some((c) =>
        FEEDBACK_ADDRESSED_MARKERS.some((m) => c.body.includes(m))
      );
      if (addressed) {
        console.log(`[PRProcessor] ${key}: Feedback already addressed`);
        state.prs[key].status = 'completed';
        state.prs[key].lastReviewFeedbackProcessed = new Date().toISOString();
        return;
      }

      // Apply review feedback
      const fixResult = await this.applyReviewFeedback(pr, projectPath, reviewComments);
      if (fixResult.changesMade) {
        await this.commitAndPush(pr, projectPath, 0);
        // Mark feedback as addressed
        await commentOnPR(pr.repo, pr.number, `<!-- openswarm:feedback-addressed -->\n\n## ✅ Review Feedback Addressed\n\nAll review comments have been addressed.`);
      }

      state.prs[key].status = 'completed';
      state.prs[key].lastReviewFeedbackProcessed = new Date().toISOString();

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[PRProcessor] ${key}: Error processing review feedback:`, message);
      state.prs[key].status = 'failed';
      state.prs[key].lastError = message;
    } finally {
      // Restore original branch
      try {
        await gitExec(projectPath, 'checkout', originalBranch);
      } catch {
        // Ignore checkout errors in cleanup
      }
      await restoreAutoStash(projectPath, autoStash);
      this.currentPR = null;
    }
  }

  /**
   * Run code review on the PR
   */
  private async runReview(
    pr: PRInfo,
    projectPath: string
  ): Promise<{ hasIssues: boolean; issues: string[] }> {
    // Get diff
    const diff = await this.getDiffText(pr, projectPath);

    if (!diff) {
      return { hasIssues: false, issues: [] };
    }

    // Run review using the review system
    const { runReviewer } = await import('../agents/reviewer.js');
    const result = await runReviewer({
      path: projectPath,
      base: pr.base,
      readOnly: true,
    });

    return {
      hasIssues: result.status === 'changes_requested',
      issues: result.feedback ? [result.feedback] : [],
    };
  }

  /**
   * Apply fixes based on review results
   */
  private async applyFixes(
    pr: PRInfo,
    projectPath: string,
    reviewResult: { hasIssues: boolean; issues: string[] }
  ): Promise<{ changesMade: boolean }> {
    if (!reviewResult.hasIssues || reviewResult.issues.length === 0) {
      return { changesMade: false };
    }

    // Apply fixes using the worker system
    const { runWorker } = await import('../agents/worker.js');
    const result = await runWorker({
      path: projectPath,
      task: `Fix the following issues in PR #${pr.number}:\n${reviewResult.issues.join('\n')}`,
    });

    return { changesMade: result.success };
  }

  /**
   * Apply review feedback comments
   */
  private async applyReviewFeedback(
    pr: PRInfo,
    projectPath: string,
    comments: PRIssueComment[]
  ): Promise<{ changesMade: boolean }> {
    if (comments.length === 0) {
      return { changesMade: false };
    }

    const feedbackText = comments.map((c) => `- ${c.body}`).join('\n');

    const { runWorker } = await import('../agents/worker.js');
    const result = await runWorker({
      path: projectPath,
      task: `Address the following review feedback for PR #${pr.number}:\n${feedbackText}`,
    });

    return { changesMade: result.success };
  }

  /**
   * Commit and push changes
   */
  private async commitAndPush(
    pr: PRInfo,
    projectPath: string,
    iteration: number
  ): Promise<void> {
    const message = `fix: auto-fix iteration ${iteration + 1} for PR #${pr.number}`;

    await gitExec(projectPath, 'add', '-A');
    const status = await gitExec(projectPath, 'status', '--porcelain');
    if (!status.trim()) return; // No changes

    await gitExec(projectPath, 'commit', '-m', message);
    await gitExec(projectPath, 'push', 'origin', pr.branch);
  }

  /**
   * Wait for CI to complete
   */
  private async waitForCI(
    pr: PRInfo,
    projectPath: string,
    timeoutMs: number,
    pollIntervalMs: number
  ): Promise<{ passed: boolean; error?: string }> {
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const status = await getPRStatus(pr.repo, pr.number);
      if (status === 'success') {
        return { passed: true };
      }
      if (status === 'failure') {
        return { passed: false, error: 'CI checks failed' };
      }
      if (status === 'pending' || status === 'queued') {
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        continue;
      }
      // Unknown status
      return { passed: false, error: `Unknown CI status: ${status}` };
    }

    return { passed: false, error: 'CI timeout' };
  }

  /**
   * Get diff text for review
   */
  private async getDiffText(
    pr: PRInfo,
    projectPath: string
  ): Promise<string | null> {
    try {
      // Fetch PR refs
      const scratchId = randomUUID();
      const prHeadRef = `refs/openswarm/pr-${pr.number}-review-${scratchId}`;
      const baseRef = `refs/openswarm/pr-${pr.number}-base-${scratchId}`;

      await gitExec(
        projectPath, 'fetch', 'origin',
        `pull/${pr.number}/head:${prHeadRef}`, `refs/heads/${pr.base}:${baseRef}`,
      );

      const mergeBase = (await gitExec(projectPath, 'merge-base', prHeadRef, baseRef)).trim();
      const diff = await gitExec(projectPath, 'diff', mergeBase, prHeadRef);
      return diff || null;
    } catch (error) {
      console.error(`[PRProcessor] Failed to get diff for PR #${pr.number}:`, error);
      return null;
    }
  }

  /**
   * Get conflict resolver for a PR
   */
  private async getConflictResolver(pr: PRInfo): Promise<{ resolve: (pr: PRInfo, projectPath: string) => Promise<boolean> } | null> {
    try {
      const { default: ConflictResolver } = await import('./conflictResolver.js');
      return new ConflictResolver();
    } catch {
      return null;
    }
  }

  /**
   * Load PR state from disk
   */
  private async loadState(): Promise<PRState> {
    const statePath = join(process.cwd(), STATE_FILE);
    try {
      const data = readFileSync(statePath, 'utf-8');
      const parsed = PRStateSchema.parse(JSON.parse(data));
      return parsed;
    } catch {
      return {
        prs: {},
        integrations: {},
        integrationBaselines: {},
        updatedAt: new Date().toISOString(),
      };
    }
  }

  /**
   * Save PR state to disk
   */
  private async saveState(state: PRState): Promise<void> {
    const statePath = join(process.cwd(), STATE_FILE);
    const dir = dirname(statePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    state.updatedAt = new Date().toISOString();
    writeFileSync(statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Get current PR being processed
   */
  getCurrentPR(): string | null {
    return this.currentPR;
  }
}

// ============================================
// GitHub API Functions
// ============================================

async function getPRContext(repo: string, prNumber: number): Promise<PRInfo | null> {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json number,title,headRefName,baseRefName,author,body,labels,createdAt,updatedAt`,
      { encoding: 'utf-8' }
    );
    const data = JSON.parse(output);
    return {
      repo,
      number: data.number,
      title: data.title,
      branch: data.headRefName,
      base: data.baseRefName,
      author: data.author?.login ?? 'unknown',
      body: data.body ?? '',
      labels: data.labels?.map((l: any) => l.name) ?? [],
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    };
  } catch {
    return null;
  }
}

async function checkPRConflicts(repo: string, prNumber: number): Promise<boolean> {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json mergeable`,
      { encoding: 'utf-8' }
    );
    const data = JSON.parse(output);
    return data.mergeable === 'CONFLICTING';
  } catch {
    return false;
  }
}

async function getPRComments(repo: string, prNumber: number): Promise<PRIssueComment[]> {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json comments --jq '.comments[] | {id: .id, body: .body, author: .author.login, createdAt: .createdAt, updatedAt: .updatedAt}'`,
      { encoding: 'utf-8' }
    );
    return output.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function getPRStatus(repo: string, prNumber: number): Promise<string> {
  try {
    const output = execSync(
      `gh pr view ${prNumber} --repo ${repo} --json statusCheckRollup --jq '.statusCheckRollup[] | select(.conclusion != "SKIPPED") | .conclusion'`,
      { encoding: 'utf-8' }
    );
    const conclusions = output.trim().split('\n').filter(Boolean);
    if (conclusions.length === 0) return 'pending';
    if (conclusions.every((c) => c === 'SUCCESS')) return 'success';
    if (conclusions.some((c) => c === 'FAILURE' || c === 'ERROR' || c === 'TIMED_OUT')) return 'failure';
    return 'pending';
  } catch {
    return 'unknown';
  }
}

async function commentOnPR(repo: string, prNumber: number, body: string): Promise<void> {
  try {
    execSync(
      `gh pr comment ${prNumber} --repo ${repo} --body ${JSON.stringify(body)}`,
      { encoding: 'utf-8' }
    );
  } catch (error) {
    console.error(`[PRProcessor] Failed to comment on PR #${prNumber}:`, error);
  }
}

// ============================================
// Exports
// ============================================

export type { PRInfo, PRState, PRProcessorConfig, PRIssueComment };
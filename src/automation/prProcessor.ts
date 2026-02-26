// ============================================
// OpenSwarm - PR Auto-Improvement Processor
// Open PR auto-improvement (Worker-Reviewer iteration loop)
// ============================================

import { Cron } from 'croner';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Safe git command execution (no shell) */
async function gitExec(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

import {
  getOpenPRs,
  getPRContext,
  commentOnPR,
  checkPRConflicts,
  waitForCICompletion,
  type PRInfo,
} from '../github/index.js';
import {
  createPipelineFromConfig,
} from '../agents/pairPipeline.js';
import { getScheduler } from '../orchestration/taskScheduler.js';
import { reportEvent } from '../discord/index.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DefaultRolesConfig, ConflictResolverConfig } from '../core/types.js';
import { ConflictResolver } from './conflictResolver.js';

// ============================================
// Types
// ============================================

export interface PRProcessorConfig {
  repos: string[];
  schedule: string;
  cooldownHours: number;
  maxIterations: number;
  roles?: DefaultRolesConfig;
  maxRetries?: number;          // Max retry attempts per PR (default: 3)
  ciTimeoutMs?: number;         // CI completion timeout (default: 10min)
  ciPollIntervalMs?: number;    // CI polling interval (default: 30s)
  conflictResolver?: ConflictResolverConfig;
}

type PRStateEntry = {
  repo: string;
  prNumber: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  iterations: number;
  lastProcessed?: string;
  lastError?: string;
};

type PRState = {
  prs: Record<string, PRStateEntry>;
  updatedAt: string;
};

// ============================================
// Constants
// ============================================

const PR_STATE_PATH = resolve(homedir(), '.openswarm', 'pr-state.json');

// ============================================
// PR Processor
// ============================================

export class PRProcessor {
  private config: PRProcessorConfig;
  private cronJob: Cron | null = null;
  private processing = false;
  private conflictResolver: ConflictResolver | null = null;
  private currentPR: string | null = null;
  private lastRun: number | null = null;
  private nextRun: number | null = null;

  constructor(config: PRProcessorConfig) {
    this.config = config;
    if (config.conflictResolver?.enabled) {
      this.conflictResolver = new ConflictResolver(config.conflictResolver);
      console.log(`[PRProcessor] ConflictResolver enabled (mode: ${config.conflictResolver.ownershipMode}, maxAttempts: ${config.conflictResolver.maxResolutionAttempts})`);
    }
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
   * Start schedule
   */
  start(): void {
    console.log(`[PRProcessor] Starting (schedule: ${this.config.schedule})`);

    this.cronJob = new Cron(this.config.schedule, async () => {
      await this.processPRs();
    });

    // Initial run after 30 seconds
    setTimeout(() => {
      void this.processPRs().catch((err) => {
        console.error('[PRProcessor] Initial run error:', err);
      });
    }, 30_000);
  }

  /**
   * Stop schedule
   */
  stop(): void {
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
        if (prs.length === 0) continue;

        console.log(`[PRProcessor] ${repo}: ${prs.length} open PRs`);

        for (const pr of prs) {
          const key = `${repo}#${pr.number}`;

          // Cooldown check
          const existing = state.prs[key];
          if (existing?.lastProcessed) {
            const hoursSince =
              (Date.now() - new Date(existing.lastProcessed).getTime()) / (1000 * 60 * 60);
            if (hoursSince < this.config.cooldownHours) {
              console.log(`[PRProcessor] ${key}: cooldown (${hoursSince.toFixed(1)}h < ${this.config.cooldownHours}h)`);
              continue;
            }
          }

          // Check for merge conflicts first (always handle conflicts)
          const hasConflicts = await checkPRConflicts(repo, pr.number);

          // If no conflicts, check CI status — only process PRs with failures
          if (!hasConflicts) {
            const { getPRChecks } = await import('../github/index.js');
            const checks = await getPRChecks(repo, pr.number);
            const hasFailure = checks.some(
              (c) => c.conclusion === 'failure' || c.conclusion === 'timed_out'
            );
            if (!hasFailure && checks.length > 0) {
              console.log(`[PRProcessor] ${key}: no conflicts and CI passing, skipping`);
              continue;
            }
          } else {
            console.log(`[PRProcessor] ${key}: merge conflicts detected, will attempt resolution`);
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

          await this.processPR(pr, projectPath, state, key);
        }
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
        const pipeline = createPipelineFromConfig(
          this.config.roles,
          this.config.maxIterations
        );
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
      try {
        await gitExec(projectPath, 'checkout', originalBranch);
      } catch (restoreErr) {
        console.error(`[PRProcessor] Failed to restore branch ${originalBranch}:`, restoreErr);
      }
    }
  }

  /**
   * Map repo to local project path
   */
  private mapRepoToProject(repo: string): string | null {
    // "Intrect-io/STONKS" → "STONKS"
    const repoName = repo.split('/').pop();
    if (!repoName) return null;

    const candidate = resolve(homedir(), 'dev', repoName);
    if (existsSync(candidate)) {
      return candidate;
    }

    console.log(`[PRProcessor] No local directory for ${repo} (tried: ${candidate})`);
    return null;
  }

  // ============================================
  // State Persistence
  // ============================================

  private async loadState(): Promise<PRState> {
    try {
      const data = await readFile(PR_STATE_PATH, 'utf-8');
      return JSON.parse(data);
    } catch {
      return { prs: {}, updatedAt: new Date().toISOString() };
    }
  }

  private async saveState(state: PRState): Promise<void> {
    await mkdir(resolve(homedir(), '.openswarm'), { recursive: true });
    state.updatedAt = new Date().toISOString();
    await writeFile(PR_STATE_PATH, JSON.stringify(state, null, 2));
  }
}

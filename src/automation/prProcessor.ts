// ============================================
// OpenSwarm - PR Auto-Improvement Processor
// Open PR auto-improvement (Worker-Reviewer iteration loop)
// ============================================

import {
  checkPRCIStatus,
  checkPRConflicts,
  commentOnPR,
  getOpenPRs,
  getPRContext,
  waitForCICompletion,
  type PRInfo,
} from '../github/index.js';
import { getScheduler } from '../orchestration/taskScheduler.js';
import { reportEvent } from '../discord/index.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { PRProcessorBase } from './prProcessorBase.js';
import {
  getActiveCriticalComments,
  gitExec,
  restoreAutoStash,
  stashLocalChanges,
  type AutoStash,
  type PRState,
} from './prProcessorShared.js';

export { isReviewBotComment, getActiveCriticalComments } from './prProcessorShared.js';
export type { PRIssueComment } from './prProcessorShared.js';
export type { PRProcessorConfig } from './prProcessorBase.js';

// PR Processor

export class PRProcessor extends PRProcessorBase {
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

          // If no conflicts and no review feedback, check only the current
          // head's CI status. There is deliberately no time-based cooldown:
          // a new head is new evidence and must be evaluated immediately.
          if (!hasConflicts && !hasReviewFeedback) {
            const ciStatus = await checkPRCIStatus(repo, pr.number, pr.headSha);
            if (ciStatus.status !== 'failure') {
              const detail = ciStatus.status === 'unknown' ? `CI identity unknown (${ciStatus.reason})` : `CI ${ciStatus.status} at ${ciStatus.headSha}`;
              console.log(`[PRProcessor] ${key}: no conflicts or review feedback; ${detail}, skipping`);
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

          if (hasReviewFeedback && !hasConflicts) {
            const ciStatus = await checkPRCIStatus(repo, pr.number, pr.headSha);
            if (ciStatus.status === 'success') {
              console.log(`[PRProcessor] ${key}: Handling review feedback only (CI passing)`);
              await this.processReviewFeedback(pr, projectPath, state, key, 0);
              continue;
            }
            if (ciStatus.status === 'pending' || ciStatus.status === 'unknown') {
              const detail = ciStatus.status === 'unknown' ? `identity unknown (${ciStatus.reason})` : `pending at ${ciStatus.headSha}`;
              state.prs[key].status = 'pending';
              state.prs[key].lastError = `CI ${detail}`;
              console.log(`[PRProcessor] ${key}: CI ${detail}; deferring review feedback`);
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
  protected async processPR(
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

        console.log(`[PRProcessor] ${key}: Pipeline succeeded, pushing changes...`);
        const publishedHeadSha = (await gitExec(projectPath, 'rev-parse', 'HEAD')).trim();
        if (!publishedHeadSha) throw new Error('Cannot publish CI remediation: HEAD identity is unavailable');
        await gitExec(projectPath, 'push', 'origin', pr.branch);
        console.log(`[PRProcessor] ${key}: Waiting for CI checks...`);
        const ciStatus = await waitForCICompletion(pr.repo, pr.number, {
          timeoutMs: ciTimeoutMs,
          pollIntervalMs: ciPollIntervalMs,
          expectedHeadSha: publishedHeadSha,
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

        } else if (ciStatus.status === 'unknown') {
          lastError = `CI head identity unknown (${ciStatus.reason};${ciStatus.expectedHeadSha ? ` expected ${ciStatus.expectedHeadSha}` : ''}${ciStatus.observedHeadSha ? ` observed ${ciStatus.observedHeadSha}` : ''})`;
          console.log(`[PRProcessor] ${key}: ${lastError}`);
          break;
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
  protected async processReviewFeedback(
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
}

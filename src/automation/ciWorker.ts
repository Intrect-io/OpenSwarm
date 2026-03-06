// ============================================
// OpenSwarm - CI Failure Investigation Worker
// Monitors CI failures and takes automatic actions
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  checkRepoHealth,
  loadCIState,
  saveCIState,
  getFailedJobLogs,
  needsReminder,
  type RepoHealth,
  type HealthTransition,
  type ActiveFailure,
} from '../github/github.js';
import { createIssue } from '../linear/linear.js';
import { broadcastEvent } from '../core/eventHub.js';

const execFileAsync = promisify(execFile);

// ============================================
// Types
// ============================================

export interface CIWorkerConfig {
  /** Repositories to monitor */
  repos: string[];
  /** Check interval in ms (default: 5 minutes) */
  checkIntervalMs?: number;
  /** Auto-retry flaky tests */
  autoRetry?: boolean;
  /** Create Linear issues for failures */
  createIssues?: boolean;
  /** Max age of failures to consider (days) */
  maxAgeDays?: number;
}

export interface FailureAnalysis {
  type: 'flaky' | 'real' | 'unknown';
  confidence: number;
  reason: string;
  suggestion?: string;
}

// ============================================
// CI Worker
// ============================================

export class CIWorker {
  private config: Required<CIWorkerConfig>;
  private intervalId?: NodeJS.Timeout;
  private processing = false;

  constructor(config: CIWorkerConfig) {
    this.config = {
      checkIntervalMs: config.checkIntervalMs ?? 5 * 60 * 1000, // 5 minutes
      autoRetry: config.autoRetry ?? false,
      createIssues: config.createIssues ?? true,
      maxAgeDays: config.maxAgeDays ?? 30,
      ...config,
    };
  }

  /** Start CI monitoring */
  start(): void {
    if (this.intervalId) {
      console.log('[CIWorker] Already running');
      return;
    }

    console.log(`[CIWorker] Starting (interval: ${this.config.checkIntervalMs / 1000}s, repos: ${this.config.repos.length})`);

    // Run immediately on start
    this.checkCI().catch((err) => console.error('[CIWorker] Initial check failed:', err));

    // Then run periodically
    this.intervalId = setInterval(() => {
      this.checkCI().catch((err) => console.error('[CIWorker] Check failed:', err));
    }, this.config.checkIntervalMs);
  }

  /** Stop CI monitoring */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
      console.log('[CIWorker] Stopped');
    }
  }

  /** Check CI status for all repos */
  private async checkCI(): Promise<void> {
    if (this.processing) {
      console.log('[CIWorker] Previous check still running, skipping...');
      return;
    }

    this.processing = true;
    try {
      const state = await loadCIState();

      for (const repo of this.config.repos) {
        const current = state.repos[repo];
        const { health, transition } = await checkRepoHealth(repo, current);

        // Update state
        state.repos[repo] = health;

        // Handle transitions
        if (transition) {
          await this.handleTransition(transition);
        }

        // Handle persistent failures (reminder)
        if (needsReminder(health, 24)) {
          await this.handlePersistentFailure(health);
          health.lastReminder = new Date().toISOString();
        }
      }

      await saveCIState(state);
    } finally {
      this.processing = false;
    }
  }

  /** Handle health state transition */
  private async handleTransition(transition: HealthTransition): Promise<void> {
    const { repo, from, to, activeFailures } = transition;

    if (to === 'broken' && from !== 'broken') {
      console.log(`[CIWorker] 🔴 ${repo} CI broken: ${activeFailures.length} failure(s)`);

      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'ci-worker',
          stage: 'ci',
          line: `CI broken: ${repo} (${activeFailures.length} failures)`,
        },
      });

      // Process each failure
      for (const failure of activeFailures) {
        await this.investigateFailure(repo, failure);
      }
    } else if (to === 'healthy' && from === 'broken') {
      console.log(`[CIWorker] ✅ ${repo} CI recovered`);

      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'ci-worker',
          stage: 'ci',
          line: `CI recovered: ${repo}`,
        },
      });

      // Close related Linear issues
      await this.closeRelatedIssues(repo, transition.resolvedFailures);
    }
  }

  /** Investigate a CI failure */
  private async investigateFailure(repo: string, failure: ActiveFailure): Promise<void> {
    console.log(`[CIWorker] Investigating: ${repo} - ${failure.workflow} (${failure.branch})`);

    // Get failure logs
    const logs = await getFailedJobLogs(repo, failure.runId);
    if (!logs) {
      console.warn(`[CIWorker] No logs available for run ${failure.runId}`);
      return;
    }

    // Analyze failure
    const analysis = await this.analyzeFailure(logs, failure);
    console.log(`[CIWorker] Analysis: ${analysis.type} (confidence: ${analysis.confidence})`);

    // Take action based on analysis
    if (analysis.type === 'flaky' && this.config.autoRetry) {
      await this.retryRun(repo, failure.runId);
    } else if (analysis.type === 'real' && this.config.createIssues) {
      await this.createFailureIssue(repo, failure, logs, analysis);
    }
  }

  /** Analyze failure to determine if flaky or real */
  private async analyzeFailure(logs: string, _failure: ActiveFailure): Promise<FailureAnalysis> {
    // Simple heuristics (can be enhanced with Claude API for deeper analysis)

    // Flaky indicators
    const flakyPatterns = [
      /timeout/i,
      /network.*error/i,
      /connection.*refused/i,
      /temporarily unavailable/i,
      /rate.*limit/i,
      /503.*service unavailable/i,
    ];

    const flakyScore = flakyPatterns.filter((p) => p.test(logs)).length;

    // Real failure indicators
    const realPatterns = [
      /assertion.*failed/i,
      /test.*failed/i,
      /syntax.*error/i,
      /type.*error/i,
      /reference.*error/i,
      /expected.*but.*got/i,
    ];

    const realScore = realPatterns.filter((p) => p.test(logs)).length;

    if (flakyScore > realScore && flakyScore > 0) {
      return {
        type: 'flaky',
        confidence: Math.min(0.9, flakyScore * 0.3),
        reason: 'Detected timeout/network issues',
        suggestion: 'Auto-retry recommended',
      };
    } else if (realScore > 0) {
      return {
        type: 'real',
        confidence: Math.min(0.9, realScore * 0.3),
        reason: 'Test/assertion failures detected',
        suggestion: 'Code fix required',
      };
    }

    return {
      type: 'unknown',
      confidence: 0.5,
      reason: 'Unable to classify failure',
    };
  }

  /** Retry a failed workflow run */
  private async retryRun(repo: string, runId: number): Promise<void> {
    try {
      console.log(`[CIWorker] Retrying run: ${repo}#${runId}`);
      await execFileAsync('gh', ['run', 'rerun', String(runId), '-R', repo, '--failed']);

      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'ci-worker',
          stage: 'ci',
          line: `Retrying CI: ${repo}#${runId}`,
        },
      });
    } catch (err) {
      console.error(`[CIWorker] Failed to retry run ${runId}:`, err);
    }
  }

  /** Create Linear issue for CI failure */
  private async createFailureIssue(
    repo: string,
    failure: ActiveFailure,
    logs: string,
    analysis: FailureAnalysis
  ): Promise<void> {
    // Create new issue (skip duplicate check for simplicity)
    const repoShort = repo.split('/').pop() || repo;
    const title = `CI: ${repoShort} - ${failure.workflow} failing on ${failure.branch}`;
    const description = [
      `## CI Failure`,
      ``,
      `**Repository**: ${repo}`,
      `**Workflow**: ${failure.workflow}`,
      `**Branch**: ${failure.branch}`,
      `**Run**: ${failure.url}`,
      `**Created**: ${failure.createdAt}`,
      ``,
      `### Analysis`,
      `- **Type**: ${analysis.type}`,
      `- **Confidence**: ${Math.round(analysis.confidence * 100)}%`,
      `- **Reason**: ${analysis.reason}`,
      analysis.suggestion ? `- **Suggestion**: ${analysis.suggestion}` : '',
      ``,
      `### Logs (last 50 lines)`,
      `\`\`\``,
      logs.split('\n').slice(-50).join('\n'),
      `\`\`\``,
      ``,
      `---`,
      `🤖 Auto-detected by OpenSwarm CI Worker`,
    ].filter(Boolean).join('\n');

    const issue = await createIssue(
      title,
      description,
      ['ci-failure', 'automated']
    );

    if (issue && 'identifier' in issue) {
      console.log(`[CIWorker] Created Linear issue: ${issue.identifier}`);

      broadcastEvent({
        type: 'log',
        data: {
          taskId: 'ci-worker',
          stage: 'ci',
          line: `Created issue ${issue.identifier} for CI failure`,
        },
      });
    } else if (issue && 'error' in issue) {
      console.error(`[CIWorker] Failed to create issue: ${issue.error}`);
    }
  }

  /** Handle persistent failures (reminder) */
  private async handlePersistentFailure(health: RepoHealth): Promise<void> {
    if (!health.brokenSince) return;

    const brokenDays = Math.floor(
      (Date.now() - new Date(health.brokenSince).getTime()) / (24 * 60 * 60 * 1000)
    );

    console.log(`[CIWorker] ⚠️  ${health.repo} CI still broken (${brokenDays}d)`);

    broadcastEvent({
      type: 'log',
      data: {
        taskId: 'ci-worker',
        stage: 'ci',
        line: `CI still broken: ${health.repo} (${brokenDays}d, ${health.activeFailures.length} failures)`,
      },
    });

    // TODO: Add reminder functionality once searchIssues is available
  }

  /** Close related Linear issues when CI recovers */
  private async closeRelatedIssues(
    repo: string,
    resolvedFailures?: ActiveFailure[]
  ): Promise<void> {
    if (!resolvedFailures || resolvedFailures.length === 0) return;

    console.log(`[CIWorker] ✅ ${repo} CI recovered (${resolvedFailures.length} failures resolved)`);
    // TODO: Add issue closing functionality once searchIssues is available
  }
}

// ============================================
// Export
// ============================================

let workerInstance: CIWorker | null = null;

export function startCIWorker(config: CIWorkerConfig): void {
  if (workerInstance) {
    console.log('[CIWorker] Already started');
    return;
  }

  workerInstance = new CIWorker(config);
  workerInstance.start();
}

export function stopCIWorker(): void {
  if (workerInstance) {
    workerInstance.stop();
    workerInstance = null;
  }
}

export function getCIWorkerStatus(): { running: boolean; config?: CIWorkerConfig } {
  return {
    running: workerInstance !== null,
    config: workerInstance?.['config'],
  };
}

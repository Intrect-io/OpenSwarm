// ============================================
// OpenSwarm - CLI Runner
// Standalone task execution without daemon services
// ============================================

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { PairPipeline, type PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig } from '../core/types.js';
import { getAdapter, getDefaultAdapterName, listAvailableAdapters } from '../adapters/index.js';
import { initLocale } from '../locale/index.js';
import { expandPath } from '../core/config.js';
import { startProgressHeartbeat, type ReviewProgress } from '../cli/reviewProgress.js';
import { status } from '../support/colors.js';
import { sanitizeTerminalText } from '../tui/sanitize.js';
import { safeConsole as console } from '../support/safeLog.js';

// Types

export interface CliRunOptions {
  task: string;
  projectPath?: string;
  model?: string;
  pipeline?: boolean;
  workerOnly?: boolean;
  maxIterations?: number;
  verbose?: boolean;
  /** Record the outcome into repo knowledge (default true; --no-learn opts out). (INT-2268) */
  learn?: boolean;
}

// Helpers

// expandPath imported from core/config.ts (with resolveRelative=true for CLI paths)

/** Check if the configured/default adapter can run before starting the pipeline */
async function checkDefaultAdapter(): Promise<boolean> {
  return getAdapter(getDefaultAdapterName()).isAvailable();
}

function validateMaxIterations(value: number | undefined): number {
  const maxIterations = value ?? 3;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    console.error(`Error: --max-iterations must be a positive integer. Received: ${String(value)}`);
    process.exit(1);
  }
  return maxIterations;
}

/** Format duration as human-readable string */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  return `${minutes}m ${remaining.toFixed(0)}s`;
}

// Main Runner

export async function runCli(options: CliRunOptions): Promise<void> {
  // Initialize locale (needed for prompt templates)
  initLocale('en');

  // 1. Check configured/default adapter
  if (!await checkDefaultAdapter()) {
    const adapterName = getDefaultAdapterName();
    const availableAdapters = await listAvailableAdapters();
    console.error(`Error: CLI adapter "${adapterName}" is not available.`);
    console.error(
      availableAdapters.length > 0
        ? `Available adapters: ${availableAdapters.join(', ')}`
        : 'No registered adapters are currently available.'
    );
    process.exit(1);
  }

  // 2. Resolve project path
  const projectPath = expandPath(options.projectPath ?? process.cwd(), true);
  let projectStats: ReturnType<typeof statSync>;
  try {
    projectStats = statSync(projectPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    console.error(
      code === 'ENOENT'
        ? `Error: Project path does not exist: ${projectPath}`
        : `Error: Project path is not accessible: ${projectPath}`
    );
    process.exit(1);
  }
  if (!projectStats.isDirectory()) {
    console.error(`Error: Project path is not a directory: ${projectPath}`);
    process.exit(1);
  }
  try {
    accessSync(projectPath, constants.R_OK | constants.X_OK);
  } catch {
    console.error(`Error: Project path is not accessible: ${projectPath}`);
    process.exit(1);
  }

  // 3. Determine stages
  let stages: PipelineStage[];
  if (options.workerOnly) {
    stages = ['worker'];
  } else if (options.pipeline) {
    stages = ['worker', 'reviewer', 'tester', 'documenter'];
  } else {
    stages = ['worker', 'reviewer'];
  }

  // 4. Build role config
  const roles: Record<string, RoleConfig> = {};
  if (options.model) {
    roles.worker = { enabled: true, model: options.model, timeoutMs: 0 };
  }

  // 5. Create local TaskItem
  const task: TaskItem = {
    id: `cli-${Date.now()}`,
    source: 'local',
    title: options.task,
    description: options.task,
    priority: 3,
    projectPath,
    createdAt: Date.now(),
  };

  // 6. Create pipeline
  const maxIterations = validateMaxIterations(options.maxIterations);
  const pipeline = new PairPipeline({
    stages,
    maxIterations,
    roles: Object.keys(roles).length > 0 ? roles as any : undefined,
    verbose: options.verbose,
  });

  // 7. Print header
  const stageNames = stages.join(' -> ');
  const shortPath = projectPath.replace(homedir(), '~');
  console.log('');
  console.log('  OpenSwarm v0.1.0');
  console.log('');
  console.log(`  Project:  ${shortPath}`);
  console.log(`  Pipeline: ${stageNames}`);
  if (options.model) {
    console.log(`  Model:    ${options.model}`);
  }
  if (options.verbose) {
    console.log(`  Verbose:  enabled`);
  }
  console.log('');

  // 8. Attach event listeners for progress
  // Every stage (worker included) gets the same animated braille heartbeat the
  // reviewer has, so a running stage never looks frozen. On a non-TTY or in
  // verbose mode (where each tool line is printed) we fall back to plain lines.
  // (INT-2260)
  const liveSpinner = !!process.stdout.isTTY && !options.verbose;
  let heartbeat: ReviewProgress | null = null;
  const stopHeartbeat = () => {
    heartbeat?.stop();
    heartbeat = null;
  };

  pipeline.on('stage:start', ({ stage }: { stage: string }) => {
    stage = sanitizeTerminalText(stage);
    if (liveSpinner) heartbeat = startProgressHeartbeat(`${stage}…`, { write: (s) => process.stdout.write(s) });
    else process.stdout.write(`  ~ ${stage}...\n`);
  });

  pipeline.on('stage:complete', ({ stage, result }: { stage: string; result: { success: boolean; duration: number } }) => {
    stage = sanitizeTerminalText(stage);
    stopHeartbeat();
    const duration = (result.duration / 1000).toFixed(1);
    const line = `${stage} (${duration}s)`;
    process.stdout.write(`  ${result.success ? status.ok(line) : status.err(line)}\n`);
  });

  pipeline.on('stage:fail', ({ stage, result }: { stage: string; result: { duration: number } }) => {
    stage = sanitizeTerminalText(stage);
    stopHeartbeat();
    const duration = (result.duration / 1000).toFixed(1);
    process.stdout.write(`  ${status.err(`${stage} (${duration}s) FAILED`)}\n`);
  });

  pipeline.on('iteration:start', ({ iteration, maxIterations }: { iteration: number; maxIterations: number }) => {
    if (iteration > 1) {
      console.log(`\n  --- Iteration ${iteration}/${maxIterations} ---`);
    }
  });

  // 8.5. Verbose event listeners
  if (options.verbose) {
    pipeline.on('log', ({ line }: { line: string }) => {
      console.log(`  ${sanitizeTerminalText(line)}`);
    });

    pipeline.on('halt', ({ reason, sessionId }: { reason: string; sessionId: string }) => {
      console.log(`  [verbose] HALT: ${sanitizeTerminalText(reason)} (session: ${sanitizeTerminalText(sessionId)})`);
    });

    pipeline.on('stuck', ({ sessionId, iteration }: { sessionId: string; iteration: number }) => {
      console.log(`  [verbose] STUCK detected at iteration ${iteration} (session: ${sanitizeTerminalText(sessionId)})`);
    });

    pipeline.on('iteration:fail', ({ iteration, reason }: { iteration: number; reason?: string }) => {
      console.log(`  [verbose] Iteration ${iteration} failed${reason ? `: ${sanitizeTerminalText(reason)}` : ''}`);
    });

    pipeline.on('iteration:complete', ({ iteration }: { iteration: number }) => {
      console.log(`  [verbose] Iteration ${iteration} completed`);
    });
  }

  // 9. Run pipeline
  let result: PipelineResult;
  try {
    result = await pipeline.run(task, projectPath);
  } catch (error) {
    stopHeartbeat();
    console.error('\n  Pipeline execution failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
    return;
  }

  // 10. Format & print result
  printResult(result);

  // 10.5. Learn: record the outcome into repo knowledge so a standalone `run`
  // grows the codebase memory like the daemon does (default on; --no-learn opts
  // out for throwaway/exploratory runs). Non-critical. (INT-2268)
  if (options.learn !== false) {
    try {
      const { recordTaskOutcome } = await import('../memory/repoKnowledge.js');
      await recordTaskOutcome(projectPath, {
        taskTitle: options.task,
        workerResult: result.workerResult
          ? { filesChanged: result.workerResult.filesChanged, commands: result.workerResult.commands, summary: result.workerResult.summary }
          : null,
        rejectionFeedback: result.finalStatus === 'rejected' ? result.reviewResult?.feedback : undefined,
        iterations: result.iterations,
        derivedFrom: 'cli:run',
      });
    } catch {
      // recordTaskOutcome is already non-throwing; belt-and-suspenders.
    }
  }

  // 11. Exit code
  process.exitCode = result.success ? 0 : 1;
}

// Result Formatting

function printResult(result: PipelineResult): void {
  console.log('');
  console.log('  ======================================');

  const statusLabel = result.finalStatus.toUpperCase();
  const statusLine = result.success
    ? `  Result: ${statusLabel}`
    : `  Result: ${statusLabel}`;
  console.log(statusLine);

  console.log('  ======================================');

  // Summary
  if (result.workerResult?.summary) {
    console.log(`  Summary: ${sanitizeTerminalText(result.workerResult.summary)}`);
  }

  // Files changed
  if (result.workerResult?.filesChanged && result.workerResult.filesChanged.length > 0) {
    const files = result.workerResult.filesChanged;
    if (files.length <= 5) {
      console.log(`  Files:   ${files.map(sanitizeTerminalText).join(', ')}`);
    } else {
      console.log(`  Files:   ${files.slice(0, 5).join(', ')} +${files.length - 5} more`);
    }
  }

  // Cost and duration
  const parts: string[] = [];
  if (result.totalCost) {
    parts.push(`$${result.totalCost.costUsd.toFixed(4)}`);
  }
  parts.push(`Duration: ${formatDuration(result.totalDuration)}`);
  console.log(`  ${parts.join(' | ')}`);

  // Reviewer feedback on failure
  if (!result.success && result.reviewResult?.feedback) {
    console.log('');
    console.log('  Feedback:');
    const lines = result.reviewResult.feedback.split('\n').slice(0, 5);
    for (const line of lines) {
      console.log(`    ${line}`);
    }
  }

  console.log('  ======================================');
  console.log('');
}

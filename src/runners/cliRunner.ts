// ============================================
// OpenSwarm - CLI Runner
// Standalone task execution without daemon services
// ============================================

import { execSync } from 'node:child_process';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

import { PairPipeline, type PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig } from '../core/types.js';
import { initLocale } from '../locale/index.js';
import { formatCost } from '../support/costTracker.js';

// ============================================
// Types
// ============================================

export interface CliRunOptions {
  task: string;
  projectPath?: string;
  model?: string;
  pipeline?: boolean;
  workerOnly?: boolean;
  maxIterations?: number;
}

// ============================================
// Helpers
// ============================================

/** Expand ~/... paths */
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/** Check if Claude CLI is installed */
function checkClaudeCli(): boolean {
  try {
    execSync('which claude', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

// ============================================
// Main Runner
// ============================================

export async function runCli(options: CliRunOptions): Promise<void> {
  // Initialize locale (needed for prompt templates)
  initLocale('en');

  // 1. Check Claude CLI
  if (!checkClaudeCli()) {
    console.error('Error: Claude CLI not found.');
    console.error('Install it: https://docs.anthropic.com/en/docs/claude-code');
    process.exit(1);
  }

  // 2. Resolve project path
  const projectPath = expandPath(options.projectPath ?? process.cwd());
  if (!existsSync(projectPath)) {
    console.error(`Error: Project path does not exist: ${projectPath}`);
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
  const pipeline = new PairPipeline({
    stages,
    maxIterations: options.maxIterations ?? 3,
    roles: Object.keys(roles).length > 0 ? roles as any : undefined,
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
  console.log('');

  // 8. Attach event listeners for progress
  const stageStartTimes = new Map<string, number>();

  pipeline.on('stage:start', ({ stage }: { stage: string }) => {
    stageStartTimes.set(stage, Date.now());
    process.stdout.write(`  ~ ${stage}...`);
  });

  pipeline.on('stage:complete', ({ stage, result }: { stage: string; result: { success: boolean; duration: number } }) => {
    const symbol = result.success ? 'v' : 'x';
    const duration = (result.duration / 1000).toFixed(1);
    // Clear the "running" line and replace with result
    process.stdout.write(`\r  ${symbol} ${stage} (${duration}s)\n`);
  });

  pipeline.on('stage:fail', ({ stage, result }: { stage: string; result: { duration: number } }) => {
    const duration = (result.duration / 1000).toFixed(1);
    process.stdout.write(`\r  x ${stage} (${duration}s) FAILED\n`);
  });

  pipeline.on('iteration:start', ({ iteration, maxIterations }: { iteration: number; maxIterations: number }) => {
    if (iteration > 1) {
      console.log(`\n  --- Iteration ${iteration}/${maxIterations} ---`);
    }
  });

  // 9. Run pipeline
  let result: PipelineResult;
  try {
    result = await pipeline.run(task, projectPath);
  } catch (error) {
    console.error('\n  Pipeline execution failed:', error instanceof Error ? error.message : error);
    process.exit(1);
  }

  // 10. Format & print result
  printResult(result);

  // 11. Exit code
  process.exit(result.success ? 0 : 1);
}

// ============================================
// Result Formatting
// ============================================

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
    console.log(`  Summary: ${result.workerResult.summary}`);
  }

  // Files changed
  if (result.workerResult?.filesChanged && result.workerResult.filesChanged.length > 0) {
    const files = result.workerResult.filesChanged;
    if (files.length <= 5) {
      console.log(`  Files:   ${files.join(', ')}`);
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

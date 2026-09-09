// ============================================
// OpenSwarm - CLI Runner
// Standalone task execution without daemon services
// ============================================

import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';

import { PairPipeline, type PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineStage, RoleConfig } from '../core/types.js';
import { getAdapter, getDefaultAdapterName, listAvailableAdapters, probeAdapterAvailability } from '../adapters/index.js';
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
  return probeAdapterAvailability(getAdapter(getDefaultAdapterName()));
}

function validateMaxIterations(value: number | undefined): number {
  const maxIterations = value ?? 3;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) {
    console.error(`Error: --max-iterations must be a positive integer. Received: ${String(value)}`);
    process.exit(1);
  }
  return maxIterations;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
  return `${seconds}s`;
}

/** Hard cap on bytes per line before sanitization (1 MB). */
const MAX_LINE_BYTES = 1048576;

/**
 * Truncate a raw line to MAX_LINE_BYTES before sanitization to prevent
 * memory exhaustion from attacker-controlled or excessively verbose output.
 */
function truncateLine(raw: string): string {
  if (raw.length > MAX_LINE_BYTES) {
    return raw.slice(0, MAX_LINE_BYTES) + '... [truncated]';
  }
  return raw;
}

/**
 * Run the CLI pipeline
 */
export async function runCli(options: CliRunOptions): Promise<void> {
  const { task, projectPath } = options;

  // 1. Validate adapter availability
  const adapterAvailable = await checkDefaultAdapter();
  if (!adapterAvailable) {
    console.error('Error: No adapter available. Please configure an adapter first.');
    process.exit(1);
  }

  // 2. Validate project path
  const resolvedPath = expandPath(projectPath || process.cwd());
  try {
    accessSync(resolvedPath, constants.R_OK);
  } catch {
    console.error(`Error: Cannot access project path: ${resolvedPath}`);
    process.exit(1);
  }

  // 3. Validate max iterations
  const maxIterations = validateMaxIterations(options.maxIterations);

  // 4. Initialize locale
  initLocale();

  // 5. Build pipeline stages
  const stages: PipelineStage[] = [];
  if (options.pipeline) {
    stages.push('worker', 'reviewer');
  } else if (options.workerOnly) {
    stages.push('worker');
  } else {
    stages.push('worker', 'reviewer');
  }

  // 6. Build role configs
  const roleConfigs: RoleConfig[] = stages.map((stage) => ({
    stage,
    model: options.model,
  }));

  // 7. Print header
  const stageNames = stages.join(' -> ');
  const shortPath = resolvedPath.replace(homedir(), '~');
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

  const pipeline = new PairPipeline({
    stages: roleConfigs,
    maxIterations,
    verbose: options.verbose,
    learn: options.learn,
  });

  pipeline.on('stage:start', ({ stage }: { stage: string }) => {
    stage = sanitizeTerminalText(truncateLine(stage));
    if (liveSpinner) heartbeat = startProgressHeartbeat(`${stage}…`, { write: (s) => process.stdout.write(s) });
    else process.stdout.write(`  ~ ${stage}...\n`);
  });

  pipeline.on('stage:complete', ({ stage, result }: { stage: string; result: { success: boolean; duration: number } }) => {
    stage = sanitizeTerminalText(truncateLine(stage));
    stopHeartbeat();
    const icon = result.success ? status.check : status.fail;
    const dur = formatDuration(result.duration);
    process.stdout.write(`  ${icon} ${stage} (${dur})\n`);
  });

  pipeline.on('stage:fail', ({ stage, error }: { stage: string; error: string }) => {
    stage = sanitizeTerminalText(truncateLine(stage));
    stopHeartbeat();
    process.stdout.write(`  ${status.fail} ${stage}: ${sanitizeTerminalText(truncateLine(error))}\n`);
  });

  pipeline.on('iteration:start', ({ iteration, maxIterations }: { iteration: number; maxIterations: number }) => {
    if (iteration > 1) {
      console.log(`\n  --- Iteration ${iteration}/${maxIterations} ---`);
    }
  });

  // 8.5. Verbose event listeners
  if (options.verbose) {
    pipeline.on('log', ({ line }: { line: string }) => {
      console.log(`  ${sanitizeTerminalText(truncateLine(line))}`);
    });

    pipeline.on('halt', ({ reason, sessionId }: { reason: string; sessionId: string }) => {
      console.log(`  [verbose] HALT: ${sanitizeTerminalText(truncateLine(reason))} (session: ${sanitizeTerminalText(truncateLine(sessionId))})`);
    });

    pipeline.on('stuck', ({ sessionId, iteration }: { sessionId: string; iteration: number }) => {
      console.log(`  [verbose] STUCK detected at iteration ${iteration} (session: ${sanitizeTerminalText(truncateLine(sessionId))})`);
    });

    pipeline.on('iteration:fail', ({ iteration, reason }: { iteration: number; reason?: string }) => {
      console.log(`  [verbose] Iteration ${iteration} failed${reason ? `: ${sanitizeTerminalText(truncateLine(reason))}` : ''}`);
    });

    pipeline.on('iteration:complete', ({ iteration }: { iteration: number }) => {
      console.log(`  [verbose] Iteration ${iteration} completed`);
    });
  }

  // 9. Run pipeline
  let result: PipelineResult;
  try {
    result = await pipeline.run(task, resolvedPath);
  } catch (err) {
    stopHeartbeat();
    console.error('Pipeline execution failed:', err);
    process.exit(1);
  }

  stopHeartbeat();

  // 10. Print result
  printResult(result);
}

/**
 * Print pipeline result
 */
function printResult(result: PipelineResult): void {
  console.log('');
  console.log('  ======================================');
  console.log(`  ${result.success ? status.check : status.fail} Result: ${result.success ? 'Success' : 'Failed'}`);

  // Summary
  if (result.workerResult?.summary) {
    console.log(`  Summary: ${sanitizeTerminalText(truncateLine(result.workerResult.summary))}`);
  }

  // Files changed
  if (result.workerResult?.filesChanged && result.workerResult.filesChanged.length > 0) {
    const files = result.workerResult.filesChanged;
    console.log(`  Files:   ${files.map((f) => sanitizeTerminalText(truncateLine(f))).join(', ')}`);
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
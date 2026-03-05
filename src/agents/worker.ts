// ============================================
// OpenSwarm - Worker Agent
// Task execution agent (CLI adapter based)
// ============================================

import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';
import * as gitTracker from '../support/gitTracker.js';
import { t, getPrompts } from '../locale/index.js';
import type { ProcessContext } from '../adapters/types.js';
import { getAdapter, spawnCli } from '../adapters/index.js';

/**
 * Expand ~ path to home directory
 */
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return p.replace('~', homedir());
  }
  return p;
}

// ============================================
// Types
// ============================================

export interface WorkerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  previousFeedback?: string;   // Previous feedback from Reviewer (for revisions)
  timeoutMs?: number;
  model?: string;              // Claude model (default: claude-sonnet-4-5-20250929)
  issueIdentifier?: string;    // Linear issue ID (e.g., INT-123)
  projectName?: string;        // Linear project name
  onLog?: (line: string) => void;  // Callback for stdout streaming
  processContext?: ProcessContext;
}

// ============================================
// Prompts
// ============================================

/**
 * Build Worker prompt using locale templates
 */
function buildWorkerPrompt(options: WorkerOptions): string {
  return getPrompts().buildWorkerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    previousFeedback: options.previousFeedback,
  });
}

// ============================================
// Worker Execution
// ============================================

/**
 * Run Worker agent
 * Integrates Git-based file change tracking (Aider style)
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const prompt = buildWorkerPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter();

  // Git snapshot (pre-work state)
  let snapshotHash = '';
  const isGitRepo = await gitTracker.isGitRepo(cwd);
  if (isGitRepo) {
    snapshotHash = await gitTracker.takeSnapshot(cwd);
    console.log(`[Worker] Git snapshot: ${snapshotHash.slice(0, 8)}`);
  }

  try {
    // Run CLI via adapter
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs,
      model: options.model,
      onLog: options.onLog,
      processContext: options.processContext,
    });

    // Parse result via adapter
    const parsedResult = adapter.parseWorkerOutput(raw);

    // Extract actually changed files via Git diff (independent of LLM report)
    if (isGitRepo && snapshotHash) {
      const gitChangedFiles = await gitTracker.getChangedFilesSinceSnapshot(cwd, snapshotHash);

      if (gitChangedFiles.length > 0) {
        console.log(`[Worker] Git detected changes: ${gitChangedFiles.join(', ')}`);

        // Merge with LLM-reported files (Git results take priority)
        const mergedFiles = new Set([
          ...gitChangedFiles,
          ...parsedResult.filesChanged,
        ]);
        parsedResult.filesChanged = Array.from(mergedFiles);
      } else if (parsedResult.filesChanged.length === 0) {
        console.log('[Worker] No file changes detected by Git or LLM');
      }
    }

    return parsedResult;
  } catch (error) {
    return {
      success: false,
      summary: 'Worker execution failed',
      filesChanged: [],
      commands: [],
      output: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================
// Formatting
// ============================================

/**
 * Format Worker result as a Discord message
 */
export function formatWorkReport(result: WorkerResult, context?: {
  issueIdentifier?: string;
  projectName?: string;
  projectPath?: string;
}): string {
  const lines: string[] = [];

  // Project/issue context header
  if (context?.projectName || context?.issueIdentifier || context?.projectPath) {
    const parts: string[] = [];
    // projectName fallback: extract from projectPath if not provided
    const displayName = context.projectName
      || (context.projectPath ? context.projectPath.split('/').pop() || '' : '');
    if (displayName) parts.push(`📁 ${displayName}`);
    if (context.issueIdentifier) parts.push(`🔖 ${context.issueIdentifier}`);
    if (context.projectPath) parts.push(`\`${context.projectPath.split('/').slice(-2).join('/')}\``);
    if (parts.length > 0) {
      lines.push(parts.join(' | '));
      lines.push('');
    }
  }

  lines.push(result.success
    ? t('agents.worker.report.completed')
    : t('agents.worker.report.failed'));
  lines.push('');
  lines.push(t('agents.worker.report.summary', { text: result.summary }));

  if (result.filesChanged.length > 0) {
    const files = result.filesChanged;
    const fileList = files.length <= 15
      ? files.join(', ')
      : `${files.slice(0, 15).join(', ')} ${t('common.moreItems', { n: files.length - 15 })}`;
    lines.push(t('agents.worker.report.filesChanged', { count: files.length, list: fileList }));
  }

  if (result.commands.length > 0) {
    const cmdList = result.commands.slice(0, 5).map((c) => `\`${c}\``).join(', ');
    lines.push(t('agents.worker.report.commands', { list: cmdList }));
  }

  if (result.error) {
    lines.push(t('agents.worker.report.error', { text: result.error }));
  }

  return lines.join('\n');
}

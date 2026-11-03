// ============================================
// OpenSwarm - Development Task Execution
// ============================================

import { existsSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync, realpathSync, closeSync, fstatSync, openSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { checkWorkAllowed, getTimeWindowSummary } from './timeWindow.js';
import { extractCostFromStreamJson, formatCost } from './costTracker.js';
import { expandPath } from '../core/config.js';
import { safeInheritedEnv, CLAUDE_CLI_ENV_KEYS } from './spawnEnv.js';
import { runClaudeTask } from '../adapters/claudeTask.js';

/** Wall-clock ceiling for one dev task; the process group is killed after it. */
const DEV_TASK_TIMEOUT_MS = 30 * 60_000;
/** Turn ceiling for one dev task. */
const DEV_TASK_MAX_TURNS = 50;

/**
 * Known repository list (alias -> path)
 */
const KNOWN_REPOS: Record<string, string> = {
  // Tools
  pykis: '~/dev/tools/pykis',
  pykiwoom: '~/dev/tools/pykiwoom',
  'pykiwoom-rest': '~/dev/tools/pykiwoom-rest',

  // Projects - add as needed
  'OpenSwarm': '~/dev/OpenSwarm',
  stonks: '~/dev/STONKS',
  stockapi: '~/dev/StockAPI',
};

/**
 * Active dev task tracking
 */
type DevTask = {
  repo: string;
  path: string;
  task: string;
  controller: AbortController;
  output: string;
  startedAt: number;
  requestedBy: string;
};

const activeTasks: Map<string, DevTask> = new Map();

// expandPath imported from core/config.ts

/**
 * Resolve repository path
 * - Alias (pykis) -> known path
 * - Relative path (tools/pykis) -> under ~/dev/
 * - Absolute path (~/ or /) -> as-is
 */
export function resolveRepoPath(repo: string): string | null {
  // 1. Check known aliases
  if (KNOWN_REPOS[repo.toLowerCase()]) {
    const path = expandPath(KNOWN_REPOS[repo.toLowerCase()]);
    return existsSync(path) ? path : null;
  }

  // 2. Starts with ~/ or / (absolute path)
  if (repo.startsWith('~/') || repo.startsWith('/')) {
    const path = expandPath(repo);
    return existsSync(path) ? path : null;
  }

  // 3. Relative path (assumed under ~/dev/)
  //
  // Contained deliberately. This name arrives from a Discord message via
  // `!dev <repo> "<task>"`, and the path it resolves to becomes the cwd of a
  // `claude --permission-mode bypassPermissions` process. Without the check,
  // `../.ssh` resolved to ~/.ssh and `..` to the home directory — measured —
  // so a repo name alone chose where an unsandboxed agent would run.
  //
  // realpath, not just resolve: a symlink inside ~/dev pointing outside it
  // would otherwise pass a purely lexical check.
  const devRoot = realpathIfPossible(expandPath('~/dev'));
  const devPath = resolve(expandPath(`~/dev/${repo}`));
  if (!existsSync(devPath)) return null;
  const real = realpathIfPossible(devPath);
  if (real !== devRoot && !real.startsWith(devRoot + sep)) {
    console.warn(`[Dev] Refusing "${repo}": resolves outside ~/dev (${real})`);
    return null;
  }
  return devPath;
}

/** realpath when the path exists, the lexical form otherwise. */
function realpathIfPossible(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Return known repository list
 */
export function listKnownRepos(): { alias: string; path: string; exists: boolean }[] {
  return Object.entries(KNOWN_REPOS).map(([alias, path]) => ({
    alias,
    path,
    exists: existsSync(expandPath(path)),
  }));
}

/**
 * Scan repositories in ~/dev folder
 */
export function scanDevRepos(): string[] {
  const devDir = expandPath('~/dev');
  if (!existsSync(devDir)) return [];

  try {
    return readdirSync(devDir)
      .filter((name) => {
        const fullPath = resolve(devDir, name);
        try {
          return statSync(fullPath).isDirectory() &&
                 existsSync(resolve(fullPath, '.git'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Execute a dev task
 * @param bypassTimeWindow - if true, bypass time restrictions (for manual requests)
 */
export async function runDevTask(
  repo: string,
  task: string,
  requestedBy: string,
  onProgress?: (chunk: string) => void,
  onComplete?: (output: string, exitCode: number | null) => void,
  bypassTimeWindow = false,
): Promise<{ taskId: string; path: string } | { error: string }> {
  // Check time window (only for non-manual requests)
  if (!bypassTimeWindow) {
    const timeCheck = checkWorkAllowed();
    if (!timeCheck.allowed) {
      return {
        error: `Task blocked: ${timeCheck.reason}\nCurrent: ${timeCheck.currentTime}\n${timeCheck.nextAllowedTime ? `Next allowed time: ${timeCheck.nextAllowedTime}` : ''}`,
      };
    }
  }

  const path = resolveRepoPath(repo);

  if (!path) {
    return { error: `Repository not found: ${repo}` };
  }

  // Check if a task is already running for the same repo
  const existingTask = Array.from(activeTasks.values()).find(t => t.path === path);
  if (existingTask) {
    return { error: `A task is already running for ${repo} (id: ${existingTask.repo})` };
  }

  const taskId = `${repo}-${Date.now()}`;

  const controller = new AbortController();
  const devTask: DevTask = {
    repo,
    path,
    task,
    controller,
    output: '',
    startedAt: Date.now(),
    requestedBy,
  };

  activeTasks.set(taskId, devTask);

  // Completion is delivered exactly once, and cancelTask does not remove the
  // entry, so a second run for the same repo cannot be started while the
  // cancelled child is still shutting down.
  let finalized = false;
  const finalize = (resultText: string, code: number | null): void => {
    if (finalized) return;
    finalized = true;
    activeTasks.delete(taskId);
    try {
      onComplete?.(resultText, code);
    } catch (callbackError) {
      console.error(`[Dev] onComplete failed for ${taskId}:`, callbackError);
    }
  };

  // Not awaited: the caller gets the task id immediately and hears about
  // progress and completion through the callbacks.
  void runClaudeTask({
    prompt: task,
    cwd: path,
    timeoutMs: DEV_TASK_TIMEOUT_MS,
    maxTurns: DEV_TASK_MAX_TURNS,
    signal: controller.signal,
    // Not `process.env`. This child runs with bypassPermissions — it has a
    // shell — and the parent holds every provider key, the Linear token, and
    // npm/GitHub credentials, none of which the claude CLI needs. It keeps its
    // own (via HOME, or the ANTHROPIC_/CLAUDE_ variables an operator may
    // authenticate through) and nothing else.
    baseEnv: safeInheritedEnv(CLAUDE_CLI_ENV_KEYS),
    onLog: (line) => {
      devTask.output += `${line}\n`;
      try {
        onProgress?.(`${line}\n`);
      } catch (callbackError) {
        console.error(`[Dev] onProgress failed for ${taskId}:`, callbackError);
      }
    },
  }).then((result) => {
    let resultText = result.resultText || devTask.output;
    let code: number | null = result.success ? 0 : 1;
    try {
      const costInfo = extractCostFromStreamJson(result.stdout);
      if (costInfo) {
        console.log(`[Dev] ${repo} cost: ${formatCost(costInfo)}`);
      }
      if (!result.success) {
        if (result.error) devTask.output += `\nError: ${result.error}`;
        if (!result.resultText) resultText = devTask.output;
        if (!result.stdout) code = -1;
      }
      const duration = Math.floor((Date.now() - devTask.startedAt) / 1000);
      generateReport(devTask, code, duration);
    } catch (reportError) {
      // Reporting must not decide whether the task is finalized.
      console.error(`[Dev] completion reporting failed for ${taskId}:`, reportError);
    } finally {
      finalize(resultText, code);
    }
  }, (error: unknown) => {
    devTask.output += `\nError: ${error instanceof Error ? error.message : String(error)}`;
    finalize(devTask.output, -1);
  });

  return { taskId, path };
}

/**
 * List active tasks
 */
export function getActiveTasks(): { taskId: string; repo: string; path: string; startedAt: number; requestedBy: string }[] {
  return Array.from(activeTasks.entries()).map(([taskId, task]) => ({
    taskId,
    repo: task.repo,
    path: task.path,
    startedAt: task.startedAt,
    requestedBy: task.requestedBy,
  }));
}

/**
 * Cancel a task
 */
export function cancelTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task) return false;

  // Abort kills the child's process group; the run's completion handler then
  // finalizes and frees the slot. The entry stays until then — getActiveTasks
  // must not advertise the repo as free while the child is still running.
  task.controller.abort(new Error('Dev task cancelled'));
  return true;
}

/**
 * Add a known repository (at runtime)
 */
export function addKnownRepo(alias: string, path: string): void {
  KNOWN_REPOS[alias.toLowerCase()] = path;
}

/**
 * Generate task report
 */
function generateReport(task: DevTask, exitCode: number | null, durationSec: number): void {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

  // Report file path (reports/ directory inside the repo)
  const reportsDir = resolve(task.path, 'reports');
  const reportFile = resolve(reportsDir, `${dateStr}-report.md`);

  // Create reports directory
  try {
    if (!existsSync(reportsDir)) {
      mkdirSync(reportsDir, { recursive: true });
    }
  } catch (err) {
    console.error(`[Report] Failed to create reports directory: ${err}`);
    return;
  }

  // Output summary (truncate if too long)
  const outputSummary = task.output.length > 3000
    ? task.output.slice(-3000) + '\n\n...(truncated)'
    : task.output;

  // Status emoji
  const statusEmoji = exitCode === 0 ? '✅' : exitCode === null ? '⚠️' : '❌';
  const statusText = exitCode === 0 ? 'Success' : exitCode === null ? 'Interrupted' : `Failed (code: ${exitCode})`;

  // Report content
  const reportEntry = `
---

## ${statusEmoji} ${timeStr} Task Report

| Field | Details |
|-------|---------|
| **Requester** | ${task.requestedBy} |
| **Task** | ${task.task.slice(0, 100)}${task.task.length > 100 ? '...' : ''} |
| **Status** | ${statusText} |
| **Duration** | ${formatDuration(durationSec)} |

### Task Details

\`\`\`
${task.task}
\`\`\`

### Execution Result

\`\`\`
${outputSummary.trim() || '(no output)'}
\`\`\`

`;

  // Open once and inspect that descriptor. A path-based existence check followed
  // by append/write could be swapped by another local process in between.
  try {
    const fd = openSync(reportFile, 'a+', 0o600);
    try {
      if (fstatSync(fd).size === 0) {
        const header = `# ${dateStr} Task Report

> This file is auto-generated by OpenSwarm.
> Repository: \`${task.path}\`

`;
        writeFileSync(fd, header);
      }
      appendFileSync(fd, reportEntry, 'utf-8');
    } finally {
      closeSync(fd);
    }
    console.log(`[Report] Generated: ${reportFile}`);
  } catch (err) {
    console.error(`[Report] Failed to write report: ${err}`);
  }
}

/**
 * Format duration
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSec}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}h ${remainingMin}m`;
}

/**
 * Get current work availability status
 */
export function getWorkStatus(): { canWork: boolean; summary: string } {
  const timeCheck = checkWorkAllowed();
  return {
    canWork: timeCheck.allowed,
    summary: getTimeWindowSummary(),
  };
}

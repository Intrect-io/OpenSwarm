// ============================================
// Claude Swarm - Development Task Execution
// ============================================

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkWorkAllowed, getTimeWindowSummary } from './timeWindow.js';
import { extractCostFromStreamJson, formatCost } from './costTracker.js';

/**
 * Known repository list (alias -> path)
 */
const KNOWN_REPOS: Record<string, string> = {
  // Tools
  pykis: '~/dev/tools/pykis',
  pykiwoom: '~/dev/tools/pykiwoom',
  'pykiwoom-rest': '~/dev/tools/pykiwoom-rest',

  // Projects - add as needed
  'claude-swarm': '~/dev/claude-swarm',
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
  process: ChildProcess;
  output: string;
  startedAt: number;
  requestedBy: string;
};

const activeTasks: Map<string, DevTask> = new Map();

/**
 * Expand path (~/ handling)
 */
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

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
  const devPath = expandPath(`~/dev/${repo}`);
  if (existsSync(devPath)) {
    return devPath;
  }

  return null;
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
        error: `작업 차단: ${timeCheck.reason}\n현재: ${timeCheck.currentTime}\n${timeCheck.nextAllowedTime ? `다음 허용 시간: ${timeCheck.nextAllowedTime}` : ''}`,
      };
    }
  }

  const path = resolveRepoPath(repo);

  if (!path) {
    return { error: `저장소를 찾을 수 없습니다: ${repo}` };
  }

  // Check if a task is already running for the same repo
  const existingTask = Array.from(activeTasks.values()).find(t => t.path === path);
  if (existingTask) {
    return { error: `${repo}에 이미 실행 중인 작업이 있습니다 (id: ${existingTask.repo})` };
  }

  const taskId = `${repo}-${Date.now()}`;

  // Run Claude CLI (bypass permissions for autonomous execution)
  const claudeProcess = spawn('claude', [
    '-p', task,
    '--output-format', 'stream-json',
    '--permission-mode', 'bypassPermissions'
  ], {
    cwd: path,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const devTask: DevTask = {
    repo,
    path,
    task,
    process: claudeProcess,
    output: '',
    startedAt: Date.now(),
    requestedBy,
  };

  activeTasks.set(taskId, devTask);

  // Collect stdout
  claudeProcess.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    devTask.output += chunk;
    onProgress?.(chunk);
  });

  // Collect stderr
  claudeProcess.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    devTask.output += chunk;
  });

  // Handle completion
  claudeProcess.on('close', (code) => {
    // Extract cost from stream-json output
    const costInfo = extractCostFromStreamJson(devTask.output);
    if (costInfo) {
      console.log(`[Dev] ${repo} cost: ${formatCost(costInfo)}`);
    }

    // Extract result text from stream-json for output
    let resultText = devTask.output;
    try {
      const lines = devTask.output.split('\n').filter(Boolean);
      const resultLine = lines.find((l) => l.includes('"type":"result"'));
      if (resultLine) {
        const parsed = JSON.parse(resultLine);
        if (parsed.result) resultText = parsed.result;
      }
    } catch { /* use original */ }

    // Generate report file
    const duration = Math.floor((Date.now() - devTask.startedAt) / 1000);
    generateReport(devTask, code, duration);

    onComplete?.(resultText, code);
    activeTasks.delete(taskId);
  });

  // Handle errors
  claudeProcess.on('error', (err) => {
    devTask.output += `\nError: ${err.message}`;
    onComplete?.(devTask.output, -1);
    activeTasks.delete(taskId);
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

  task.process.kill('SIGTERM');
  activeTasks.delete(taskId);
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
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

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
  const statusText = exitCode === 0 ? '성공' : exitCode === null ? '중단됨' : `실패 (code: ${exitCode})`;

  // Report content
  const reportEntry = `
---

## ${statusEmoji} ${timeStr} 작업 리포트

| 항목 | 내용 |
|------|------|
| **요청자** | ${task.requestedBy} |
| **작업** | ${task.task.slice(0, 100)}${task.task.length > 100 ? '...' : ''} |
| **상태** | ${statusText} |
| **소요시간** | ${formatDuration(durationSec)} |

### 작업 내용

\`\`\`
${task.task}
\`\`\`

### 실행 결과

\`\`\`
${outputSummary.trim() || '(출력 없음)'}
\`\`\`

`;

  // Append if file exists, otherwise create with header
  try {
    if (existsSync(reportFile)) {
      appendFileSync(reportFile, reportEntry, 'utf-8');
    } else {
      const header = `# ${dateStr} 작업 리포트

> 이 파일은 Claude Swarm에 의해 자동 생성됩니다.
> 저장소: \`${task.path}\`

`;
      writeFileSync(reportFile, header + reportEntry, 'utf-8');
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
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return `${minutes}분 ${remainingSec}초`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}시간 ${remainingMin}분`;
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

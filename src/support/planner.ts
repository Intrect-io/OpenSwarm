// ============================================
// Claude Swarm - Planner Agent
// Decompose large issues into 30-min sub-tasks
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { t, getPrompts } from '../locale/index.js';

// ============================================
// Types
// ============================================

export interface PlannerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  projectName?: string;
  timeoutMs?: number;
  model?: string;
  targetMinutes?: number;  // Target time per sub-task (default 25 min)
  onLog?: (line: string) => void;  // Stream planner stdout to dashboard
}

export interface SubTask {
  title: string;
  description: string;
  estimatedMinutes: number;
  priority: number;  // 1-4 (1=Urgent)
  dependencies?: string[];  // Prerequisite sub-task titles
}

export interface PlannerResult {
  success: boolean;
  originalIssue: string;
  needsDecomposition: boolean;
  reason?: string;
  subTasks: SubTask[];
  totalEstimatedMinutes: number;
  error?: string;
}

// ============================================
// Prompts
// ============================================

function buildPlannerPrompt(options: PlannerOptions): string {
  return getPrompts().buildPlannerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    projectName: options.projectName || options.projectPath,
    targetMinutes: options.targetMinutes ?? 25,
  });
}

// ============================================
// Planner Execution
// ============================================

/**
 * Run Planner agent
 */
export async function runPlanner(options: PlannerOptions): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(options);
  const promptFile = `/tmp/planner-prompt-${Date.now()}.txt`;
  const cwd = expandPath(options.projectPath);

  try {
    await fs.writeFile(promptFile, prompt);

    const output = await runClaudeCli(
      promptFile,
      cwd,
      options.timeoutMs ?? 600000,  // 10 min timeout (CLI startup + analysis time)
      options.model ?? 'claude-sonnet-4-20250514',
      options.onLog
    );

    return parsePlannerOutput(output, options.taskTitle);
  } catch (error) {
    return {
      success: false,
      originalIssue: options.taskTitle,
      needsDecomposition: false,
      subTasks: [],
      totalEstimatedMinutes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await fs.unlink(promptFile);
    } catch {
      // ignore
    }
  }
}

/**
 * Run Claude CLI
 */
function runClaudeCli(
  promptFile: string,
  cwd: string,
  timeoutMs: number,
  model: string,
  onLog?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    // Use stdbuf -oL to force line-buffered stdout on the pipe
    // (Claude CLI buffers stdout when not attached to a TTY, causing no real-time output)
    const args = [
      '-c',
      `stdbuf -oL claude -p "$(cat ${promptFile})" --output-format stream-json --permission-mode bypassPermissions --model ${model} --max-turns 3`,
    ];

    const proc = spawn('/bin/sh', args, {
      cwd,
      shell: false,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';
    let lineBuffer = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      // 10 sec grace period after SIGTERM, then SIGKILL if still alive
      setTimeout(() => {
        try { proc.kill('SIGKILL'); } catch { /* already dead */ }
      }, 10000);
      reject(new Error(`Planner timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => {
      const chunk = data.toString();
      stdout += chunk;
      // Parse stream-json lines and extract human-readable text for dashboard
      if (onLog) {
        lineBuffer += chunk;
        const lines = lineBuffer.split('\n');
        lineBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line) as Record<string, unknown>;
            // Extract text from assistant streaming events
            if (event.type === 'assistant') {
              const msg = event.message as Record<string, unknown> | undefined;
              const content = msg?.content;
              if (Array.isArray(content)) {
                for (const block of content as Array<Record<string, unknown>>) {
                  if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
                    // Split long text into lines for readability
                    block.text.split('\n').filter((l: string) => l.trim()).forEach((l: string) => onLog(l));
                  }
                }
              }
            }
          } catch { /* incomplete or non-JSON line */ }
        }
      }
    });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Planner failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Parse Planner output (supports stream-json and legacy json format)
 */
function parsePlannerOutput(output: string, originalTitle: string): PlannerResult {
  try {
    // Try stream-json format: find the result line (newline-delimited JSON events)
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'result' && typeof event.result === 'string') {
          return parsePlanResult(event.result as string, originalTitle);
        }
      } catch { /* not a complete JSON line */ }
    }

    // Fallback: try legacy --output-format json (array format)
    const match = output.match(/\[[\s\S]*\]/);
    if (match) {
      const arr = JSON.parse(match[0]) as Array<Record<string, unknown>>;
      for (const item of arr) {
        if (item.type === 'result' && typeof item.result === 'string') {
          return parsePlanResult(item.result as string, originalTitle);
        }
      }
    }

    return extractFromText(output, originalTitle);
  } catch (error) {
    console.error('[Planner] Parse error:', error);
    return extractFromText(output, originalTitle);
  }
}

/**
 * Parse the planner result text (extracted from Claude output)
 */
function parsePlanResult(resultText: string, originalTitle: string): PlannerResult {
  // Extract JSON block
  const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Find JSON object directly
    const objMatch = resultText.match(/\{\s*"needsDecomposition"/);
    if (objMatch) {
      return parseDirectJson(resultText, objMatch.index!, originalTitle);
    }
    return extractFromText(resultText, originalTitle);
  }

  const parsed = JSON.parse(jsonMatch[1]) as Record<string, unknown>;
  return {
    success: true,
    originalIssue: originalTitle,
    needsDecomposition: Boolean(parsed.needsDecomposition),
    reason: parsed.reason as string | undefined,
    subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks as SubTask[] : [],
    totalEstimatedMinutes: (parsed.totalEstimatedMinutes as number) || 0,
  };
}

/**
 * Parse JSON directly
 */
function parseDirectJson(text: string, startIdx: number, originalTitle: string): PlannerResult {
  let depth = 0;
  let endIdx = startIdx;

  for (let i = startIdx; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') {
      depth--;
      if (depth === 0) {
        endIdx = i + 1;
        break;
      }
    }
  }

  try {
    const parsed = JSON.parse(text.slice(startIdx, endIdx));
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: Boolean(parsed.needsDecomposition),
      reason: parsed.reason,
      subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks : [],
      totalEstimatedMinutes: parsed.totalEstimatedMinutes || 0,
    };
  } catch {
    return extractFromText(text, originalTitle);
  }
}

/**
 * Extract from text (fallback)
 */
function extractFromText(text: string, originalTitle: string): PlannerResult {
  // Determined that decomposition is not needed
  if (text.toLowerCase().includes('no decomposition') ||
      text.includes('분해 불필요') ||
      text.includes('단일 작업')) {
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: false,
      reason: 'Planner determined no decomposition needed',
      subTasks: [],
      totalEstimatedMinutes: 30,
    };
  }

  // Parse failure - assume decomposition needed by default
  return {
    success: false,
    originalIssue: originalTitle,
    needsDecomposition: true,
    reason: 'Failed to parse planner output',
    subTasks: [],
    totalEstimatedMinutes: 0,
    error: 'Could not parse planner output',
  };
}

// ============================================
// Linear Integration
// ============================================

/**
 * Create sub-tasks as Linear sub-issues
 */
export async function createLinearSubIssues(
  parentIssueId: string,
  subTasks: SubTask[],
  _teamId: string,
  _projectId?: string
): Promise<{ success: boolean; createdIds: string[]; error?: string }> {
  // This function needs to call Linear MCP directly,
  // so autonomousRunner uses mcp__linear-server__create_issue
  // Here we only prepare data

  const createdIds: string[] = [];

  // Note: actual Linear API calls are made in autonomousRunner
  console.log(`[Planner] Prepared ${subTasks.length} sub-issues for ${parentIssueId}`);

  return { success: true, createdIds };
}

/**
 * Estimate issue duration (heuristic)
 */
export function estimateTaskDuration(task: TaskItem): number {
  const title = task.title.toLowerCase();
  const desc = (task.description || '').toLowerCase();
  const combined = `${title} ${desc}`;

  // Keyword-based estimation
  let estimate = 30; // Default 30 min

  // Complexity increasing factors
  if (combined.includes('최적화') || combined.includes('optimization')) estimate += 30;
  if (combined.includes('리팩토링') || combined.includes('refactor')) estimate += 20;
  if (combined.includes('테스트') || combined.includes('test')) estimate += 15;
  if (combined.includes('마이그레이션') || combined.includes('migration')) estimate += 40;
  if (combined.includes('전체') || combined.includes('모든') || combined.includes('all')) estimate += 30;
  if (combined.includes('ci/cd') || combined.includes('파이프라인')) estimate += 25;
  if (combined.includes('프론트엔드') && combined.includes('백엔드')) estimate += 40;
  if (combined.includes('playwright') || combined.includes('e2e')) estimate += 30;

  // Complexity decreasing factors
  if (combined.includes('버그') || combined.includes('bug') || combined.includes('fix')) estimate -= 10;
  if (combined.includes('문서') || combined.includes('docs')) estimate -= 15;
  if (combined.includes('간단') || combined.includes('simple')) estimate -= 15;

  return Math.max(10, estimate);
}

/**
 * Determine whether decomposition is needed
 */
export function needsDecomposition(task: TaskItem, maxMinutes: number = 30): boolean {
  const estimated = estimateTaskDuration(task);
  return estimated > maxMinutes;
}

// ============================================
// Utilities
// ============================================

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return p.replace('~', homedir());
  }
  return p;
}

// ============================================
// Formatting
// ============================================

/**
 * Format Planner result as a Discord message
 */
export function formatPlannerResult(result: PlannerResult): string {
  const lines: string[] = [];

  if (!result.success) {
    lines.push(`❌ ${t('agents.planner.report.analysisFailed')}`);
    lines.push(`${t('agents.planner.report.reason', { text: result.error || 'Unknown error' })}`);
    return lines.join('\n');
  }

  if (!result.needsDecomposition) {
    lines.push(`✅ ${t('agents.planner.report.noDecomposition')}`);
    lines.push(t('agents.planner.report.reason', { text: result.reason || '' }));
    lines.push(t('agents.planner.report.estimatedTime', { n: result.totalEstimatedMinutes }));
    return lines.join('\n');
  }

  lines.push(`📋 ${t('agents.planner.report.decompositionDone')}`);
  lines.push(t('agents.planner.report.original', { text: result.originalIssue }));
  lines.push(t('agents.planner.report.reason', { text: result.reason || '' }));
  lines.push('');
  lines.push(t('agents.planner.report.subTasksHeader', { count: result.subTasks.length, totalMinutes: result.totalEstimatedMinutes }));

  for (let i = 0; i < result.subTasks.length; i++) {
    const st = result.subTasks[i];
    const deps = st.dependencies?.length ? t('agents.planner.report.dependency', { deps: st.dependencies.join(', ') }) : '';
    lines.push(`${i + 1}. ${st.title} (~${st.estimatedMinutes}min)${deps}`);
  }

  return lines.join('\n');
}

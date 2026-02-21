// ============================================
// Claude Swarm - Planner Agent
// Decompose large issues into 30-min sub-tasks
// ============================================

import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { type CostInfo, extractCostFromStreamJson, formatCost } from './costTracker.js';
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
  costInfo?: CostInfo;
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

  try {
    const output = await runClaudeCli(
      prompt,
      options.timeoutMs ?? 120000,  // 2 min timeout
      options.onLog
    );

    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[Planner] Cost: ${formatCost(costInfo)}`);
    }

    const result = parsePlannerOutput(output, options.taskTitle);
    result.costInfo = costInfo;
    return result;
  } catch (error) {
    return {
      success: false,
      originalIssue: options.taskTitle,
      needsDecomposition: false,
      subTasks: [],
      totalEstimatedMinutes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Run Claude CLI from /tmp to avoid project-specific MCP servers and hooks.
 * STONKS has session-start.sh + playwright/pykis/linear MCP servers that
 * cause >10min startup when claude runs from the project directory.
 */
async function runClaudeCli(
  prompt: string,
  timeoutMs: number,
  onLog?: (line: string) => void
): Promise<string> {
  const tmpFile = `/tmp/planner-prompt-${Date.now()}.txt`;
  writeFileSync(tmpFile, prompt);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(
      'claude',
      ['--output-format', 'stream-json', '--max-turns', '1', '-p', prompt],
      {
        shell: false,
        cwd: '/tmp',   // Neutral dir — no project .claude/ settings loaded
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let output = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      if (onLog) {
        // Stream assistant text lines to dashboard
        for (const line of text.split('\n').filter((l: string) => l.trim())) {
          try {
            const event = JSON.parse(line);
            if (event.type === 'assistant' && event.message?.content) {
              for (const block of event.message.content) {
                if (block.type === 'text') onLog(block.text);
              }
            }
          } catch {
            // Not a JSON line, pass through
            onLog(line);
          }
        }
      }
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Planner timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      if (code === 0 || output.trim()) {
        resolve(output);
      } else {
        reject(new Error(`Claude CLI exited with code ${code}`));
      }
    });

    proc.on('error', (err: Error) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch { /* ignore */ }
      reject(err);
    });
  });
}

/**
 * Parse Planner output (plain text or stream-json fallback)
 */
function parsePlannerOutput(output: string, originalTitle: string): PlannerResult {
  try {
    // Primary: plain text output — find ```json block directly
    const jsonBlockMatch = output.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonBlockMatch) {
      try {
        const parsed = JSON.parse(jsonBlockMatch[1]) as Record<string, unknown>;
        if ('needsDecomposition' in parsed) {
          console.log('[Planner] Parsed JSON block from plain text output');
          return {
            success: true,
            originalIssue: originalTitle,
            needsDecomposition: Boolean(parsed.needsDecomposition),
            reason: parsed.reason as string | undefined,
            subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks as SubTask[] : [],
            totalEstimatedMinutes: (parsed.totalEstimatedMinutes as number) || 0,
          };
        }
      } catch { /* not valid JSON, try other methods */ }
    }

    // Fallback: stream-json format (newline-delimited JSON events)
    const lines = output.split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        if (event.type === 'result' && typeof event.result === 'string') {
          return parsePlanResult(event.result as string, originalTitle);
        }
      } catch { /* not a complete JSON line */ }
    }

    // Fallback: direct JSON object in text
    const objMatch = output.match(/\{\s*"needsDecomposition"/);
    if (objMatch) {
      return parseDirectJson(output, objMatch.index!, originalTitle);
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

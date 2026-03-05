// ============================================
// OpenSwarm - Planner Agent
// Decompose large issues into 30-min sub-tasks
// ============================================

import { spawn } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
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
      options.model,
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
 * Convert planner JSON output to human-readable log line.
 * Handles both the final JSON result and intermediate text.
 */
function humanizePlannerOutput(text: string): string {
  const trimmed = text.trim();

  // Try to parse as planner result JSON
  try {
    const obj = JSON.parse(trimmed);
    if (typeof obj === 'object' && obj !== null && 'needsDecomposition' in obj) {
      if (!obj.needsDecomposition) {
        const reason = obj.reason ? `: ${obj.reason.slice(0, 120)}` : '';
        return `✓ No decomposition needed (est. ${obj.totalEstimatedMinutes || '?'}min)${reason}`;
      }
      const tasks = (obj.subTasks || []) as Array<{ title?: string; estimatedMinutes?: number }>;
      const taskList = tasks.map((t, i) => `  ${i + 1}. ${t.title || '?'} (~${t.estimatedMinutes || '?'}min)`).join('\n');
      return `🔀 Decomposed into ${tasks.length} sub-tasks (total ${obj.totalEstimatedMinutes || '?'}min)\n${taskList}`;
    }
  } catch {
    // Not JSON — return as-is
  }

  // Strip markdown code fences
  if (trimmed.startsWith('```')) return '';

  return trimmed;
}

/**
 * Run Claude CLI from /tmp to avoid project-specific MCP servers and hooks.
 * STONKS has session-start.sh + playwright/pykis/linear MCP servers that
 * cause >10min startup when claude runs from the project directory.
 */
async function runClaudeCli(
  prompt: string,
  timeoutMs: number,
  model?: string,
  onLog?: (line: string) => void
): Promise<string> {
  const tmpFile = `/tmp/planner-prompt-${Date.now()}.txt`;
  writeFileSync(tmpFile, prompt);

  const args = ['--output-format', 'stream-json', '--max-turns', '1', '--disable-hooks'];
  if (model) {
    args.push('--model', model);
  }
  args.push('-p', prompt);

  return new Promise<string>((resolve, reject) => {
    const proc = spawn(
      'claude',
      args,
      {
        shell: false,
        cwd: '/tmp',   // Neutral dir — no project .claude/ settings loaded
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );

    let output = '';
    let stderrOutput = '';

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
                if (block.type === 'text') {
                  // Convert planner JSON result to human-readable summary
                  const humanized = humanizePlannerOutput(block.text);
                  onLog(humanized);
                }
              }
            }
          } catch {
            // Not a JSON line — skip raw stream noise (tool calls, etc)
            if (!line.startsWith('{') && !line.startsWith('[')) {
              onLog(line);
            }
          }
        }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
      // Log stderr in real-time for debugging
      console.error('[Planner stderr]', text.slice(0, 500));
    });

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Planner timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code: number | null) => {
      clearTimeout(timer);
      try { unlinkSync(tmpFile); } catch { /* ignore */ }

      // Success: exit code 0, or non-zero but we got parseable output
      if (code === 0) {
        resolve(output);
        return;
      }

      // Non-zero exit: check if we got usable output anyway
      if (output.trim()) {
        console.warn(`[Planner] Non-zero exit (${code}) but got output, attempting to parse`);
        if (stderrOutput.trim()) {
          console.warn('[Planner] stderr:', stderrOutput.slice(0, 500));
        }
        resolve(output);
        return;
      }

      // Complete failure: no output and non-zero exit
      const errorMsg = stderrOutput.trim() || 'No error output captured';
      const truncatedStderr = errorMsg.length > 1000 ? errorMsg.slice(0, 1000) + '... (truncated)' : errorMsg;
      console.error('[Planner] Process exited with code', code);
      console.error('[Planner] Full stderr:', errorMsg);
      console.error('[Planner] stdout length:', output.length);
      reject(new Error(`Claude CLI exited with code ${code}. stderr: ${truncatedStderr}`));
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
      text.includes('no decomposition needed') ||
      text.includes('single task')) {
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: false,
      reason: 'Planner determined no decomposition needed',
      subTasks: [],
      totalEstimatedMinutes: 30,
    };
  }

  // Parse failure - log raw output for debugging
  console.error('[Planner] Parse failed - raw output (first 1000 chars):');
  console.error(text.slice(0, 1000));

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
  if (combined.includes('optimization') || combined.includes('optimize')) estimate += 30;
  if (combined.includes('refactor') || combined.includes('refactoring')) estimate += 20;
  if (combined.includes('test') || combined.includes('testing')) estimate += 15;
  if (combined.includes('migration') || combined.includes('migrate')) estimate += 40;
  if (combined.includes('all') || combined.includes('entire') || combined.includes('every')) estimate += 30;
  if (combined.includes('ci/cd') || combined.includes('pipeline')) estimate += 25;
  if (combined.includes('frontend') && combined.includes('backend')) estimate += 40;
  if (combined.includes('playwright') || combined.includes('e2e')) estimate += 30;

  // Complexity decreasing factors
  if (combined.includes('bug') || combined.includes('fix') || combined.includes('bugfix')) estimate -= 10;
  if (combined.includes('docs') || combined.includes('documentation')) estimate -= 15;
  if (combined.includes('simple') || combined.includes('trivial')) estimate -= 15;

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

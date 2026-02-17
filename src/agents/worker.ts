// ============================================
// Claude Swarm - Worker Agent
// Task execution agent (Claude CLI based)
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';
import * as gitTracker from '../support/gitTracker.js';
import { t, getPrompts } from '../locale/index.js';

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
  model?: string;              // Claude model (default: claude-sonnet-4-20250514)
  issueIdentifier?: string;    // Linear issue ID (e.g., INT-123)
  projectName?: string;        // Linear project name
  onLog?: (line: string) => void;  // Callback for stdout streaming
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
  const promptFile = `/tmp/worker-prompt-${Date.now()}.txt`;
  const cwd = expandPath(options.projectPath);

  // Git snapshot (pre-work state)
  let snapshotHash = '';
  const isGitRepo = await gitTracker.isGitRepo(cwd);
  if (isGitRepo) {
    snapshotHash = await gitTracker.takeSnapshot(cwd);
    console.log(`[Worker] Git snapshot: ${snapshotHash.slice(0, 8)}`);
  }

  try {
    // Save prompt
    await fs.writeFile(promptFile, prompt);

    // Run Claude CLI
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model, options.onLog);

    // Parse result (from LLM output)
    const parsedResult = parseWorkerOutput(output);

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
  } finally {
    // Clean up temp files
    try {
      await fs.unlink(promptFile);
    } catch {
      // Ignore
    }
  }
}

/**
 * Run Claude CLI
 */
async function runClaudeCli(
  promptFile: string,
  cwd: string,
  timeoutMs: number = 300000, // 5 min default
  model?: string,
  onLog?: (line: string) => void
): Promise<string> {
  return new Promise((resolve, reject) => {
    const modelFlag = model ? ` --model ${model}` : '';
    const cmd = `echo "" | claude -p "$(cat ${promptFile})" --output-format json --permission-mode bypassPermissions${modelFlag}`;

    const proc = spawn(cmd, {
      shell: true,
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      stdout += text;
      if (onLog) {
        text.split('\n').filter(l => l.trim()).forEach(l => onLog(l));
      }
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Timeout setup (unlimited if <= 0)
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Worker timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.error('[Worker] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }

      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Worker spawn error: ${err.message}`));
    });
  });
}

/**
 * Parse Worker output
 */
function parseWorkerOutput(output: string): WorkerResult {
  try {
    // Extract result from Claude JSON array
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) {
      return extractFromText(output);
    }

    const arr = JSON.parse(match[0]);
    let resultText = '';

    for (const item of arr) {
      if (item.type === 'result' && item.result) {
        resultText = item.result;
        break;
      }
    }

    if (!resultText) {
      return extractFromText(output);
    }

    // Extract JSON block from result
    return extractResultJson(resultText) || extractFromText(resultText);
  } catch (error) {
    console.error('[Worker] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * Extract JSON block from result
 */
function extractResultJson(text: string): WorkerResult | null {
  // Find ```json ... ``` block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Find plain JSON object
    const objMatch = text.match(/\{\s*"success"\s*:/);
    if (!objMatch) return null;

    const startIdx = objMatch.index!;
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
        success: Boolean(parsed.success),
        summary: parsed.summary || t('common.fallback.noSummary'),
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        output: text,
        error: parsed.error,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || '(요약 없음)',
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
    };
  } catch {
    return null;
  }
}

/**
 * Extract result from text (fallback when JSON parsing fails)
 */
function extractFromText(text: string): WorkerResult {
  // Estimate success/failure
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  // Extract file changes
  const filePatterns = [
    /(?:changed?|modified?|created?|updated?):\s*(.+\.(?:ts|js|py|json|yaml|yml|md))/gi,
    /(?:src|lib|test|tests)\/[\w/\-.]+\.(?:ts|js|py)/gi,
  ];

  const filesChanged: string[] = [];
  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!filesChanged.includes(file)) {
        filesChanged.push(file);
      }
    }
  }

  // Extract commands
  const cmdPattern = /(?:`|\$)\s*((?:npm|pnpm|yarn|git|python|pytest|tsc|eslint)\s+[^\n`]+)/gi;
  const commands: string[] = [];
  const cmdMatches = text.matchAll(cmdPattern);
  for (const m of cmdMatches) {
    if (!commands.includes(m[1])) {
      commands.push(m[1].trim());
    }
  }

  return {
    success: !hasError || hasSuccess,
    summary: extractSummary(text),
    filesChanged: filesChanged.slice(0, 10),
    commands: commands.slice(0, 10),
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

/**
 * Extract summary from text
 */
function extractSummary(text: string): string {
  // Extract first meaningful sentence
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return t('common.fallback.noSummary');

  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
}

/**
 * Extract error message
 */
function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) {
    return errorMatch[1].slice(0, 200);
  }

  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) {
    return lines[0].slice(0, 200);
  }

  return 'Unknown error';
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

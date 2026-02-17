// ============================================
// Claude Swarm - Reviewer Agent
// Code review agent (Claude CLI based)
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult, ReviewResult, ReviewDecision } from './agentPair.js';
import { t, getPrompts } from './locale/index.js';

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

export interface ReviewerOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;              // Claude model (default: claude-sonnet-4-20250514)
}

// ============================================
// Prompts
// ============================================

/**
 * Build Reviewer prompt using locale templates
 */
function buildReviewerPrompt(options: ReviewerOptions): string {
  const files = options.workerResult.filesChanged;
  const filesSummary = files.length <= 20
    ? (files.join(', ') || '(none)')
    : `${files.slice(0, 20).join(', ')} (+${files.length - 20} more)`;

  const cmds = options.workerResult.commands;
  const cmdsSummary = cmds.length <= 10
    ? (cmds.join(', ') || '(none)')
    : `${cmds.slice(0, 10).join(', ')} (+${cmds.length - 10} more)`;

  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed (${files.length}):** ${filesSummary}
- **Commands:** ${cmdsSummary}
${options.workerResult.error ? `- **Error:** ${options.workerResult.error}` : ''}

### Worker Output (excerpt)
\`\`\`
${options.workerResult.output.slice(0, 2000)}${options.workerResult.output.length > 2000 ? '\n...(truncated)' : ''}
\`\`\`
`;

  return getPrompts().buildReviewerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    workerReport,
  });
}

// ============================================
// Reviewer Execution
// ============================================

/**
 * Run Reviewer agent
 */
export async function runReviewer(options: ReviewerOptions): Promise<ReviewResult> {
  const prompt = buildReviewerPrompt(options);
  const promptFile = `/tmp/reviewer-prompt-${Date.now()}.txt`;

  try {
    // Save prompt
    await fs.writeFile(promptFile, prompt);

    // Run Claude CLI
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);

    // Parse result
    return parseReviewerOutput(output);
  } catch (error) {
    return {
      decision: 'reject',
      feedback: `Reviewer execution failed: ${error instanceof Error ? error.message : String(error)}`,
      issues: ['Error occurred during reviewer agent execution'],
      suggestions: ['Manual review required'],
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
  timeoutMs: number = 180000, // 3 min default (review is faster than work)
  model?: string
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

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Timeout setup (unlimited if <= 0)
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Reviewer timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.error('[Reviewer] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }

      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Reviewer spawn error: ${err.message}`));
    });
  });
}

/**
 * Parse Reviewer output
 */
function parseReviewerOutput(output: string): ReviewResult {
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
    console.error('[Reviewer] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * Extract JSON block from result
 */
function extractResultJson(text: string): ReviewResult | null {
  // Find ```json ... ``` block
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // Find plain JSON object
    const objMatch = text.match(/\{\s*"decision"\s*:/);
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
      return normalizeReviewResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeReviewResult(parsed);
  } catch {
    return null;
  }
}

/**
 * Normalize parsed result
 */
function normalizeReviewResult(parsed: any): ReviewResult {
  // Validate decision
  let decision: ReviewDecision = 'revise';
  if (['approve', 'revise', 'reject'].includes(parsed.decision)) {
    decision = parsed.decision as ReviewDecision;
  } else if (parsed.decision) {
    // Map similar strings
    const normalized = parsed.decision.toLowerCase();
    if (normalized.includes('approv') || normalized.includes('pass')) {
      decision = 'approve';
    } else if (normalized.includes('reject') || normalized.includes('fail')) {
      decision = 'reject';
    }
  }

  return {
    decision,
    feedback: parsed.feedback || t('common.fallback.noFeedback'),
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  };
}

/**
 * Extract result from text (fallback when JSON parsing fails)
 */
function extractFromText(text: string): ReviewResult {
  // Estimate decision
  let decision: ReviewDecision = 'revise';
  const lowerText = text.toLowerCase();

  if (lowerText.includes('approve') || lowerText.includes('승인') || lowerText.includes('lgtm')) {
    decision = 'approve';
  } else if (lowerText.includes('reject') || lowerText.includes('거부') || lowerText.includes('불가')) {
    decision = 'reject';
  } else if (lowerText.includes('revise') || lowerText.includes('수정') || lowerText.includes('개선')) {
    decision = 'revise';
  }

  // Extract issues
  const issues: string[] = [];
  const issuePatterns = [
    /(?:issue|problem|문제|오류):\s*(.+)/gi,
    /(?:missing|누락):\s*(.+)/gi,
    /- (?:fix|수정|해결):\s*(.+)/gi,
  ];

  for (const pattern of issuePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !issues.includes(m[1].trim())) {
        issues.push(m[1].trim().slice(0, 200));
      }
    }
  }

  // Extract suggestions
  const suggestions: string[] = [];
  const suggestionPatterns = [
    /(?:suggest|recommend|제안|추천):\s*(.+)/gi,
    /(?:consider|고려):\s*(.+)/gi,
    /(?:should|해야):\s*(.+)/gi,
  ];

  for (const pattern of suggestionPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !suggestions.includes(m[1].trim())) {
        suggestions.push(m[1].trim().slice(0, 200));
      }
    }
  }

  return {
    decision,
    feedback: extractFeedback(text),
    issues: issues.slice(0, 5),
    suggestions: suggestions.slice(0, 5),
  };
}

/**
 * Extract feedback
 */
function extractFeedback(text: string): string {
  // Extract first meaningful sentence
  const lines = text.split('\n').filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 20 && !trimmed.startsWith('#') && !trimmed.startsWith('```');
  });

  if (lines.length === 0) return t('common.fallback.noFeedback');

  const feedback = lines[0].trim();
  return feedback.length > 300 ? feedback.slice(0, 300) + '...' : feedback;
}

// ============================================
// Formatting
// ============================================

/**
 * Format Reviewer result as a Discord message
 */
export function formatReviewFeedback(result: ReviewResult): string {
  const decisionEmoji = {
    approve: '✅',
    revise: '🔄',
    reject: '❌',
  }[result.decision];

  const decisionText = {
    approve: 'APPROVED',
    revise: 'REVISION NEEDED',
    reject: 'REJECTED',
  }[result.decision];

  const lines: string[] = [];

  lines.push(`${decisionEmoji} ${t('agents.reviewer.report.decision', { text: decisionText })}`);
  lines.push('');
  lines.push(t('agents.reviewer.report.feedback', { text: result.feedback }));

  if (result.issues && result.issues.length > 0) {
    lines.push('');
    lines.push(t('agents.reviewer.report.issues'));
    for (const issue of result.issues.slice(0, 5)) {
      lines.push(`  • ${issue}`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push(t('agents.reviewer.report.suggestions'));
    for (const suggestion of result.suggestions.slice(0, 5)) {
      lines.push(`  • ${suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Convert Reviewer feedback into revision instructions for Worker
 */
export function buildRevisionPrompt(result: ReviewResult): string {
  return getPrompts().buildRevisionPromptFromReview({
    decision: result.decision,
    feedback: result.feedback,
    issues: result.issues || [],
    suggestions: result.suggestions || [],
  });
}

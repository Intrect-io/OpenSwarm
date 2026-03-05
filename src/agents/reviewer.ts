// ============================================
// OpenSwarm - Reviewer Agent
// Code review agent (CLI adapter based)
// ============================================

import { homedir } from 'node:os';
import type { WorkerResult, ReviewResult } from './agentPair.js';
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

export interface ReviewerOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;              // Claude model (default: claude-sonnet-4-5-20250929)
  processContext?: ProcessContext;
}

export interface PreCheckResult {
  passed: boolean;
  issues: string[];
  confidence: number; // 0-3: quality of the check
}

// ============================================
// Prompts
// ============================================

/**
 * Build Pre-Check prompt for fast validation (Haiku)
 */
function buildPreCheckPrompt(options: ReviewerOptions): string {
  const files = options.workerResult.filesChanged;
  const filesSummary = files.length <= 20
    ? (files.join(', ') || '(none)')
    : `${files.slice(0, 20).join(', ')} (+${files.length - 20} more)`;

  return `You are a fast pre-check validator. Perform a quick validation of the Worker's output.

## Task
${options.taskTitle}

## Worker Result
- Success: ${options.workerResult.success}
- Files Changed (${files.length}): ${filesSummary}
- Summary: ${options.workerResult.summary}

## Your Job (Fast Check Only)
Check for OBVIOUS problems:
1. **Syntax Errors**: Are there any clear syntax errors in the output?
2. **Missing Files**: Did the worker claim to create/modify files that don't exist?
3. **Incomplete Output**: Does the output look cut off or incomplete?
4. **Basic Format Issues**: Are there obvious formatting problems?

**DO NOT** perform deep logical review - that's for the next stage.

## Response Format
Respond in this EXACT format:

PASSED: [yes/no]
CONFIDENCE: [0-3]
ISSUES:
- [issue 1]
- [issue 2]
...

Keep it brief. This is a fast filter, not a deep review.`;
}

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
// Pre-Check Execution (Fast Validation with Haiku)
// ============================================

/**
 * Run fast pre-check validation with Haiku model
 * This is a cheap filter before expensive Sonnet review
 * Expected to catch 30-40% of obvious issues, saving ~35% on review costs
 */
export async function runPreCheck(options: ReviewerOptions): Promise<PreCheckResult> {
  const prompt = buildPreCheckPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter();

  try {
    // Use Haiku for fast validation
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: 30000, // 30 seconds max for pre-check
      model: 'claude-haiku-4-5-20251001', // Fast model
      processContext: options.processContext,
    });

    // DEBUG: Log raw Haiku output for troubleshooting
    console.log('[Reviewer] Pre-check raw output (first 500 chars):', raw.stdout.slice(0, 500));

    // Parse pre-check output
    const lines = raw.stdout.split('\n');
    const passedLine = lines.find((l: string) => l.startsWith('PASSED:'));
    const confidenceLine = lines.find((l: string) => l.startsWith('CONFIDENCE:'));

    const passed = passedLine?.includes('yes') ?? false;
    const confidence = parseInt(confidenceLine?.split(':')[1]?.trim() || '1', 10);

    const issueStart = lines.findIndex((l: string) => l.startsWith('ISSUES:'));
    const issues = issueStart >= 0
      ? lines.slice(issueStart + 1)
          .filter((l: string) => l.trim().startsWith('-'))
          .map((l: string) => l.replace(/^-\s*/, '').trim())
          .filter(Boolean)
      : [];

    // DEBUG: Log parsing results
    if (!passed && issues.length === 0) {
      console.warn('[Reviewer] Pre-check failed but no issues found. Haiku may not be following format.');
      console.warn('[Reviewer] PASSED line:', passedLine || '(not found)');
      console.warn('[Reviewer] ISSUES section:', issueStart >= 0 ? 'found' : 'not found');

      // Provide better default error message
      if (!passedLine) {
        issues.push('Haiku did not provide PASSED: line in expected format');
      }
      if (issueStart < 0) {
        issues.push('Haiku did not provide ISSUES: section in expected format');
      }
    }

    return {
      passed,
      issues: issues.length > 0 ? issues : ['Pre-check failed with no specific issues (format parsing error)'],
      confidence: Math.min(3, Math.max(0, confidence)),
    };
  } catch (error) {
    // If pre-check fails, allow proceeding to full review
    console.warn('[Reviewer] Pre-check failed, proceeding to full review:', error);
    return {
      passed: true, // Don't block on pre-check failure
      issues: ['Pre-check timed out or failed'],
      confidence: 0,
    };
  }
}

// ============================================
// Reviewer Execution
// ============================================

/**
 * Run Reviewer agent (full review with Sonnet)
 */
export async function runReviewer(options: ReviewerOptions): Promise<ReviewResult> {
  const prompt = buildReviewerPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter();

  try {
    // Run CLI via adapter
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs ?? 180000, // 3 min default (review is faster)
      model: options.model,
      processContext: options.processContext,
    });

    // Parse result via adapter
    return adapter.parseReviewerOutput(raw);
  } catch (error) {
    return {
      decision: 'reject',
      feedback: `Reviewer execution failed: ${error instanceof Error ? error.message : String(error)}`,
      issues: ['Error occurred during reviewer agent execution'],
      suggestions: ['Manual review required'],
    };
  }
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

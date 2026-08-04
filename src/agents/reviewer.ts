// ============================================
// OpenSwarm - Reviewer Agent
// Code review agent (CLI adapter based)
// ============================================

import type { WorkerResult, ReviewResult } from './agentPair.js';
import { t, getPrompts } from '../locale/index.js';
import type { AdapterName, ProcessContext } from '../adapters/types.js';
import type { ToolDefinition } from '../adapters/tools.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';
import type { VerifyEvidence } from '../verify/runner.js';
import { renderVerifyEvidence } from './verificationEvidence.js';

// Types

export interface ReviewerOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;              // Model ID (default: adapter default)
  maxTurns?: number;           // Max agentic turns per CLI invocation
  adapterName?: AdapterName;
  processContext?: ProcessContext;
  /** Reasoning effort from a jobProfile (codex-responses: low|medium|high). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Execution-grounded definition of done to hard-gate on (INT-1914). */
  completionCriteria?: string[];
  /**
   * Non-blocking deterministic guard warnings (dead-module, reformat/scope, …)
   * surfaced to the reviewer so it verifies each instead of them dying in a log
   * line. (INT-2388)
   */
  guardWarnings?: string[];
  /** Deterministic command evidence produced by the harness tester. */
  verificationEvidence?: VerifyEvidence[];
  /** Relevant repository-local logs from earlier review commands. */
  priorReviewContext?: string;
  /**
   * 'change' (default): review a worker's diff. 'audit': evaluate existing files
   * with no diff/worker (the `review --max` codebase audit). (INT-2006)
   */
  mode?: 'change' | 'audit' | 'direct';
  /** MCP tools to expose (e.g. linear__*). When unset the adapter self-sources (INT-1951). (INT-1950) */
  mcpTools?: ToolDefinition[];
  /** Tool-activity log lines (🔧 read_file …) for live progress display. (INT-1963) */
  onLog?: (line: string) => void;
  /** Streamed reasoning/text deltas for live progress display. (INT-1963) */
  onToken?: (delta: string) => void;
  /** Abort the run + in-flight adapter call (pipeline cancel / project disable). */
  signal?: AbortSignal;
  /**
   * Deny the reviewer every mutating tool — write_file, edit_file, apply_patch
   * and bash — leaving read_file/search_files/search_memory.
   *
   * Mandatory whenever the diff under review is not trusted. Reviewing a pull
   * request in CI puts an agent with shell access on attacker-controlled files
   * while the provider credential sits in the environment, which turns prompt
   * injection into command execution. A review is a judgement, not an
   * execution, so nothing legitimate is lost.
   *
   * Off by default: the local `openswarm review` path reviews the operator's own
   * working tree, and running commands there is how the reviewer substantiates a
   * claim. (INT-3189)
   */
  readOnly?: boolean;
  /**
   * The change under review, as text. Supplied rather than discovered: a
   * read-only reviewer cannot shell out for it, and in committed-diff mode
   * there is nothing in the working tree to read. (INT-3101)
   */
  diff?: string;
}

export interface PreCheckResult {
  passed: boolean;
  issues: string[];
  confidence: number; // 0-3: quality of the check
}

// Prompts

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
export function buildReviewerPrompt(options: ReviewerOptions): string {
  const files = options.workerResult.filesChanged;
  const filesSummary = files.length <= 20
    ? (files.join(', ') || '(none)')
    : `${files.slice(0, 20).join(', ')} (+${files.length - 20} more)`;

  // Audit mode: no diff/commands to report — just hand the auditor the file list. (INT-2006)
  if (options.mode === 'audit') {
    return getPrompts().buildReviewerPrompt({
      taskTitle: options.taskTitle,
      taskDescription: options.taskDescription,
      workerReport: `- **Files under audit (${files.length}):** ${filesSummary}`,
      mode: 'audit',
      priorReviewContext: options.priorReviewContext,
    });
  }

  // Direct mode reviews a Git diff supplied by a user/CI checkout, not an
  // OpenSwarm worker result. Do not manufacture a zero-command worker report:
  // "evidence not collected here" is different from "validation was not run".
  if (options.mode === 'direct') {
    // The diff goes in the prompt, not left for the agent to reconstruct. A
    // read-only reviewer has no bash, and in committed-diff mode the working
    // tree is clean — reading a file shows the result, never the change. Under
    // `--read-only --base`, which is what the CI gate uses, the reviewer could
    // not see its own subject and said so while still returning a verdict.
    // (INT-3101)
    // Appended as plain text on purpose: the template already wraps the whole
    // report in its untrusted-data block, which escapes the closing marker and
    // code fences. A second fence here would be escaped by that one, so it
    // would add noise while providing none of the protection it appears to.
    const report = options.diff
      ? `- **Files changed (${files.length}):** ${filesSummary}\n- **Diff under review:**\n${options.diff}`
      : `- **Files changed (${files.length}):** ${filesSummary}`;
    return getPrompts().buildReviewerPrompt({
      taskTitle: options.taskTitle,
      taskDescription: options.taskDescription,
      workerReport: report,
      mode: 'direct',
      priorReviewContext: options.priorReviewContext,
    });
  }

  const cmds = options.workerResult.commands;
  const cmdsSummary = cmds.length <= 10
    ? (cmds.join(', ') || '(none)')
    : `${cmds.slice(0, 10).join(', ')} (+${cmds.length - 10} more)`;

  const guardSection = options.guardWarnings && options.guardWarnings.length > 0
    ? `- **Automated guard warnings (deterministic pre-checks — verify each, don't dismiss):**\n${options.guardWarnings.map(w => `  - ${w}`).join('\n')}\n`
    : '';

  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed (${files.length}):** ${filesSummary}
- **Commands:** ${cmdsSummary}
${options.workerResult.error ? `- **Error:** ${options.workerResult.error}` : ''}
${guardSection}`;

  return getPrompts().buildReviewerPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    workerReport,
    completionCriteria: options.completionCriteria,
    verificationEvidence: renderVerifyEvidence(options.verificationEvidence ?? []),
    priorReviewContext: options.priorReviewContext,
  });
}

// Pre-Check Execution (Fast Validation with Haiku)

/**
 * Run fast pre-check validation with Haiku model
 * This is a cheap filter before expensive Sonnet review
 * Expected to catch 30-40% of obvious issues, saving ~35% on review costs
 */
export async function runPreCheck(options: ReviewerOptions): Promise<PreCheckResult> {
  const prompt = buildPreCheckPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter(options.adapterName);

  try {
    // Use Haiku for fast validation
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: 30000, // 30 seconds max for pre-check
      model: options.model,
      maxTurns: options.maxTurns,
      processContext: options.processContext,
      onLog: options.onLog,
      signal: options.signal,
      readOnly: options.readOnly,
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
    // Rate limit errors must propagate so the scheduler can pause — pre-check
    // failure otherwise just passes through to the full review.
    if (error instanceof RateLimitError) throw error;
    // If pre-check fails, allow proceeding to full review
    console.warn('[Reviewer] Pre-check failed, proceeding to full review:', error);
    return {
      passed: true, // Don't block on pre-check failure
      issues: ['Pre-check timed out or failed'],
      confidence: 0,
    };
  }
}

// Reviewer Execution

/**
 * Run Reviewer agent (full review with Sonnet)
 */
export async function runReviewer(options: ReviewerOptions): Promise<ReviewResult> {
  const prompt = buildReviewerPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter(options.adapterName);

  try {
    // Run CLI via adapter
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs ?? 300000, // 5 min default
      model: options.model,
      maxTurns: options.maxTurns,
      processContext: options.processContext,
      systemPrompt: getPrompts().systemPrompt,
      reasoningEffort: options.reasoningEffort,
      mcpTools: options.mcpTools,
      onLog: options.onLog,
      onToken: options.onToken,
      signal: options.signal,
      readOnly: options.readOnly,
    });

    // Parse result via adapter
    const parsedResult = adapter.parseReviewerOutput(raw);
    // Backfill loop-measured usage for adapters that don't extract their own. (INT-2508)
    if (raw.costInfo && !parsedResult.costInfo) {
      parsedResult.costInfo = raw.costInfo;
    }
    return parsedResult;
  } catch (error) {
    // Rate limit errors must propagate so the scheduler can pause.
    if (error instanceof RateLimitError) throw error;
    // An infra failure (CLI exit, auth, spawn, timeout) means the REVIEWER never
    // ran — it is NOT a quality verdict. Propagate so the pipeline classifies it
    // as 'infra_error' instead of letting it masquerade as a 'reject' that
    // increments the rejection-limit STUCK counter. (INT-2010)
    if (isInfraError(error)) throw error;
    // Whatever is left ran the reviewer but produced NO usable verdict — most often
    // adapter.parseReviewerOutput throwing on malformed output. This is NOT a quality
    // 'reject' (a 'reject' discards the worker's work AND counts toward the
    // rejection→STUCK limit, turning a reviewer-side parse bug into a false STUCK),
    // and NOT a 'revise' (which the CLI reads as an exit-0 success and which spends
    // the worker's revision budget on a reviewer-side problem). Throw an infra-marked
    // error → the pipeline classifies infra_error (backoff retry, no STUCK) and the
    // CLI exits non-zero. (INT-2521)
    const msg = error instanceof Error ? error.message : String(error);
    throw new Error(`reviewer-stage: produced no parseable verdict: ${msg}`, { cause: error });
  }
}

// Formatting

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

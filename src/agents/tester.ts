// ============================================
// OpenSwarm - Tester Agent
// Test execution agent (CLI adapter based)
// ============================================

import type { WorkerResult } from './agentPair.js';
import type { AdapterName } from '../adapters/types.js';
import { getAdapter, spawnCli } from '../adapters/index.js';
import { type CostInfo, extractCostFromStreamJson, formatCost } from '../support/costTracker.js';
import { expandPath } from '../core/config.js';
import { RateLimitError } from '../adapters/rateLimitError.js';
import { isInfraError } from '../adapters/errorClassification.js';
import type { VerifyEvidence } from '../verify/runner.js';
import {
  PROMPT_FEEDBACK_LIMIT,
  PROMPT_FAILED_TESTS_LIMIT,
  PROMPT_SUGGESTIONS_LIMIT,
  truncate,
} from '../support/outputBudget.js';

// Types

export interface TesterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
  maxTurns?: number;
  adapterName?: AdapterName;
}

export interface TesterResult {
  success: boolean;
  testsPassed: number;
  testsFailed: number;
  coverage?: number;
  output: string;
  failedTests?: string[];
  suggestions?: string[];
  error?: string;
  costInfo?: CostInfo;
  /** True when produced by the deterministic verify runner instead of an LLM. */
  deterministic?: boolean;
  verificationEvidence?: VerifyEvidence[];
}

// Prompts

/**
 * Build Tester prompt
 */
function buildTesterPrompt(options: TesterOptions): string {
  const prompts = getPrompts();
  return prompts.buildTesterPrompt({
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    workerResult: options.workerResult,
  });
}

// Execution

export async function runTester(options: TesterOptions): Promise<TesterResult> {
  const prompt = buildTesterPrompt(options);
  const adapter = getAdapter(options.adapterName || 'cli');
  const result = await spawnCli(adapter, prompt, {
    timeoutMs: options.timeoutMs ?? 120_000,
    maxTurns: options.maxTurns ?? 5,
    model: options.model,
  });

  const output = result.output.trim();
  const parsed = parseTesterOutput(output);

  return {
    ...parsed,
    costInfo: result.costInfo,
  };
}

// Parsing

export function parseTesterOutput(output: string): TesterResult {
  // Try JSON extraction first
  const jsonResult = extractResultJson(output);
  if (jsonResult) return jsonResult;

  // Fallback to text extraction
  return extractFromText(output);
}

export function extractResultJson(text: string): TesterResult | null {
  const jsonMatch = text.match(/\{[\s\S]*"success"[\s\S]*\}/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return normalizeResult(parsed, text);
  } catch {
    return null;
  }
}

function normalizeResult(parsed: any, output: string): TesterResult {
  return {
    success: Boolean(parsed.success),
    testsPassed: typeof parsed.testsPassed === 'number' ? parsed.testsPassed : 0,
    testsFailed: typeof parsed.testsFailed === 'number' ? parsed.testsFailed : 0,
    coverage: typeof parsed.coverage === 'number' ? parsed.coverage : undefined,
    output: typeof parsed.output === 'string' ? parsed.output : output,
    failedTests: Array.isArray(parsed.failedTests) ? parsed.failedTests : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
    error: typeof parsed.error === 'string' ? parsed.error : undefined,
  };
}

function extractFromText(text: string): TesterResult {
  return {
    success: !text.includes('FAIL') && !text.includes('failed'),
    testsPassed: 0,
    testsFailed: 0,
    output: text,
    failedTests: [],
    suggestions: [],
    error: extractErrorMessage(text),
  };
}

function extractErrorMessage(text: string): string | undefined {
  const errorMatch = text.match(/error:?\s*(.+)/i);
  return errorMatch ? errorMatch[1] : undefined;
}

// Formatting

/**
 * Format test report as a Discord message
 */
export function formatTestReport(result: TesterResult): string {
  const statusEmoji = result.success ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Test Results: ${result.success ? 'Passed' : 'Failed'}**`);
  lines.push('');
  lines.push(`**Tests Passed:** ${result.testsPassed}`);
  lines.push(`**Tests Failed:** ${result.testsFailed}`);

  if (result.coverage != null) {
    lines.push(`**Coverage:** ${(result.coverage * 100).toFixed(1)}%`);
  }

  if (result.failedTests && result.failedTests.length > 0) {
    lines.push('');
    lines.push('**Failed Tests:**');
    for (const test of result.failedTests.slice(0, PROMPT_FAILED_TESTS_LIMIT)) {
      lines.push(`  ❌ ${test}`);
    }
    if (result.failedTests.length > PROMPT_FAILED_TESTS_LIMIT) {
      lines.push(`  … +${result.failedTests.length - PROMPT_FAILED_TESTS_LIMIT} more`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('**Suggestions:**');
    for (const suggestion of result.suggestions.slice(0, PROMPT_SUGGESTIONS_LIMIT)) {
      lines.push(`  • ${suggestion}`);
    }
  }

  if (result.error) {
    lines.push('');
    lines.push(`**Error:** ${result.error}`);
  }

  return lines.join('\n');
}

/**
 * Build test fix prompt for the worker.
 * Enforces aggregate bounds on feedback to prevent prompt bloat.
 */
export function buildTestFixPrompt(result: TesterResult): string {
  const lines: string[] = [];

  lines.push(`The tests ${result.success ? 'passed' : 'failed'}.`);
  lines.push(`Tests passed: ${result.testsPassed}, Tests failed: ${result.testsFailed}`);

  if (result.coverage != null) {
    lines.push(`Coverage: ${(result.coverage * 100).toFixed(1)}%`);
  }

  // Bound failed tests list to prevent prompt bloat
  if (result.failedTests && result.failedTests.length > 0) {
    lines.push('');
    lines.push('### Failed Tests:');
    const shown = result.failedTests.slice(0, PROMPT_FAILED_TESTS_LIMIT);
    for (let i = 0; i < shown.length; i++) {
      lines.push(`${i + 1}. \`${shown[i]}\``);
    }
    if (result.failedTests.length > PROMPT_FAILED_TESTS_LIMIT) {
      lines.push(`… +${result.failedTests.length - PROMPT_FAILED_TESTS_LIMIT} more`);
    }
  }

  // Bound suggestions list to prevent prompt bloat
  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('### Fix Suggestions:');
    const shown = result.suggestions.slice(0, PROMPT_SUGGESTIONS_LIMIT);
    for (let i = 0; i < shown.length; i++) {
      lines.push(`${i + 1}. ${shown[i]}`);
    }
    if (result.suggestions.length > PROMPT_SUGGESTIONS_LIMIT) {
      lines.push(`… +${result.suggestions.length - PROMPT_SUGGESTIONS_LIMIT} more`);
    }
  }

  lines.push('');
  lines.push('Fix the above test failures.');

  const full = lines.join('\n');
  // Enforce aggregate prompt budget
  return full.length > PROMPT_FEEDBACK_LIMIT
    ? full.slice(0, PROMPT_FEEDBACK_LIMIT - 3) + '…'
    : full;
}

// Re-export getPrompts for tester
import { getPrompts } from '../locale/index.js';
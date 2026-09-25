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
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `# Tester Agent

## Original Task
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription.slice(0, 200)}${options.taskDescription.length > 200 ? '...' : ''}

## Worker's Changes
${workerReport}

## Instructions
1. Run tests for the changed files
2. Verify that all existing tests pass
3. Suggest new tests if needed for new functionality
4. Report test coverage if available

## Test Execution Steps
1. Check the project's test command (package.json, pytest.ini, etc.)
2. Run relevant test files. Respect the host-provided \`OPENSWARM_TEST_PARALLELISM\`
   ceiling for any explicit worker/thread flag; never replace it with an
   unbounded count. Pytest \`-n auto\` is capped automatically.
3. Analyze any failed tests
4. Determine if additional tests are needed

## Output Format (IMPORTANT - must output in this format at the end)
After testing is complete, output the result in the following JSON format:

\`\`\`json
{
  "success": true,
  "testsPassed": 10,
  "testsFailed": 0,
  "coverage": 85.5,
  "failedTests": [],
  "suggestions": ["Additional test suggestions (if any)"]
}
\`\`\`

On failure:
\`\`\`json
{
  "success": false,
  "testsPassed": 8,
  "testsFailed": 2,
  "coverage": 75.0,
  "failedTests": ["test_feature.py::test_case1", "test_feature.py::test_case2"],
  "suggestions": ["Failure cause analysis", "Fix suggestions"],
  "error": "Detailed error message"
}
\`\`\`
`;
}

// Tester Execution

/**
 * Run Tester agent
 */
export async function runTester(options: TesterOptions): Promise<TesterResult> {
  const prompt = buildTesterPrompt(options);
  const cwd = expandPath(options.projectPath);
  const adapter = getAdapter(options.adapterName);

  try {
    const raw = await spawnCli(adapter, {
      prompt,
      cwd,
      timeoutMs: options.timeoutMs,
      model: options.model,
      maxTurns: options.maxTurns,
    });

    return parseTesterOutput(raw.stdout);
  } catch (error) {
    // Rate-limit AND infra failures (CLI exit, timeout, auth, spawn) mean the
    // TESTER never ran — they are NOT "tests failed". Propagate so the pipeline
    // classifies rate_limited / infra_error instead of feeding a bogus
    // "fix the tests" self-repair loop that burns iterations → false STUCK.
    // worker.ts:337 / reviewer.ts:264 already do this; the tester was missing it. (INT-2521)
    if (error instanceof RateLimitError) throw error;
    if (isInfraError(error)) throw error;
    return {
      success: false,
      testsPassed: 0,
      testsFailed: 0,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Parse Tester output
 */
export function parseTesterOutput(output: string): TesterResult {
  try {
    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[Tester] Cost: ${formatCost(costInfo)}`);
    }

    // Extract result entry from NDJSON
    let resultText = '';
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line.trim());
        if (event.type === 'result' && event.result) {
          resultText = event.result;
          break;
        }
        if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
          resultText = event.item.text;
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultText) {
      const result = extractFromText(output);
      result.costInfo = costInfo;
      return result;
    }

    // Extract JSON block from result
    const result = extractResultJson(resultText) || extractFromText(resultText);
    result.costInfo = costInfo;
    return result;
  } catch (error) {
    console.error('[Tester] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * Extract JSON block from result
 */
function extractResultJson(text: string): TesterResult | null {
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
      return normalizeResult(parsed, text);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeResult(parsed, text);
  } catch {
    return null;
  }
}

/**
 * Normalize result
 */
function normalizeResult(parsed: any, output: string): TesterResult {
  return {
    success: Boolean(parsed.success),
    testsPassed: typeof parsed.testsPassed === 'number' ? parsed.testsPassed : 0,
    testsFailed: typeof parsed.testsFailed === 'number' ? parsed.testsFailed : 0,
    coverage: typeof parsed.coverage === 'number' ? parsed.coverage : undefined,
    output,
    failedTests: Array.isArray(parsed.failedTests) ? parsed.failedTests : undefined,
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : undefined,
    error: parsed.error,
  };
}

/**
 * Extract result from text (when JSON parsing fails)
 */
function extractFromText(text: string): TesterResult {
  // Estimate success
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /pass|success|completed|all tests/i.test(text);

  // Extract test statistics
  let testsPassed = 0;
  let testsFailed = 0;

  // Common test result patterns
  const passMatch = text.match(/(\d+)\s*(?:passed|pass|passing)/i);
  const failMatch = text.match(/(\d+)\s*(?:failed|fail|failing)/i);

  if (passMatch) testsPassed = parseInt(passMatch[1], 10);
  if (failMatch) testsFailed = parseInt(failMatch[1], 10);

  // Extract coverage
  let coverage: number | undefined;
  const coverageMatch = text.match(/(?:coverage|cov)[:\s]*(\d+(?:\.\d+)?)\s*%/i);
  if (coverageMatch) {
    coverage = parseFloat(coverageMatch[1]);
  }

  // Extract failed tests
  const failedTests: string[] = [];
  const failedPattern = /(?:FAILED|FAIL)\s+([^\s]+(?:::[\w_]+)?)/gi;
  const failedMatches = text.matchAll(failedPattern);
  for (const m of failedMatches) {
    if (!failedTests.includes(m[1])) {
      failedTests.push(m[1]);
    }
  }

  // A tester that produced NO output verified nothing — the "no error keyword ⇒
  // success" default would fake a PASS on an empty/degenerate run and let
  // unverified code through the blocking test gate. Only genuinely empty output is
  // flagged, so a short-but-real run ("collected 0 items") is unaffected. (INT-2521)
  const noOutput = text.trim().length === 0;
  return {
    success: !noOutput && (!hasError || (hasSuccess && testsFailed === 0)),
    testsPassed,
    testsFailed,
    coverage,
    output: text,
    failedTests: failedTests.length > 0 ? failedTests : undefined,
    error: hasError ? extractErrorMessage(text) : (noOutput ? 'Tester produced no output — result unverified' : undefined),
  };
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

// Formatting

/**
 * Format Tester result as Discord message
 */
export function formatTestReport(result: TesterResult): string {
  const statusEmoji = result.success ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Tester Result: ${result.success ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push(`**Passed:** ${result.testsPassed} | **Failed:** ${result.testsFailed}`);

  if (result.coverage !== undefined) {
    lines.push(`**Coverage:** ${result.coverage.toFixed(1)}%`);
  }

  if (result.failedTests && result.failedTests.length > 0) {
    lines.push('');
    lines.push('**Failed Tests:**');
    for (const test of result.failedTests.slice(0, 5)) {
      lines.push(`  • \`${test}\``);
    }
    if (result.failedTests.length > 5) {
      lines.push(`  • ... +${result.failedTests.length - 5} more`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('**Suggestions:**');
    for (const suggestion of result.suggestions.slice(0, 3)) {
      lines.push(`  • ${suggestion}`);
    }
  }

  if (result.error) {
    lines.push(`**Error:** ${result.error}`);
  }

  return lines.join('\n');
}

/**
 * Convert Tester result to Worker feedback
 */
export function buildTestFixPrompt(result: TesterResult): string {
  const lines: string[] = [];

  lines.push('## Test Failures');
  lines.push('');
  lines.push(`**Passed:** ${result.testsPassed} | **Failed:** ${result.testsFailed}`);

  if (result.failedTests && result.failedTests.length > 0) {
    lines.push('');
    lines.push('### Failed Tests:');
    for (let i = 0; i < result.failedTests.length; i++) {
      lines.push(`${i + 1}. \`${result.failedTests[i]}\``);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('### Fix Suggestions:');
    for (let i = 0; i < result.suggestions.length; i++) {
      lines.push(`${i + 1}. ${result.suggestions[i]}`);
    }
  }

  lines.push('');
  lines.push('Fix the above test failures.');

  return lines.join('\n');
}

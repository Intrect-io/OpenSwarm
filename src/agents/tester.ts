// ============================================
// OpenSwarm - Tester Agent
// Test execution agent (CLI adapter based)
// ============================================

import { formatCommandEvidence } from './workerValidationEvidence.js';
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
  /** Reasoning effort for this role's native-loop adapter (RoleConfig.effort). */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * Declarative per-role tool scope (RoleConfig.tools), applied at the end of the
   * loop's tool assembly so it can only narrow what the run already exposes.
   */
  toolAllow?: string[];
  toolDeny?: string[];
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
${formatCommandEvidence(options.workerResult)}
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
      reasoningEffort: options.reasoningEffort,
      toolAllow: options.toolAllow,
      toolDeny: options.toolDeny,
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
 * Bounds for the repair prompt handed to the worker on a failing run.
 * `failedTests`/`suggestions` are taken from the tester's JSON unvalidated, so
 * a verbose or adversarial result composed a prompt of arbitrary size — and
 * this text is carried into the next worker prompt as untrusted data, where a
 * report big enough to crowd out its own instructions degrades the run instead
 * of failing it. Bounded per entry, then per list, then whole.
 */
const FIX_PROMPT_ENTRIES = 20;
const FIX_PROMPT_ENTRY_CHARS = 300;
/**
 * Ceiling for the composed prompt — well below the locale's per-data-block cap
 * (`MAX_PROMPT_DATA_CHARS`, 20k) so that block's own cut can never land first.
 */
export const TEST_FIX_PROMPT_BUDGET_CHARS = 8_000;
/** Room kept back for the withholding notice and the closing instruction. */
const FIX_PROMPT_RESERVE_CHARS = 400;

/** Per entry: one list line, clipped in place so the cut is visible. */
function boundEntry(value: string): { text: string; clipped: boolean } {
  // Normalize only a bounded window: the entry itself can be megabytes, and
  // sweeping a discarded tail with the whitespace regex is wasted work. Trim
  // first (cheap, and the window is taken after it) so a padded-but-real name
  // survives instead of the window filling with the padding. The window is
  // twice the cap because normalization only ever shortens.
  const trimmed = value.trim();
  const window = trimmed.length > FIX_PROMPT_ENTRY_CHARS * 2
    ? trimmed.slice(0, FIX_PROMPT_ENTRY_CHARS * 2)
    : trimmed;
  const flat = window.replace(/\s+/g, ' ');
  const clipped = window.length < trimmed.length || flat.length > FIX_PROMPT_ENTRY_CHARS;
  return clipped
    ? { text: `${flat.slice(0, FIX_PROMPT_ENTRY_CHARS)}…`, clipped: true }
    : { text: flat, clipped: false };
}

/**
 * Convert Tester result to Worker feedback
 */
export function buildTestFixPrompt(result: TesterResult): string {
  const lines: string[] = [];
  const withheld: string[] = [];
  // Counts the '\n' each line will add, so the ceiling below is exact.
  let used = 0;
  const push = (line: string): void => {
    lines.push(line);
    used += line.length + 1;
  };
  const room = TEST_FIX_PROMPT_BUDGET_CHARS - FIX_PROMPT_RESERVE_CHARS;

  push('## Test Failures');
  push('');
  push(`**Passed:** ${result.testsPassed} | **Failed:** ${result.testsFailed}`);

  const appendEntries = (
    label: string,
    entries: readonly string[] | undefined,
    render: (position: number, text: string) => string,
    cap: number,
  ): void => {
    if (!entries || entries.length === 0) return;
    push('');
    push(`### ${label}:`);
    let listed = 0;
    let clipped = 0;
    for (let i = 0; i < entries.length && i < FIX_PROMPT_ENTRIES; i++) {
      const entry = boundEntry(entries[i]);
      const line = render(i + 1, entry.text);
      if (used + line.length + 1 > cap) break;
      push(line);
      listed += 1;
      if (entry.clipped) clipped += 1;
    }
    if (listed < entries.length || clipped > 0) {
      withheld.push(`${label}: ${listed} of ${entries.length} listed${clipped > 0 ? `, ${clipped} cut short (marked in place)` : ''}`);
    }
  };

  // Each list gets an equal share of the room left, so a malformed first list
  // cannot spend it all: a bounded prompt that omitted every fix suggestion
  // would leave the worker with nothing to act on. An unused share flows on.
  const failed = result.failedTests && result.failedTests.length > 0;
  const suggested = result.suggestions && result.suggestions.length > 0;
  if (failed) {
    appendEntries(
      'Failed Tests',
      result.failedTests,
      (position, text) => `${position}. \`${text}\``,
      used + Math.floor((room - used) / (suggested ? 2 : 1)),
    );
  }
  if (suggested) {
    appendEntries(
      'Fix Suggestions',
      result.suggestions,
      (position, text) => `${position}. ${text}`,
      room,
    );
  }

  // What a bound withheld is stated rather than silently missing: a worker
  // shown a partial report must not read it as the whole one. The labels are a
  // closed, short set, so the reserve covers these lines; the closing
  // instruction is what it is kept back for.
  const closing = 'Fix the above test failures.';
  if (withheld.length > 0) {
    push('');
    push('## Report withheld (prompt budget)');
    push('The tester reported more than this prompt carries; the rest is not here.');
    for (const line of withheld) {
      if (used + line.length + 1 + closing.length + 2 > TEST_FIX_PROMPT_BUDGET_CHARS) break;
      push(`- ${line}`);
    }
  }

  push('');
  push(closing);

  return lines.join('\n');
}

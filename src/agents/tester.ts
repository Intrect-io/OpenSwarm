// ============================================
// Claude Swarm - Tester Agent
// Test execution agent (Claude CLI based)
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';
import { type CostInfo, extractCostFromJson, formatCost } from '../support/costTracker.js';

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

export interface TesterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
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
}

// ============================================
// Prompts
// ============================================

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
- **Description:** ${options.taskDescription}

## Worker's Changes
${workerReport}

## Instructions
1. 변경된 파일들에 대한 테스트를 실행하라
2. 기존 테스트가 모두 통과하는지 확인하라
3. 새로운 기능에 대한 테스트가 필요하면 제안하라
4. 테스트 커버리지가 있다면 보고하라

## Test Execution Steps
1. 프로젝트 테스트 명령 확인 (package.json, pytest.ini 등)
2. 관련 테스트 파일 실행
3. 실패한 테스트가 있으면 분석
4. 테스트 추가 필요 여부 판단

## Output Format (IMPORTANT - 반드시 이 형식으로 마지막에 출력)
테스트 완료 후 반드시 다음 JSON 형식으로 결과를 출력하라:

\`\`\`json
{
  "success": true,
  "testsPassed": 10,
  "testsFailed": 0,
  "coverage": 85.5,
  "failedTests": [],
  "suggestions": ["추가 테스트 제안 (있다면)"]
}
\`\`\`

실패 시:
\`\`\`json
{
  "success": false,
  "testsPassed": 8,
  "testsFailed": 2,
  "coverage": 75.0,
  "failedTests": ["test_feature.py::test_case1", "test_feature.py::test_case2"],
  "suggestions": ["실패 원인 분석", "수정 제안"],
  "error": "상세 에러 메시지"
}
\`\`\`
`;
}

// ============================================
// Tester Execution
// ============================================

/**
 * Run Tester agent
 */
export async function runTester(options: TesterOptions): Promise<TesterResult> {
  const prompt = buildTesterPrompt(options);
  const promptFile = `/tmp/tester-prompt-${Date.now()}.txt`;

  try {
    // Save prompt
    await fs.writeFile(promptFile, prompt);

    // Run Claude CLI
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);

    // Parse result
    return parseTesterOutput(output);
  } catch (error) {
    return {
      success: false,
      testsPassed: 0,
      testsFailed: 0,
      output: '',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // Clean up temp file
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

    // Set timeout (unlimited if <= 0)
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Tester timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.error('[Tester] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }

      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Tester spawn error: ${err.message}`));
    });
  });
}

/**
 * Parse Tester output
 */
function parseTesterOutput(output: string): TesterResult {
  try {
    const costInfo = extractCostFromJson(output);
    if (costInfo) {
      console.log(`[Tester] Cost: ${formatCost(costInfo)}`);
    }

    // Extract result from Claude JSON array
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) {
      const result = extractFromText(output);
      result.costInfo = costInfo;
      return result;
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

  return {
    success: !hasError || (hasSuccess && testsFailed === 0),
    testsPassed,
    testsFailed,
    coverage,
    output: text,
    failedTests: failedTests.length > 0 ? failedTests : undefined,
    error: hasError ? extractErrorMessage(text) : undefined,
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

// ============================================
// Formatting
// ============================================

/**
 * Format Tester result as Discord message
 */
export function formatTestReport(result: TesterResult): string {
  const statusEmoji = result.success ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Tester 결과: ${result.success ? 'PASS' : 'FAIL'}**`);
  lines.push('');
  lines.push(`**통과:** ${result.testsPassed} | **실패:** ${result.testsFailed}`);

  if (result.coverage !== undefined) {
    lines.push(`**커버리지:** ${result.coverage.toFixed(1)}%`);
  }

  if (result.failedTests && result.failedTests.length > 0) {
    lines.push('');
    lines.push('**실패한 테스트:**');
    for (const test of result.failedTests.slice(0, 5)) {
      lines.push(`  • \`${test}\``);
    }
    if (result.failedTests.length > 5) {
      lines.push(`  • ... 외 ${result.failedTests.length - 5}개`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('**제안:**');
    for (const suggestion of result.suggestions.slice(0, 3)) {
      lines.push(`  • ${suggestion}`);
    }
  }

  if (result.error) {
    lines.push(`**에러:** ${result.error}`);
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
  lines.push(`**통과:** ${result.testsPassed} | **실패:** ${result.testsFailed}`);

  if (result.failedTests && result.failedTests.length > 0) {
    lines.push('');
    lines.push('### 실패한 테스트:');
    for (let i = 0; i < result.failedTests.length; i++) {
      lines.push(`${i + 1}. \`${result.failedTests[i]}\``);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('### 수정 제안:');
    for (let i = 0; i < result.suggestions.length; i++) {
      lines.push(`${i + 1}. ${result.suggestions[i]}`);
    }
  }

  lines.push('');
  lines.push('위 테스트 실패를 수정하라.');

  return lines.join('\n');
}

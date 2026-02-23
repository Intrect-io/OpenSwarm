// ============================================
// OpenSwarm - Auditor Agent
// /audit 스킬 기반 BS 탐지 에이전트
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';
import { type CostInfo, extractCostFromStreamJson, formatCost } from '../support/costTracker.js';

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return p.replace('~', homedir());
  }
  return p;
}

// ============================================
// Types
// ============================================

export interface AuditorOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
}

export interface AuditorResult {
  success: boolean;
  bsScore?: number;
  criticalCount: number;
  warningCount: number;
  minorCount: number;
  issues: string[];
  summary: string;
  error?: string;
  costInfo?: CostInfo;
}

// ============================================
// Prompts
// ============================================

function buildAuditorPrompt(options: AuditorOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `/audit

## 작업 컨텍스트
- **Task:** ${options.taskTitle}
- **Description:** ${options.taskDescription}

## Worker's Changes
${workerReport}

위 작업에서 변경된 파일을 중심으로 감사를 수행하라.
감사 완료 후 반드시 다음 JSON 형식으로 결과를 출력하라:

\`\`\`json
{
  "success": true,
  "bsScore": 2.1,
  "criticalCount": 0,
  "warningCount": 3,
  "minorCount": 5,
  "issues": ["src/foo.ts:42 - unused import"],
  "summary": "BS 지수 2.1/5.0, CRITICAL 이슈 없음"
}
\`\`\`

실패 시:
\`\`\`json
{
  "success": false,
  "bsScore": 7.5,
  "criticalCount": 3,
  "warningCount": 5,
  "minorCount": 2,
  "issues": ["CRITICAL: src/bar.ts:10 - 하드코딩된 시크릿"],
  "summary": "BS 지수 7.5/5.0 - CRITICAL 이슈 발견"
}
\`\`\`
`;
}

// ============================================
// Auditor Execution
// ============================================

export async function runAuditor(options: AuditorOptions): Promise<AuditorResult> {
  const prompt = buildAuditorPrompt(options);
  const promptFile = `/tmp/auditor-prompt-${Date.now()}.txt`;

  try {
    await fs.writeFile(promptFile, prompt);
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);
    return parseAuditorOutput(output);
  } catch (error) {
    return {
      success: false,
      criticalCount: 0,
      warningCount: 0,
      minorCount: 0,
      issues: [],
      summary: 'Auditor 실행 실패',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await fs.unlink(promptFile);
    } catch {
      // Ignore
    }
  }
}

async function runClaudeCli(
  promptFile: string,
  cwd: string,
  timeoutMs: number = 300000,
  model?: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const modelFlag = model ? ` --model ${model}` : '';
    const cmd = `echo "" | claude -p "$(cat ${promptFile})" --output-format stream-json --permission-mode bypassPermissions${modelFlag}`;

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

    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Auditor timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && code !== null) {
        console.error('[Auditor] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Auditor spawn error: ${err.message}`));
    });
  });
}

// ============================================
// Output Parsing
// ============================================

function parseAuditorOutput(output: string): AuditorResult {
  try {
    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[Auditor] Cost: ${formatCost(costInfo)}`);
    }

    // NDJSON에서 result 항목 추출
    let resultText = '';
    for (const line of output.split('\n')) {
      try {
        const event = JSON.parse(line.trim());
        if (event.type === 'result' && event.result) {
          resultText = event.result;
          break;
        }
      } catch { /* skip non-JSON lines */ }
    }

    if (!resultText) {
      const result = extractFromText(output);
      result.costInfo = costInfo;
      return result;
    }

    const result = extractResultJson(resultText) || extractFromText(resultText);
    result.costInfo = costInfo;
    return result;
  } catch (error) {
    console.error('[Auditor] Parse error:', error);
    return extractFromText(output);
  }
}

function extractResultJson(text: string): AuditorResult | null {
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
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
      return normalizeResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeResult(parsed);
  } catch {
    return null;
  }
}

function normalizeResult(parsed: any): AuditorResult {
  const bsScore = typeof parsed.bsScore === 'number' ? parsed.bsScore : undefined;
  return {
    success: bsScore !== undefined ? bsScore < 5.0 : Boolean(parsed.success),
    bsScore,
    criticalCount: typeof parsed.criticalCount === 'number' ? parsed.criticalCount : 0,
    warningCount: typeof parsed.warningCount === 'number' ? parsed.warningCount : 0,
    minorCount: typeof parsed.minorCount === 'number' ? parsed.minorCount : 0,
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    summary: parsed.summary || '(요약 없음)',
    error: parsed.error,
  };
}

function extractFromText(text: string): AuditorResult {
  const hasError = /error|fail|exception|critical/i.test(text);
  const hasSuccess = /success|pass|clean|no issues/i.test(text);

  // BS score 추출
  let bsScore: number | undefined;
  const bsMatch = text.match(/(?:bs|bullshit)\s*(?:지수|score|index)[:\s]*(\d+(?:\.\d+)?)/i);
  if (bsMatch) {
    bsScore = parseFloat(bsMatch[1]);
  }

  // 이슈 추출
  const issues: string[] = [];
  const issuePattern = /(?:CRITICAL|WARNING|MINOR|issue)[:\s]+([^\n]+)/gi;
  const issueMatches = text.matchAll(issuePattern);
  for (const m of issueMatches) {
    if (!issues.includes(m[1].trim())) {
      issues.push(m[1].trim());
    }
  }

  return {
    success: !hasError || hasSuccess,
    bsScore,
    criticalCount: 0,
    warningCount: 0,
    minorCount: 0,
    issues: issues.slice(0, 20),
    summary: extractSummary(text),
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return '(요약 없음)';
  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
}

function extractErrorMessage(text: string): string {
  const errorMatch = text.match(/(?:error|exception|failed?):\s*(.+)/i);
  if (errorMatch) return errorMatch[1].slice(0, 200);
  const lines = text.split('\n').filter((l) => /error|fail/i.test(l));
  if (lines.length > 0) return lines[0].slice(0, 200);
  return 'Unknown error';
}

// ============================================
// Formatting
// ============================================

export function formatAuditReport(result: AuditorResult): string {
  const statusEmoji = result.success ? '🔍' : '🚨';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Auditor 결과: ${result.success ? 'PASS' : 'FAIL'}**`);
  lines.push('');

  if (result.bsScore !== undefined) {
    lines.push(`**BS 지수:** ${result.bsScore.toFixed(1)}/5.0`);
  }

  lines.push(`**Critical:** ${result.criticalCount} | **Warning:** ${result.warningCount} | **Minor:** ${result.minorCount}`);
  lines.push(`**요약:** ${result.summary}`);

  if (result.issues.length > 0) {
    lines.push('');
    lines.push('**발견된 이슈:**');
    for (const issue of result.issues.slice(0, 5)) {
      lines.push(`  - ${issue}`);
    }
    if (result.issues.length > 5) {
      lines.push(`  - ... 외 ${result.issues.length - 5}개`);
    }
  }

  if (result.error) {
    lines.push(`**에러:** ${result.error}`);
  }

  return lines.join('\n');
}

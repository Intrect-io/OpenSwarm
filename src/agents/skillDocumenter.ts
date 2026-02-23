// ============================================
// OpenSwarm - Skill Documenter Agent
// /documents 스킬 기반 문서 자동 업데이트 에이전트
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

export interface SkillDocumenterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
}

export interface SkillDocumenterResult {
  success: boolean;
  updatedFiles: string[];
  summary: string;
  error?: string;
  costInfo?: CostInfo;
}

// ============================================
// Prompts
// ============================================

function buildSkillDocumenterPrompt(options: SkillDocumenterOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `/documents

## 작업 컨텍스트
- **Task:** ${options.taskTitle}
- **Description:** ${options.taskDescription}

## Worker's Changes
${workerReport}

위 작업에서 변경된 내용을 반영하여 프로젝트 문서를 업데이트하라.
문서 업데이트 완료 후 반드시 다음 JSON 형식으로 결과를 출력하라:

\`\`\`json
{
  "success": true,
  "updatedFiles": ["CLAUDE.md", "docs/architecture.md"],
  "summary": "아키텍처 문서에 새 모듈 설명 추가"
}
\`\`\`

업데이트할 내용이 없는 경우:
\`\`\`json
{
  "success": true,
  "updatedFiles": [],
  "summary": "문서 업데이트 불필요 (사소한 변경)"
}
\`\`\`

실패 시:
\`\`\`json
{
  "success": false,
  "updatedFiles": [],
  "summary": "문서 업데이트 실패",
  "error": "상세 에러 메시지"
}
\`\`\`
`;
}

// ============================================
// Skill Documenter Execution
// ============================================

export async function runSkillDocumenter(options: SkillDocumenterOptions): Promise<SkillDocumenterResult> {
  const prompt = buildSkillDocumenterPrompt(options);
  const promptFile = `/tmp/skill-documenter-prompt-${Date.now()}.txt`;

  try {
    await fs.writeFile(promptFile, prompt);
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);
    return parseSkillDocumenterOutput(output);
  } catch (error) {
    return {
      success: false,
      updatedFiles: [],
      summary: 'Skill Documenter 실행 실패',
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
  timeoutMs: number = 120000,
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
        reject(new Error(`SkillDocumenter timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (code !== 0 && code !== null) {
        console.error('[SkillDocumenter] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }
      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`SkillDocumenter spawn error: ${err.message}`));
    });
  });
}

// ============================================
// Output Parsing
// ============================================

function parseSkillDocumenterOutput(output: string): SkillDocumenterResult {
  try {
    const costInfo = extractCostFromStreamJson(output);
    if (costInfo) {
      console.log(`[SkillDocumenter] Cost: ${formatCost(costInfo)}`);
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
    console.error('[SkillDocumenter] Parse error:', error);
    return extractFromText(output);
  }
}

function extractResultJson(text: string): SkillDocumenterResult | null {
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

function normalizeResult(parsed: any): SkillDocumenterResult {
  return {
    success: Boolean(parsed.success),
    updatedFiles: Array.isArray(parsed.updatedFiles) ? parsed.updatedFiles : [],
    summary: parsed.summary || '(요약 없음)',
    error: parsed.error,
  };
}

function extractFromText(text: string): SkillDocumenterResult {
  const hasError = /error|fail|exception/i.test(text);
  const hasSuccess = /success|completed|updated|documented/i.test(text);

  const updatedFiles: string[] = [];
  const filePatterns = [
    /(?:updated?|modified?|created?|wrote?):\s*(.+\.(?:md|rst|txt))/gi,
    /(?:CLAUDE|AGENTS|README|docs?)\.md/gi,
  ];

  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!updatedFiles.includes(file)) {
        updatedFiles.push(file);
      }
    }
  }

  return {
    success: !hasError || hasSuccess,
    updatedFiles: updatedFiles.slice(0, 10),
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

export function formatSkillDocReport(result: SkillDocumenterResult): string {
  const statusEmoji = result.success ? '📄' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Skill Documenter 결과: ${result.success ? '완료' : '실패'}**`);
  lines.push('');
  lines.push(`**요약:** ${result.summary}`);

  if (result.updatedFiles.length > 0) {
    lines.push(`**업데이트된 파일:** ${result.updatedFiles.join(', ')}`);
  } else {
    lines.push('**업데이트된 파일:** (없음)');
  }

  if (result.error) {
    lines.push(`**에러:** ${result.error}`);
  }

  return lines.join('\n');
}

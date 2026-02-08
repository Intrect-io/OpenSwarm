// ============================================
// Claude Swarm - Documenter Agent
// 문서화 에이전트 (Claude CLI 기반)
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';

/**
 * ~ 경로를 홈 디렉토리로 확장
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

export interface DocumenterOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;
}

export interface DocumenterResult {
  success: boolean;
  updatedFiles: string[];
  changelogEntry?: string;
  apiDocsUpdated: boolean;
  summary: string;
  error?: string;
}

// ============================================
// Prompts
// ============================================

/**
 * Documenter 프롬프트 생성
 */
function buildDocumenterPrompt(options: DocumenterOptions): string {
  const workerReport = `
- **Success:** ${options.workerResult.success}
- **Summary:** ${options.workerResult.summary}
- **Files Changed:** ${options.workerResult.filesChanged.join(', ') || '(none)'}
- **Commands:** ${options.workerResult.commands.join(', ') || '(none)'}
`;

  return `# Documenter Agent

## Original Task
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription}

## Worker's Changes
${workerReport}

## Instructions
1. 변경된 코드에 대한 문서화를 수행하라
2. CHANGELOG.md가 있으면 새 엔트리 추가
3. 새 함수/클래스에 JSDoc/docstring 추가
4. README 업데이트가 필요하면 수행
5. API 문서가 있으면 업데이트

## Documentation Rules
- 기존 문서 스타일을 따르라
- 변경 내용을 명확하게 기술하라
- 코드 예제를 포함하라 (필요시)
- 불필요한 문서는 추가하지 마라

## Output Format (IMPORTANT - 반드시 이 형식으로 마지막에 출력)
문서화 완료 후 반드시 다음 JSON 형식으로 결과를 출력하라:

\`\`\`json
{
  "success": true,
  "updatedFiles": ["CHANGELOG.md", "src/module.ts"],
  "changelogEntry": "- feat: 새로운 기능 추가",
  "apiDocsUpdated": false,
  "summary": "문서화 요약 (1-2문장)"
}
\`\`\`

문서화할 내용이 없는 경우:
\`\`\`json
{
  "success": true,
  "updatedFiles": [],
  "apiDocsUpdated": false,
  "summary": "문서화가 필요하지 않음 (사소한 변경)"
}
\`\`\`

실패 시:
\`\`\`json
{
  "success": false,
  "updatedFiles": [],
  "apiDocsUpdated": false,
  "summary": "문서화 실패",
  "error": "상세 에러 메시지"
}
\`\`\`
`;
}

// ============================================
// Documenter Execution
// ============================================

/**
 * Documenter 에이전트 실행
 */
export async function runDocumenter(options: DocumenterOptions): Promise<DocumenterResult> {
  const prompt = buildDocumenterPrompt(options);
  const promptFile = `/tmp/documenter-prompt-${Date.now()}.txt`;

  try {
    // 프롬프트 저장
    await fs.writeFile(promptFile, prompt);

    // Claude CLI 실행
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);

    // 결과 파싱
    return parseDocumenterOutput(output);
  } catch (error) {
    return {
      success: false,
      updatedFiles: [],
      apiDocsUpdated: false,
      summary: 'Documenter 실행 실패',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    // 임시 파일 정리
    try {
      await fs.unlink(promptFile);
    } catch {
      // 무시
    }
  }
}

/**
 * Claude CLI 실행
 */
async function runClaudeCli(
  promptFile: string,
  cwd: string,
  timeoutMs: number = 120000, // 2분 기본 (문서화는 빠름)
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

    // 타임아웃 설정 (0 이하면 무제한)
    let timer: NodeJS.Timeout | null = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        proc.kill('SIGKILL');
        reject(new Error(`Documenter timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.error('[Documenter] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }

      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Documenter spawn error: ${err.message}`));
    });
  });
}

/**
 * Documenter 출력 파싱
 */
function parseDocumenterOutput(output: string): DocumenterResult {
  try {
    // Claude JSON 배열에서 result 추출
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

    // 결과에서 JSON 블록 추출
    return extractResultJson(resultText) || extractFromText(resultText);
  } catch (error) {
    console.error('[Documenter] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * 결과에서 JSON 블록 추출
 */
function extractResultJson(text: string): DocumenterResult | null {
  // ```json ... ``` 블록 찾기
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // 일반 JSON 객체 찾기
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

/**
 * 결과 정규화
 */
function normalizeResult(parsed: any): DocumenterResult {
  return {
    success: Boolean(parsed.success),
    updatedFiles: Array.isArray(parsed.updatedFiles) ? parsed.updatedFiles : [],
    changelogEntry: parsed.changelogEntry,
    apiDocsUpdated: Boolean(parsed.apiDocsUpdated),
    summary: parsed.summary || '(요약 없음)',
    error: parsed.error,
  };
}

/**
 * 텍스트에서 결과 추출 (JSON 파싱 실패 시)
 */
function extractFromText(text: string): DocumenterResult {
  // 성공 여부 추정
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|updated|documented/i.test(text);

  // 업데이트된 파일 추출
  const updatedFiles: string[] = [];
  const filePatterns = [
    /(?:updated?|modified?|created?|wrote?):\s*(.+\.(?:md|rst|txt))/gi,
    /(?:CHANGELOG|README|docs?)\/[\w/\-.]+/gi,
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

  // Changelog 엔트리 추출
  let changelogEntry: string | undefined;
  const changelogMatch = text.match(/(?:changelog|변경\s*로그)[\s:]*([^\n]+)/i);
  if (changelogMatch) {
    changelogEntry = changelogMatch[1].trim();
  }

  return {
    success: !hasError || hasSuccess,
    updatedFiles: updatedFiles.slice(0, 10),
    changelogEntry,
    apiDocsUpdated: /api\s*doc/i.test(text),
    summary: extractSummary(text),
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

/**
 * 요약 추출
 */
function extractSummary(text: string): string {
  const lines = text.split('\n').filter((l) => l.trim().length > 10);
  if (lines.length === 0) return '(요약 없음)';

  const summary = lines[0].trim();
  return summary.length > 200 ? summary.slice(0, 200) + '...' : summary;
}

/**
 * 에러 메시지 추출
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
 * Documenter 결과를 Discord 메시지로 포맷
 */
export function formatDocReport(result: DocumenterResult): string {
  const statusEmoji = result.success ? '📝' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Documenter 결과: ${result.success ? '완료' : '실패'}**`);
  lines.push('');
  lines.push(`**요약:** ${result.summary}`);

  if (result.updatedFiles.length > 0) {
    lines.push(`**업데이트된 파일:** ${result.updatedFiles.join(', ')}`);
  } else {
    lines.push('**업데이트된 파일:** (없음)');
  }

  if (result.changelogEntry) {
    lines.push(`**Changelog:** ${result.changelogEntry}`);
  }

  if (result.apiDocsUpdated) {
    lines.push('**API 문서:** ✅ 업데이트됨');
  }

  if (result.error) {
    lines.push(`**에러:** ${result.error}`);
  }

  return lines.join('\n');
}

// ============================================
// Claude Swarm - Worker Agent
// 작업 수행 에이전트 (Claude CLI 기반)
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult } from './agentPair.js';
import * as gitTracker from './gitTracker.js';

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

export interface WorkerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  previousFeedback?: string;   // Reviewer의 이전 피드백 (수정 시)
  timeoutMs?: number;
  model?: string;              // Claude 모델 (기본: claude-sonnet-4-20250514)
}

// ============================================
// Prompts
// ============================================

/**
 * Worker 프롬프트 생성
 */
function buildWorkerPrompt(options: WorkerOptions): string {
  const feedbackSection = options.previousFeedback
    ? `\n## Previous Feedback (수정 필요)
${options.previousFeedback}

위 피드백을 반영하여 수정하라.
`
    : '';

  return `# Worker Agent

## Task
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription}
${feedbackSection}
## Instructions
1. 작업을 수행하고 결과를 보고하라
2. 변경한 파일 목록을 명시하라
3. 실행한 명령어를 기록하라
4. 불확실한 부분이 있으면 명시하라
5. 코드 품질과 테스트를 고려하라

## 금지 사항 (CRITICAL)
- rm -rf, git reset --hard 등 파괴적 명령 금지
- 환경 설정 파일(.env, .bashrc 등) 수정 금지
- 시스템 레벨 변경 금지

## Output Format (CRITICAL - 반드시 이 형식으로 마지막에 출력)
작업 완료 후 반드시 다음 JSON 형식으로 결과를 출력하라:

\`\`\`json
{
  "success": true,
  "summary": "내가 수행한 작업 요약 (1-2문장, Reviewer 피드백 복사 금지)",
  "filesChanged": ["실제로 Edit/Write한 파일의 전체 경로"],
  "commands": ["실행한 Bash 명령어 목록"]
}
\`\`\`

**IMPORTANT:**
- **summary**: 내가 직접 수행한 작업을 설명 (예: "API 응답 캐싱 추가", "DB 쿼리 최적화")
  - ❌ Reviewer 피드백을 복사하지 마라
  - ❌ "작업 완료 요약" 같은 제목 넣지 마라
- **filesChanged**: Edit/Write 도구로 실제 변경한 파일의 **전체 경로** 목록
  - ❌ 빈 배열 금지 (파일을 변경했다면 반드시 기록)
  - ❌ 읽기만 한 파일 제외
- **commands**: Bash로 실행한 명령어 (npm run build, pytest 등)

실패 시:
\`\`\`json
{
  "success": false,
  "summary": "실패 이유 (구체적으로)",
  "filesChanged": [],
  "commands": [],
  "error": "상세 에러 메시지"
}
\`\`\`
`;
}

// ============================================
// Worker Execution
// ============================================

/**
 * Worker 에이전트 실행
 * Git 기반 파일 변경 추적 통합 (Aider 스타일)
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerResult> {
  const prompt = buildWorkerPrompt(options);
  const promptFile = `/tmp/worker-prompt-${Date.now()}.txt`;
  const cwd = expandPath(options.projectPath);

  // Git 스냅샷 (작업 전 상태)
  let snapshotHash = '';
  const isGitRepo = await gitTracker.isGitRepo(cwd);
  if (isGitRepo) {
    snapshotHash = await gitTracker.takeSnapshot(cwd);
    console.log(`[Worker] Git snapshot: ${snapshotHash.slice(0, 8)}`);
  }

  try {
    // 프롬프트 저장
    await fs.writeFile(promptFile, prompt);

    // Claude CLI 실행
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);

    // 결과 파싱 (LLM 출력에서)
    const parsedResult = parseWorkerOutput(output);

    // Git diff로 실제 변경된 파일 추출 (LLM 보고와 별개로)
    if (isGitRepo && snapshotHash) {
      const gitChangedFiles = await gitTracker.getChangedFilesSinceSnapshot(cwd, snapshotHash);

      if (gitChangedFiles.length > 0) {
        console.log(`[Worker] Git detected changes: ${gitChangedFiles.join(', ')}`);

        // LLM이 보고한 것과 병합 (Git 결과 우선)
        const mergedFiles = new Set([
          ...gitChangedFiles,
          ...parsedResult.filesChanged,
        ]);
        parsedResult.filesChanged = Array.from(mergedFiles);
      } else if (parsedResult.filesChanged.length === 0) {
        console.log('[Worker] No file changes detected by Git or LLM');
      }
    }

    return parsedResult;
  } catch (error) {
    return {
      success: false,
      summary: 'Worker 실행 실패',
      filesChanged: [],
      commands: [],
      output: '',
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
  timeoutMs: number = 300000, // 5분 기본
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
        reject(new Error(`Worker timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.error('[Worker] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }

      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Worker spawn error: ${err.message}`));
    });
  });
}

/**
 * Worker 출력 파싱
 */
function parseWorkerOutput(output: string): WorkerResult {
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
    console.error('[Worker] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * 결과에서 JSON 블록 추출
 */
function extractResultJson(text: string): WorkerResult | null {
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
      return {
        success: Boolean(parsed.success),
        summary: parsed.summary || '(요약 없음)',
        filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
        commands: Array.isArray(parsed.commands) ? parsed.commands : [],
        output: text,
        error: parsed.error,
      };
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return {
      success: Boolean(parsed.success),
      summary: parsed.summary || '(요약 없음)',
      filesChanged: Array.isArray(parsed.filesChanged) ? parsed.filesChanged : [],
      commands: Array.isArray(parsed.commands) ? parsed.commands : [],
      output: text,
      error: parsed.error,
    };
  } catch {
    return null;
  }
}

/**
 * 텍스트에서 결과 추출 (JSON 파싱 실패 시)
 */
function extractFromText(text: string): WorkerResult {
  // 성공 여부 추정
  const hasError = /error|fail|exception|cannot/i.test(text);
  const hasSuccess = /success|completed|done|finished/i.test(text);

  // 파일 변경 추출
  const filePatterns = [
    /(?:changed?|modified?|created?|updated?):\s*(.+\.(?:ts|js|py|json|yaml|yml|md))/gi,
    /(?:src|lib|test|tests)\/[\w/\-.]+\.(?:ts|js|py)/gi,
  ];

  const filesChanged: string[] = [];
  for (const pattern of filePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      const file = m[1] || m[0];
      if (!filesChanged.includes(file)) {
        filesChanged.push(file);
      }
    }
  }

  // 명령어 추출
  const cmdPattern = /(?:`|\$)\s*((?:npm|pnpm|yarn|git|python|pytest|tsc|eslint)\s+[^\n`]+)/gi;
  const commands: string[] = [];
  const cmdMatches = text.matchAll(cmdPattern);
  for (const m of cmdMatches) {
    if (!commands.includes(m[1])) {
      commands.push(m[1].trim());
    }
  }

  return {
    success: !hasError || hasSuccess,
    summary: extractSummary(text),
    filesChanged: filesChanged.slice(0, 10),
    commands: commands.slice(0, 10),
    output: text,
    error: hasError ? extractErrorMessage(text) : undefined,
  };
}

/**
 * 텍스트에서 요약 추출
 */
function extractSummary(text: string): string {
  // 첫 번째 의미있는 문장 추출
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
 * Worker 결과를 Discord 메시지로 포맷
 */
export function formatWorkReport(result: WorkerResult): string {
  const statusEmoji = result.success ? '✅' : '❌';
  const lines: string[] = [];

  lines.push(`${statusEmoji} **Worker 작업 ${result.success ? '완료' : '실패'}**`);
  lines.push('');
  lines.push(`**요약:** ${result.summary}`);

  if (result.filesChanged.length > 0) {
    lines.push(`**변경 파일:** ${result.filesChanged.join(', ')}`);
  }

  if (result.commands.length > 0) {
    const cmdList = result.commands.slice(0, 5).map((c) => `\`${c}\``).join(', ');
    lines.push(`**실행 명령:** ${cmdList}`);
  }

  if (result.error) {
    lines.push(`**에러:** ${result.error}`);
  }

  return lines.join('\n');
}

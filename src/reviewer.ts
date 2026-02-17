// ============================================
// Claude Swarm - Reviewer Agent
// 코드 리뷰 에이전트 (Claude CLI 기반)
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { WorkerResult, ReviewResult, ReviewDecision } from './agentPair.js';

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

export interface ReviewerOptions {
  taskTitle: string;
  taskDescription: string;
  workerResult: WorkerResult;
  projectPath: string;
  timeoutMs?: number;
  model?: string;              // Claude 모델 (기본: claude-sonnet-4-20250514)
}

// ============================================
// Prompts
// ============================================

/**
 * Reviewer 프롬프트 생성
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

  return `# Reviewer Agent

## Original Task
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription}

## Worker's Report
${workerReport}

## Review Criteria
1. 작업이 요구사항을 충족하는가?
2. 코드 품질은 적절한가? (가독성, 유지보수성)
3. 누락된 부분이 있는가?
4. 리스크나 사이드 이펙트가 있는가?
5. 테스트가 필요하거나 누락되었는가?

## Decision Options
- **approve**: 작업 완료, 승인. 요구사항 충족, 품질 적절
- **revise**: 수정 필요. 구체적 피드백 제공 필수
- **reject**: 근본적 문제. 재작업 불가 수준

## Instructions
1. 변경된 파일들을 확인하라 (Read 도구 사용)
2. 코드 품질과 요구사항 충족 여부를 평가하라
3. 문제점이 있다면 구체적으로 나열하라
4. 개선 제안이 있다면 제시하라
5. 최종 결정을 내려라

## Output Format (IMPORTANT - 반드시 이 형식으로 마지막에 출력)
리뷰 완료 후 반드시 다음 JSON 형식으로 결과를 출력하라:

\`\`\`json
{
  "decision": "approve" | "revise" | "reject",
  "feedback": "전체적인 피드백 (1-3문장)",
  "issues": ["발견된 문제점 목록 (없으면 빈 배열)"],
  "suggestions": ["개선 제안 목록 (없으면 빈 배열)"]
}
\`\`\`

예시 (approve):
\`\`\`json
{
  "decision": "approve",
  "feedback": "요구사항을 정확히 구현했고, 코드 품질도 적절합니다.",
  "issues": [],
  "suggestions": ["향후 에러 핸들링 보강 고려"]
}
\`\`\`

예시 (revise):
\`\`\`json
{
  "decision": "revise",
  "feedback": "기본 구현은 되었으나 몇 가지 수정이 필요합니다.",
  "issues": ["에러 핸들링 누락", "테스트 코드 없음"],
  "suggestions": ["try-catch 블록 추가", "단위 테스트 작성"]
}
\`\`\`
`;
}

// ============================================
// Reviewer Execution
// ============================================

/**
 * Reviewer 에이전트 실행
 */
export async function runReviewer(options: ReviewerOptions): Promise<ReviewResult> {
  const prompt = buildReviewerPrompt(options);
  const promptFile = `/tmp/reviewer-prompt-${Date.now()}.txt`;

  try {
    // 프롬프트 저장
    await fs.writeFile(promptFile, prompt);

    // Claude CLI 실행
    const cwd = expandPath(options.projectPath);
    const output = await runClaudeCli(promptFile, cwd, options.timeoutMs, options.model);

    // 결과 파싱
    return parseReviewerOutput(output);
  } catch (error) {
    return {
      decision: 'reject',
      feedback: `Reviewer 실행 실패: ${error instanceof Error ? error.message : String(error)}`,
      issues: ['Reviewer 에이전트 실행 중 오류 발생'],
      suggestions: ['수동 리뷰 필요'],
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
  timeoutMs: number = 180000, // 3분 기본 (리뷰는 작업보다 빠름)
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
        reject(new Error(`Reviewer timeout after ${timeoutMs}ms`));
      }, timeoutMs);
    }

    proc.on('close', (code) => {
      if (timer) clearTimeout(timer);

      if (code !== 0 && code !== null) {
        console.error('[Reviewer] CLI error:', stderr.slice(0, 500));
        reject(new Error(`Claude CLI failed with code ${code}`));
        return;
      }

      resolve(stdout);
    });

    proc.on('error', (err) => {
      if (timer) clearTimeout(timer);
      reject(new Error(`Reviewer spawn error: ${err.message}`));
    });
  });
}

/**
 * Reviewer 출력 파싱
 */
function parseReviewerOutput(output: string): ReviewResult {
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
    console.error('[Reviewer] Parse error:', error);
    return extractFromText(output);
  }
}

/**
 * 결과에서 JSON 블록 추출
 */
function extractResultJson(text: string): ReviewResult | null {
  // ```json ... ``` 블록 찾기
  const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
  if (!jsonMatch) {
    // 일반 JSON 객체 찾기
    const objMatch = text.match(/\{\s*"decision"\s*:/);
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
      return normalizeReviewResult(parsed);
    } catch {
      return null;
    }
  }

  try {
    const parsed = JSON.parse(jsonMatch[1]);
    return normalizeReviewResult(parsed);
  } catch {
    return null;
  }
}

/**
 * 파싱된 결과 정규화
 */
function normalizeReviewResult(parsed: any): ReviewResult {
  // decision 유효성 검사
  let decision: ReviewDecision = 'revise';
  if (['approve', 'revise', 'reject'].includes(parsed.decision)) {
    decision = parsed.decision as ReviewDecision;
  } else if (parsed.decision) {
    // 유사 문자열 매핑
    const normalized = parsed.decision.toLowerCase();
    if (normalized.includes('approv') || normalized.includes('pass')) {
      decision = 'approve';
    } else if (normalized.includes('reject') || normalized.includes('fail')) {
      decision = 'reject';
    }
  }

  return {
    decision,
    feedback: parsed.feedback || '(피드백 없음)',
    issues: Array.isArray(parsed.issues) ? parsed.issues : [],
    suggestions: Array.isArray(parsed.suggestions) ? parsed.suggestions : [],
  };
}

/**
 * 텍스트에서 결과 추출 (JSON 파싱 실패 시)
 */
function extractFromText(text: string): ReviewResult {
  // Decision 추정
  let decision: ReviewDecision = 'revise';
  const lowerText = text.toLowerCase();

  if (lowerText.includes('approve') || lowerText.includes('승인') || lowerText.includes('lgtm')) {
    decision = 'approve';
  } else if (lowerText.includes('reject') || lowerText.includes('거부') || lowerText.includes('불가')) {
    decision = 'reject';
  } else if (lowerText.includes('revise') || lowerText.includes('수정') || lowerText.includes('개선')) {
    decision = 'revise';
  }

  // Issues 추출
  const issues: string[] = [];
  const issuePatterns = [
    /(?:issue|problem|문제|오류):\s*(.+)/gi,
    /(?:missing|누락):\s*(.+)/gi,
    /- (?:fix|수정|해결):\s*(.+)/gi,
  ];

  for (const pattern of issuePatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !issues.includes(m[1].trim())) {
        issues.push(m[1].trim().slice(0, 200));
      }
    }
  }

  // Suggestions 추출
  const suggestions: string[] = [];
  const suggestionPatterns = [
    /(?:suggest|recommend|제안|추천):\s*(.+)/gi,
    /(?:consider|고려):\s*(.+)/gi,
    /(?:should|해야):\s*(.+)/gi,
  ];

  for (const pattern of suggestionPatterns) {
    const matches = text.matchAll(pattern);
    for (const m of matches) {
      if (m[1] && !suggestions.includes(m[1].trim())) {
        suggestions.push(m[1].trim().slice(0, 200));
      }
    }
  }

  return {
    decision,
    feedback: extractFeedback(text),
    issues: issues.slice(0, 5),
    suggestions: suggestions.slice(0, 5),
  };
}

/**
 * 피드백 추출
 */
function extractFeedback(text: string): string {
  // 첫 번째 의미있는 문장 추출
  const lines = text.split('\n').filter((l) => {
    const trimmed = l.trim();
    return trimmed.length > 20 && !trimmed.startsWith('#') && !trimmed.startsWith('```');
  });

  if (lines.length === 0) return '(피드백 없음)';

  const feedback = lines[0].trim();
  return feedback.length > 300 ? feedback.slice(0, 300) + '...' : feedback;
}

// ============================================
// Formatting
// ============================================

/**
 * Reviewer 결과를 Discord 메시지로 포맷
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

  lines.push(`${decisionEmoji} **Reviewer 결정: ${decisionText}**`);
  lines.push('');
  lines.push(`**피드백:** ${result.feedback}`);

  if (result.issues && result.issues.length > 0) {
    lines.push('');
    lines.push('**문제점:**');
    for (const issue of result.issues.slice(0, 5)) {
      lines.push(`  • ${issue}`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('**개선 제안:**');
    for (const suggestion of result.suggestions.slice(0, 5)) {
      lines.push(`  • ${suggestion}`);
    }
  }

  return lines.join('\n');
}

/**
 * Reviewer 피드백을 Worker용 수정 지시로 변환
 */
export function buildRevisionPrompt(result: ReviewResult): string {
  const lines: string[] = [];

  lines.push('## Reviewer Feedback');
  lines.push('');
  lines.push(`**결정:** ${result.decision.toUpperCase()}`);
  lines.push(`**피드백:** ${result.feedback}`);

  if (result.issues && result.issues.length > 0) {
    lines.push('');
    lines.push('### 해결해야 할 문제점:');
    for (let i = 0; i < result.issues.length; i++) {
      lines.push(`${i + 1}. ${result.issues[i]}`);
    }
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push('');
    lines.push('### 개선 제안:');
    for (let i = 0; i < result.suggestions.length; i++) {
      lines.push(`${i + 1}. ${result.suggestions[i]}`);
    }
  }

  lines.push('');
  lines.push('위 피드백을 반영하여 코드를 수정하라.');

  return lines.join('\n');
}

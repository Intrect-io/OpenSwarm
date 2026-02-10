// ============================================
// Claude Swarm - Planner Agent
// 큰 이슈를 30분 단위 sub-task로 분해
// ============================================

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import type { TaskItem } from './decisionEngine.js';

// ============================================
// Types
// ============================================

export interface PlannerOptions {
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  projectName?: string;
  timeoutMs?: number;
  model?: string;
  targetMinutes?: number;  // 각 sub-task 목표 시간 (기본 25분)
}

export interface SubTask {
  title: string;
  description: string;
  estimatedMinutes: number;
  priority: number;  // 1-4 (1=Urgent)
  dependencies?: string[];  // 선행 sub-task 제목
}

export interface PlannerResult {
  success: boolean;
  originalIssue: string;
  needsDecomposition: boolean;
  reason?: string;
  subTasks: SubTask[];
  totalEstimatedMinutes: number;
  error?: string;
}

// ============================================
// Prompts
// ============================================

function buildPlannerPrompt(options: PlannerOptions): string {
  const targetMinutes = options.targetMinutes ?? 25;

  return `# Planner Agent

## Task to Analyze
- **Title:** ${options.taskTitle}
- **Description:** ${options.taskDescription}
- **Project:** ${options.projectName || options.projectPath}

## Your Mission
이 작업을 분석하고, ${targetMinutes}분 이내에 완료할 수 있는 단위로 분해하라.

## Analysis Steps
1. 작업 범위 파악
2. 필요한 단계 나열
3. 각 단계의 예상 시간 추정
4. ${targetMinutes}분 초과 시 더 작은 단위로 분해
5. 의존성 관계 파악

## Guidelines
- 각 sub-task는 독립적으로 테스트/검증 가능해야 함
- 너무 작게 쪼개지 마라 (최소 10분 이상)
- 명확하고 구체적인 제목 사용
- 의존성이 있으면 순서대로 번호 매기기

## Output Format (JSON)
분석 결과를 다음 JSON 형식으로 출력하라:

\`\`\`json
{
  "needsDecomposition": true,
  "reason": "왜 분해가 필요한지 또는 불필요한지",
  "subTasks": [
    {
      "title": "[타입] 구체적인 작업 제목",
      "description": "상세 설명 (무엇을, 어떻게, 완료 기준)",
      "estimatedMinutes": 20,
      "priority": 2,
      "dependencies": []
    },
    {
      "title": "[타입] 다음 작업",
      "description": "상세 설명",
      "estimatedMinutes": 25,
      "priority": 2,
      "dependencies": ["[타입] 구체적인 작업 제목"]
    }
  ],
  "totalEstimatedMinutes": 45
}
\`\`\`

**needsDecomposition**:
- true: 작업이 ${targetMinutes}분 초과 예상, 분해 필요
- false: 작업이 ${targetMinutes}분 이내 예상, 분해 불필요

**분해 불필요 시**:
\`\`\`json
{
  "needsDecomposition": false,
  "reason": "단일 API 수정으로 15분 내 완료 가능",
  "subTasks": [],
  "totalEstimatedMinutes": 15
}
\`\`\`

## Important
- 코드를 작성하지 마라, 분석만 하라
- 프로젝트 구조를 파악하고 현실적으로 추정하라
- 불확실하면 보수적으로 (더 길게) 추정하라
`;
}

// ============================================
// Planner Execution
// ============================================

/**
 * Planner 에이전트 실행
 */
export async function runPlanner(options: PlannerOptions): Promise<PlannerResult> {
  const prompt = buildPlannerPrompt(options);
  const promptFile = `/tmp/planner-prompt-${Date.now()}.txt`;
  const cwd = expandPath(options.projectPath);

  try {
    await fs.writeFile(promptFile, prompt);

    const output = await runClaudeCli(
      promptFile,
      cwd,
      options.timeoutMs ?? 300000,  // 5분 타임아웃
      options.model ?? 'claude-sonnet-4-20250514'
    );

    return parsePlannerOutput(output, options.taskTitle);
  } catch (error) {
    return {
      success: false,
      originalIssue: options.taskTitle,
      needsDecomposition: false,
      subTasks: [],
      totalEstimatedMinutes: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await fs.unlink(promptFile);
    } catch {
      // ignore
    }
  }
}

/**
 * Claude CLI 실행
 */
function runClaudeCli(
  promptFile: string,
  cwd: string,
  timeoutMs: number,
  model: string
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      '-p', `$(cat ${promptFile})`,
      '--output-format', 'json',
      '--permission-mode', 'bypassPermissions',
      '--model', model,
    ];

    const proc = spawn('claude', args, {
      cwd,
      shell: true,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      reject(new Error(`Planner timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 || stdout.length > 0) {
        resolve(stdout);
      } else {
        reject(new Error(`Planner failed (code ${code}): ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * Planner 출력 파싱
 */
function parsePlannerOutput(output: string, originalTitle: string): PlannerResult {
  try {
    // Claude JSON 배열에서 result 추출
    const match = output.match(/\[[\s\S]*\]/);
    if (!match) {
      return extractFromText(output, originalTitle);
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
      return extractFromText(output, originalTitle);
    }

    // JSON 블록 추출
    const jsonMatch = resultText.match(/```json\s*([\s\S]*?)\s*```/);
    if (!jsonMatch) {
      // 직접 JSON 객체 찾기
      const objMatch = resultText.match(/\{\s*"needsDecomposition"/);
      if (objMatch) {
        return parseDirectJson(resultText, objMatch.index!, originalTitle);
      }
      return extractFromText(resultText, originalTitle);
    }

    const parsed = JSON.parse(jsonMatch[1]);
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: Boolean(parsed.needsDecomposition),
      reason: parsed.reason,
      subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks : [],
      totalEstimatedMinutes: parsed.totalEstimatedMinutes || 0,
    };
  } catch (error) {
    console.error('[Planner] Parse error:', error);
    return extractFromText(output, originalTitle);
  }
}

/**
 * 직접 JSON 파싱
 */
function parseDirectJson(text: string, startIdx: number, originalTitle: string): PlannerResult {
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
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: Boolean(parsed.needsDecomposition),
      reason: parsed.reason,
      subTasks: Array.isArray(parsed.subTasks) ? parsed.subTasks : [],
      totalEstimatedMinutes: parsed.totalEstimatedMinutes || 0,
    };
  } catch {
    return extractFromText(text, originalTitle);
  }
}

/**
 * 텍스트에서 추출 (fallback)
 */
function extractFromText(text: string, originalTitle: string): PlannerResult {
  // 분해 불필요로 판단된 경우
  if (text.toLowerCase().includes('no decomposition') ||
      text.includes('분해 불필요') ||
      text.includes('단일 작업')) {
    return {
      success: true,
      originalIssue: originalTitle,
      needsDecomposition: false,
      reason: 'Planner determined no decomposition needed',
      subTasks: [],
      totalEstimatedMinutes: 30,
    };
  }

  // 파싱 실패 - 기본적으로 분해 필요로 간주
  return {
    success: false,
    originalIssue: originalTitle,
    needsDecomposition: true,
    reason: 'Failed to parse planner output',
    subTasks: [],
    totalEstimatedMinutes: 0,
    error: 'Could not parse planner output',
  };
}

// ============================================
// Linear Integration
// ============================================

/**
 * Sub-tasks를 Linear sub-issues로 생성
 */
export async function createLinearSubIssues(
  parentIssueId: string,
  subTasks: SubTask[],
  _teamId: string,
  _projectId?: string
): Promise<{ success: boolean; createdIds: string[]; error?: string }> {
  // 이 함수는 Linear MCP를 직접 호출해야 하므로,
  // autonomousRunner에서 mcp__linear-server__create_issue를 사용하도록 함
  // 여기서는 데이터 준비만

  const createdIds: string[] = [];

  // Note: 실제 Linear API 호출은 autonomousRunner에서 수행
  console.log(`[Planner] Prepared ${subTasks.length} sub-issues for ${parentIssueId}`);

  return { success: true, createdIds };
}

/**
 * 이슈 예상 시간 추정 (heuristic)
 */
export function estimateTaskDuration(task: TaskItem): number {
  const title = task.title.toLowerCase();
  const desc = (task.description || '').toLowerCase();
  const combined = `${title} ${desc}`;

  // 키워드 기반 추정
  let estimate = 30; // 기본 30분

  // 복잡도 증가 요소
  if (combined.includes('최적화') || combined.includes('optimization')) estimate += 30;
  if (combined.includes('리팩토링') || combined.includes('refactor')) estimate += 20;
  if (combined.includes('테스트') || combined.includes('test')) estimate += 15;
  if (combined.includes('마이그레이션') || combined.includes('migration')) estimate += 40;
  if (combined.includes('전체') || combined.includes('모든') || combined.includes('all')) estimate += 30;
  if (combined.includes('ci/cd') || combined.includes('파이프라인')) estimate += 25;
  if (combined.includes('프론트엔드') && combined.includes('백엔드')) estimate += 40;
  if (combined.includes('playwright') || combined.includes('e2e')) estimate += 30;

  // 복잡도 감소 요소
  if (combined.includes('버그') || combined.includes('bug') || combined.includes('fix')) estimate -= 10;
  if (combined.includes('문서') || combined.includes('docs')) estimate -= 15;
  if (combined.includes('간단') || combined.includes('simple')) estimate -= 15;

  return Math.max(10, estimate);
}

/**
 * 분해 필요 여부 판단
 */
export function needsDecomposition(task: TaskItem, maxMinutes: number = 30): boolean {
  const estimated = estimateTaskDuration(task);
  return estimated > maxMinutes;
}

// ============================================
// Utilities
// ============================================

function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return p.replace('~', homedir());
  }
  return p;
}

// ============================================
// Formatting
// ============================================

/**
 * Planner 결과를 Discord 메시지로 포맷
 */
export function formatPlannerResult(result: PlannerResult): string {
  const lines: string[] = [];

  if (!result.success) {
    lines.push('❌ **Planner 분석 실패**');
    lines.push(`에러: ${result.error || 'Unknown error'}`);
    return lines.join('\n');
  }

  if (!result.needsDecomposition) {
    lines.push('✅ **분해 불필요**');
    lines.push(`이유: ${result.reason}`);
    lines.push(`예상 시간: ${result.totalEstimatedMinutes}분`);
    return lines.join('\n');
  }

  lines.push('📋 **작업 분해 완료**');
  lines.push(`원본: ${result.originalIssue}`);
  lines.push(`이유: ${result.reason}`);
  lines.push('');
  lines.push(`**Sub-tasks (${result.subTasks.length}개, 총 ${result.totalEstimatedMinutes}분):**`);

  for (let i = 0; i < result.subTasks.length; i++) {
    const st = result.subTasks[i];
    const deps = st.dependencies?.length ? ` (선행: ${st.dependencies.join(', ')})` : '';
    lines.push(`${i + 1}. ${st.title} (~${st.estimatedMinutes}분)${deps}`);
  }

  return lines.join('\n');
}

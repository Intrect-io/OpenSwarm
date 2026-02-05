// ============================================
// Claude Swarm - Development Task Execution
// ============================================

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync, readdirSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkWorkAllowed, getTimeWindowSummary } from './timeWindow.js';

/**
 * 알려진 저장소 목록 (별칭 -> 경로)
 */
const KNOWN_REPOS: Record<string, string> = {
  // Tools
  pykis: '~/dev/tools/pykis',
  pykiwoom: '~/dev/tools/pykiwoom',
  'pykiwoom-rest': '~/dev/tools/pykiwoom-rest',

  // Projects - 필요에 따라 추가
  'claude-swarm': '~/dev/claude-swarm',
  stonks: '~/dev/STONKS',
  stockapi: '~/dev/StockAPI',
};

/**
 * 활성 dev 작업 추적
 */
type DevTask = {
  repo: string;
  path: string;
  task: string;
  process: ChildProcess;
  output: string;
  startedAt: number;
  requestedBy: string;
};

const activeTasks: Map<string, DevTask> = new Map();

/**
 * 경로 확장 (~/ 처리)
 */
function expandPath(p: string): string {
  if (p.startsWith('~/')) {
    return resolve(homedir(), p.slice(2));
  }
  return resolve(p);
}

/**
 * 저장소 경로 해석
 * - 별칭 (pykis) -> 알려진 경로
 * - 상대경로 (tools/pykis) -> ~/dev/ 아래
 * - 절대경로 (~/ 또는 /) -> 그대로
 */
export function resolveRepoPath(repo: string): string | null {
  // 1. 알려진 별칭 확인
  if (KNOWN_REPOS[repo.toLowerCase()]) {
    const path = expandPath(KNOWN_REPOS[repo.toLowerCase()]);
    return existsSync(path) ? path : null;
  }

  // 2. ~/ 또는 / 시작 (절대 경로)
  if (repo.startsWith('~/') || repo.startsWith('/')) {
    const path = expandPath(repo);
    return existsSync(path) ? path : null;
  }

  // 3. 상대 경로 (~/dev/ 아래로 가정)
  const devPath = expandPath(`~/dev/${repo}`);
  if (existsSync(devPath)) {
    return devPath;
  }

  return null;
}

/**
 * 알려진 저장소 목록 반환
 */
export function listKnownRepos(): { alias: string; path: string; exists: boolean }[] {
  return Object.entries(KNOWN_REPOS).map(([alias, path]) => ({
    alias,
    path,
    exists: existsSync(expandPath(path)),
  }));
}

/**
 * ~/dev 폴더 내 저장소 스캔
 */
export function scanDevRepos(): string[] {
  const devDir = expandPath('~/dev');
  if (!existsSync(devDir)) return [];

  try {
    return readdirSync(devDir)
      .filter((name) => {
        const fullPath = resolve(devDir, name);
        try {
          return statSync(fullPath).isDirectory() &&
                 existsSync(resolve(fullPath, '.git'));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * Dev 작업 실행
 * @param bypassTimeWindow - true면 시간 제한 무시 (수동 요청 시 사용)
 */
export async function runDevTask(
  repo: string,
  task: string,
  requestedBy: string,
  onProgress?: (chunk: string) => void,
  onComplete?: (output: string, exitCode: number | null) => void,
  bypassTimeWindow = false,
): Promise<{ taskId: string; path: string } | { error: string }> {
  // 시간 윈도우 체크 (수동 요청이 아닌 경우만)
  if (!bypassTimeWindow) {
    const timeCheck = checkWorkAllowed();
    if (!timeCheck.allowed) {
      return {
        error: `작업 차단: ${timeCheck.reason}\n현재: ${timeCheck.currentTime}\n${timeCheck.nextAllowedTime ? `다음 허용 시간: ${timeCheck.nextAllowedTime}` : ''}`,
      };
    }
  }

  const path = resolveRepoPath(repo);

  if (!path) {
    return { error: `저장소를 찾을 수 없습니다: ${repo}` };
  }

  // 동일 저장소에 이미 실행 중인 작업이 있는지 확인
  const existingTask = Array.from(activeTasks.values()).find(t => t.path === path);
  if (existingTask) {
    return { error: `${repo}에 이미 실행 중인 작업이 있습니다 (id: ${existingTask.repo})` };
  }

  const taskId = `${repo}-${Date.now()}`;

  // Claude CLI 실행
  const claudeProcess = spawn('claude', ['-p', task, '--output-format', 'text'], {
    cwd: path,
    env: {
      ...process.env,
      // 권한 우회 없이 실행 (안전하게)
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const devTask: DevTask = {
    repo,
    path,
    task,
    process: claudeProcess,
    output: '',
    startedAt: Date.now(),
    requestedBy,
  };

  activeTasks.set(taskId, devTask);

  // stdout 수집
  claudeProcess.stdout?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    devTask.output += chunk;
    onProgress?.(chunk);
  });

  // stderr 수집
  claudeProcess.stderr?.on('data', (data: Buffer) => {
    const chunk = data.toString();
    devTask.output += chunk;
  });

  // 완료 처리
  claudeProcess.on('close', (code) => {
    // 리포트 파일 생성
    const duration = Math.floor((Date.now() - devTask.startedAt) / 1000);
    generateReport(devTask, code, duration);

    onComplete?.(devTask.output, code);
    activeTasks.delete(taskId);
  });

  // 에러 처리
  claudeProcess.on('error', (err) => {
    devTask.output += `\nError: ${err.message}`;
    onComplete?.(devTask.output, -1);
    activeTasks.delete(taskId);
  });

  return { taskId, path };
}

/**
 * 활성 작업 목록
 */
export function getActiveTasks(): { taskId: string; repo: string; path: string; startedAt: number; requestedBy: string }[] {
  return Array.from(activeTasks.entries()).map(([taskId, task]) => ({
    taskId,
    repo: task.repo,
    path: task.path,
    startedAt: task.startedAt,
    requestedBy: task.requestedBy,
  }));
}

/**
 * 작업 취소
 */
export function cancelTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task) return false;

  task.process.kill('SIGTERM');
  activeTasks.delete(taskId);
  return true;
}

/**
 * 알려진 저장소 추가 (런타임)
 */
export function addKnownRepo(alias: string, path: string): void {
  KNOWN_REPOS[alias.toLowerCase()] = path;
}

/**
 * 작업 리포트 생성
 */
function generateReport(task: DevTask, exitCode: number | null, durationSec: number): void {
  const now = new Date();
  const dateStr = now.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = now.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' });

  // 리포트 파일 경로 (저장소 내 reports/ 디렉토리)
  const reportsDir = resolve(task.path, 'reports');
  const reportFile = resolve(reportsDir, `${dateStr}-report.md`);

  // reports 디렉토리 생성
  try {
    if (!existsSync(reportsDir)) {
      const fs = require('fs');
      fs.mkdirSync(reportsDir, { recursive: true });
    }
  } catch (err) {
    console.error(`[Report] Failed to create reports directory: ${err}`);
    return;
  }

  // 출력 요약 (너무 길면 잘라냄)
  const outputSummary = task.output.length > 3000
    ? task.output.slice(-3000) + '\n\n...(truncated)'
    : task.output;

  // 상태 이모지
  const statusEmoji = exitCode === 0 ? '✅' : exitCode === null ? '⚠️' : '❌';
  const statusText = exitCode === 0 ? '성공' : exitCode === null ? '중단됨' : `실패 (code: ${exitCode})`;

  // 리포트 내용
  const reportEntry = `
---

## ${statusEmoji} ${timeStr} 작업 리포트

| 항목 | 내용 |
|------|------|
| **요청자** | ${task.requestedBy} |
| **작업** | ${task.task.slice(0, 100)}${task.task.length > 100 ? '...' : ''} |
| **상태** | ${statusText} |
| **소요시간** | ${formatDuration(durationSec)} |

### 작업 내용

\`\`\`
${task.task}
\`\`\`

### 실행 결과

\`\`\`
${outputSummary.trim() || '(출력 없음)'}
\`\`\`

`;

  // 파일이 존재하면 append, 없으면 헤더와 함께 생성
  try {
    if (existsSync(reportFile)) {
      appendFileSync(reportFile, reportEntry, 'utf-8');
    } else {
      const header = `# ${dateStr} 작업 리포트

> 이 파일은 Claude Swarm에 의해 자동 생성됩니다.
> 저장소: \`${task.path}\`

`;
      writeFileSync(reportFile, header + reportEntry, 'utf-8');
    }
    console.log(`[Report] Generated: ${reportFile}`);
  } catch (err) {
    console.error(`[Report] Failed to write report: ${err}`);
  }
}

/**
 * 시간 포맷팅
 */
function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  if (minutes < 60) return `${minutes}분 ${remainingSec}초`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  return `${hours}시간 ${remainingMin}분`;
}

/**
 * 현재 작업 가능 상태 조회
 */
export function getWorkStatus(): { canWork: boolean; summary: string } {
  const timeCheck = checkWorkAllowed();
  return {
    canWork: timeCheck.allowed,
    summary: getTimeWindowSummary(),
  };
}

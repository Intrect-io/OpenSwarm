// ============================================
// Claude Swarm - Agent Pair Session Management
// Worker/Reviewer 페어 세션 관리
// ============================================

import { randomUUID } from 'node:crypto';

// ============================================
// Types
// ============================================

/**
 * Worker 실행 결과
 */
export interface WorkerResult {
  success: boolean;
  summary: string;
  filesChanged: string[];
  commands: string[];
  output: string;
  error?: string;
}

/**
 * Reviewer 결정
 */
export type ReviewDecision = 'approve' | 'revise' | 'reject';

/**
 * Reviewer 결과
 */
export interface ReviewResult {
  decision: ReviewDecision;
  feedback: string;
  issues?: string[];
  suggestions?: string[];
}

/**
 * 페어 메시지
 */
export interface PairMessage {
  role: 'worker' | 'reviewer' | 'system';
  content: string;
  timestamp: number;
}

/**
 * 페어 세션 상태
 */
export type PairSessionStatus =
  | 'pending'      // 시작 전
  | 'working'      // Worker 작업 중
  | 'reviewing'    // Reviewer 검토 중
  | 'revising'     // Worker 수정 중
  | 'approved'     // 승인됨
  | 'rejected'     // 거부됨
  | 'failed'       // 실패
  | 'cancelled';   // 취소됨

/**
 * 페어 세션
 */
export interface PairSession {
  id: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  threadId?: string;          // Discord thread ID
  webhookUrl?: string;        // Webhook URL for notifications
  models?: PairModelConfig;   // 모델 설정
  status: PairSessionStatus;
  worker: {
    result?: WorkerResult;
    attempts: number;
    maxAttempts: number;
  };
  reviewer: {
    feedback?: ReviewResult;
  };
  messages: PairMessage[];
  startedAt: number;
  finishedAt?: number;
}

/**
 * 모델 설정
 */
export interface PairModelConfig {
  worker?: string;
  reviewer?: string;
}

/**
 * 페어 세션 생성 옵션
 */
export interface CreatePairSessionOptions {
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  maxAttempts?: number;
  webhookUrl?: string;
  models?: PairModelConfig;
}

// ============================================
// Session Store
// ============================================

const sessions = new Map<string, PairSession>();

// 최근 완료된 세션 (히스토리용)
const completedSessions: PairSession[] = [];
const MAX_HISTORY = 50;

// ============================================
// Session Management
// ============================================

/**
 * 새 페어 세션 생성
 */
export function createPairSession(options: CreatePairSessionOptions): PairSession {
  const session: PairSession = {
    id: randomUUID().slice(0, 8),
    taskId: options.taskId,
    taskTitle: options.taskTitle,
    taskDescription: options.taskDescription,
    projectPath: options.projectPath,
    webhookUrl: options.webhookUrl,
    models: options.models,
    status: 'pending',
    worker: {
      attempts: 0,
      maxAttempts: options.maxAttempts ?? 3,
    },
    reviewer: {},
    messages: [],
    startedAt: Date.now(),
  };

  sessions.set(session.id, session);
  return session;
}

/**
 * 세션 조회
 */
export function getPairSession(sessionId: string): PairSession | undefined {
  return sessions.get(sessionId);
}

/**
 * 활성 세션 목록
 */
export function getActiveSessions(): PairSession[] {
  return Array.from(sessions.values()).filter(
    (s) => !['approved', 'rejected', 'failed', 'cancelled'].includes(s.status)
  );
}

/**
 * 세션 상태 업데이트
 */
export function updateSessionStatus(
  sessionId: string,
  status: PairSessionStatus
): PairSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.status = status;

  // 완료 상태면 종료 시간 기록
  if (['approved', 'rejected', 'failed', 'cancelled'].includes(status)) {
    session.finishedAt = Date.now();
    archiveSession(session);
  }

  return session;
}

/**
 * Discord 스레드 ID 설정
 */
export function setSessionThreadId(
  sessionId: string,
  threadId: string
): PairSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.threadId = threadId;
  return session;
}

/**
 * Worker 결과 저장
 */
export function saveWorkerResult(
  sessionId: string,
  result: WorkerResult
): PairSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.worker.result = result;
  session.worker.attempts += 1;

  addMessage(sessionId, 'worker', formatWorkerMessage(result));
  return session;
}

/**
 * Reviewer 결과 저장
 */
export function saveReviewerResult(
  sessionId: string,
  result: ReviewResult
): PairSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.reviewer.feedback = result;

  addMessage(sessionId, 'reviewer', formatReviewerMessage(result));
  return session;
}

/**
 * 메시지 추가
 */
export function addMessage(
  sessionId: string,
  role: PairMessage['role'],
  content: string
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.messages.push({
    role,
    content,
    timestamp: Date.now(),
  });
}

/**
 * 세션 취소
 */
export function cancelSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (['approved', 'rejected', 'failed', 'cancelled'].includes(session.status)) {
    return false; // 이미 종료됨
  }

  updateSessionStatus(sessionId, 'cancelled');
  addMessage(sessionId, 'system', '세션이 취소되었습니다.');
  return true;
}

/**
 * Worker가 더 시도할 수 있는지 확인
 */
export function canRetry(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  return session.worker.attempts < session.worker.maxAttempts;
}

/**
 * 세션 아카이브
 */
function archiveSession(session: PairSession): void {
  completedSessions.unshift(session);
  if (completedSessions.length > MAX_HISTORY) {
    completedSessions.pop();
  }
  sessions.delete(session.id);
}

/**
 * 히스토리 조회
 */
export function getSessionHistory(limit: number = 10): PairSession[] {
  return completedSessions.slice(0, limit);
}

/**
 * 모든 세션 초기화 (테스트용)
 */
export function clearAllSessions(): void {
  sessions.clear();
  completedSessions.length = 0;
}

// ============================================
// Formatting
// ============================================

/**
 * Worker 메시지 포맷
 */
function formatWorkerMessage(result: WorkerResult): string {
  const lines: string[] = [];

  if (result.success) {
    lines.push(`**요약:** ${result.summary}`);
  } else {
    lines.push(`**실패:** ${result.error || result.summary}`);
  }

  if (result.filesChanged.length > 0) {
    lines.push(`**변경 파일:** ${result.filesChanged.join(', ')}`);
  }

  if (result.commands.length > 0) {
    lines.push(`**실행 명령:** \`${result.commands.slice(0, 3).join('`, `')}\`${result.commands.length > 3 ? ` 외 ${result.commands.length - 3}개` : ''}`);
  }

  return lines.join('\n');
}

/**
 * Reviewer 메시지 포맷
 */
function formatReviewerMessage(result: ReviewResult): string {
  const decisionEmoji = {
    approve: '✅',
    revise: '🔄',
    reject: '❌',
  }[result.decision];

  const lines: string[] = [];
  lines.push(`**결정:** ${decisionEmoji} ${result.decision.toUpperCase()}`);
  lines.push(`**피드백:** ${result.feedback}`);

  if (result.issues && result.issues.length > 0) {
    lines.push(`**문제점:**\n${result.issues.map(i => `  - ${i}`).join('\n')}`);
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push(`**제안:**\n${result.suggestions.map(s => `  - ${s}`).join('\n')}`);
  }

  return lines.join('\n');
}

/**
 * 세션 상태 요약
 */
export function formatSessionSummary(session: PairSession): string {
  const statusEmoji = {
    pending: '⏳',
    working: '🔨',
    reviewing: '🔍',
    revising: '🔄',
    approved: '✅',
    rejected: '❌',
    failed: '💥',
    cancelled: '🚫',
  }[session.status];

  const duration = session.finishedAt
    ? `${Math.round((session.finishedAt - session.startedAt) / 1000)}초`
    : `${Math.round((Date.now() - session.startedAt) / 1000)}초`;

  return [
    `${statusEmoji} **${session.taskTitle}**`,
    `ID: \`${session.id}\` | Task: \`${session.taskId}\``,
    `상태: ${session.status} | 시도: ${session.worker.attempts}/${session.worker.maxAttempts}`,
    `소요: ${duration}`,
  ].join('\n');
}

/**
 * 전체 토론 내역 포맷
 */
export function formatDiscussion(session: PairSession): string {
  if (session.messages.length === 0) {
    return '(토론 내역 없음)';
  }

  return session.messages
    .map((msg) => {
      const time = new Date(msg.timestamp).toLocaleTimeString('ko-KR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      const roleEmoji = {
        worker: '🔨',
        reviewer: '🔍',
        system: '⚙️',
      }[msg.role];

      return `[${time}] ${roleEmoji} **${msg.role.toUpperCase()}**\n${msg.content}`;
    })
    .join('\n\n---\n\n');
}

// ============================================
// Claude Swarm - Agent Pair Session Management
// Worker/Reviewer pair session management
// ============================================

import { randomUUID } from 'node:crypto';

// ============================================
// Types
// ============================================

/**
 * Worker execution result
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
 * Reviewer decision
 */
export type ReviewDecision = 'approve' | 'revise' | 'reject';

/**
 * Reviewer result
 */
export interface ReviewResult {
  decision: ReviewDecision;
  feedback: string;
  issues?: string[];
  suggestions?: string[];
}

/**
 * Pair message
 */
export interface PairMessage {
  role: 'worker' | 'reviewer' | 'system';
  content: string;
  timestamp: number;
}

/**
 * Pair session status
 */
export type PairSessionStatus =
  | 'pending'      // Not started
  | 'working'      // Worker in progress
  | 'reviewing'    // Reviewer in progress
  | 'revising'     // Worker revising
  | 'approved'     // Approved
  | 'rejected'     // Rejected
  | 'failed'       // Failed
  | 'cancelled';   // Cancelled

/**
 * Pair session
 */
export interface PairSession {
  id: string;
  taskId: string;
  taskTitle: string;
  taskDescription: string;
  projectPath: string;
  threadId?: string;          // Discord thread ID
  webhookUrl?: string;        // Webhook URL for notifications
  models?: PairModelConfig;   // Model configuration
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
 * Model configuration
 */
export interface PairModelConfig {
  worker?: string;
  reviewer?: string;
}

/**
 * Pair session creation options
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

// Recently completed sessions (for history)
const completedSessions: PairSession[] = [];
const MAX_HISTORY = 50;

// ============================================
// Session Management
// ============================================

/**
 * Create a new pair session
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
 * Get session by ID
 */
export function getPairSession(sessionId: string): PairSession | undefined {
  return sessions.get(sessionId);
}

/**
 * List active sessions
 */
export function getActiveSessions(): PairSession[] {
  return Array.from(sessions.values()).filter(
    (s) => !['approved', 'rejected', 'failed', 'cancelled'].includes(s.status)
  );
}

/**
 * Update session status
 */
export function updateSessionStatus(
  sessionId: string,
  status: PairSessionStatus
): PairSession | undefined {
  const session = sessions.get(sessionId);
  if (!session) return undefined;

  session.status = status;

  // Record finish time for completed states
  if (['approved', 'rejected', 'failed', 'cancelled'].includes(status)) {
    session.finishedAt = Date.now();
    archiveSession(session);
  }

  return session;
}

/**
 * Set Discord thread ID
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
 * Save Worker result
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
 * Save Reviewer result
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
 * Add message
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
 * Cancel session
 */
export function cancelSession(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  if (['approved', 'rejected', 'failed', 'cancelled'].includes(session.status)) {
    return false; // Already terminated
  }

  updateSessionStatus(sessionId, 'cancelled');
  addMessage(sessionId, 'system', '세션이 취소되었습니다.');
  return true;
}

/**
 * Check if Worker can retry
 */
export function canRetry(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  return session.worker.attempts < session.worker.maxAttempts;
}

/**
 * Archive session
 */
function archiveSession(session: PairSession): void {
  completedSessions.unshift(session);
  if (completedSessions.length > MAX_HISTORY) {
    completedSessions.pop();
  }
  sessions.delete(session.id);
}

/**
 * Get session history
 */
export function getSessionHistory(limit: number = 10): PairSession[] {
  return completedSessions.slice(0, limit);
}

/**
 * Clear all sessions (for testing)
 */
export function clearAllSessions(): void {
  sessions.clear();
  completedSessions.length = 0;
}

// ============================================
// Formatting
// ============================================

/**
 * Format Worker message
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
 * Format Reviewer message
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
 * Format session status summary
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
 * Format full discussion history
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

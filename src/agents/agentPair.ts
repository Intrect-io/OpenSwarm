// ============================================
// OpenSwarm - Agent Pair Session Management
// Worker/Reviewer pair session management
// ============================================

import { randomUUID } from 'node:crypto';
import type { CostInfo } from '../support/costTracker.js';

// ============================================
// Types
// ============================================

/**
 * Confidence level for execution results (legacy)
 * 0 = failed, 1 = low, 2 = medium, 3 = high
 */
export type ConfidenceLevel = 0 | 1 | 2 | 3;

/**
 * Confidence as a 0-100 percentage
 */
export type ConfidencePercent = number;

export const CONFIDENCE_THRESHOLDS = {
  PROCEED: 80,   // >= 80%: approve-eligible
  CAUTIOUS: 60,  // 60-79%: run extra validation
  HALT: 60,      // < 60%: halt → Linear comment + revise
} as const;

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
  confidence?: ConfidenceLevel; // Legacy quality/reliability of the result
  confidencePercent?: number;   // Agent self-reported 0-100
  haltReason?: string;          // Why the agent halted
  uncertaintySignals?: string[]; // Detected uncertainty phrases
  costInfo?: CostInfo;
}

/**
 * Confidence tracking for detecting degradation
 */
export interface ConfidenceTracker {
  history: Array<{
    attempt: number;
    confidence: ConfidencePercent;
    timestamp: number;
    action: string;
    haltTriggered?: boolean;
  }>;
  streakCount: number; // Consecutive low confidence count
  lastConfidence: ConfidencePercent;
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
  costInfo?: CostInfo;
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
    freshContextAfter?: number; // Use fresh context after N failures (default: 2)
    failureStreak: number; // Consecutive failures
    useFreshContext?: boolean; // Flag to use fresh context on next attempt
  };
  reviewer: {
    feedback?: ReviewResult;
  };
  messages: PairMessage[];
  confidenceTracker?: ConfidenceTracker; // Track confidence degradation
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
      freshContextAfter: 2, // Use fresh context after 2 failures
      failureStreak: 0,
      useFreshContext: false,
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
  addMessage(sessionId, 'system', 'Session has been cancelled.');
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
    lines.push(`**Summary:** ${result.summary}`);
  } else {
    lines.push(`**Failed:** ${result.error || result.summary}`);
  }

  if (result.filesChanged.length > 0) {
    lines.push(`**Changed Files:** ${result.filesChanged.join(', ')}`);
  }

  if (result.commands.length > 0) {
    lines.push(`**Commands:** \`${result.commands.slice(0, 3).join('`, `')}\`${result.commands.length > 3 ? ` +${result.commands.length - 3} more` : ''}`);
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
  lines.push(`**Decision:** ${decisionEmoji} ${result.decision.toUpperCase()}`);
  lines.push(`**Feedback:** ${result.feedback}`);

  if (result.issues && result.issues.length > 0) {
    lines.push(`**Issues:**\n${result.issues.map(i => `  - ${i}`).join('\n')}`);
  }

  if (result.suggestions && result.suggestions.length > 0) {
    lines.push(`**Suggestions:**\n${result.suggestions.map(s => `  - ${s}`).join('\n')}`);
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
    ? `${Math.round((session.finishedAt - session.startedAt) / 1000)}s`
    : `${Math.round((Date.now() - session.startedAt) / 1000)}s`;

  return [
    `${statusEmoji} **${session.taskTitle}**`,
    `ID: \`${session.id}\` | Task: \`${session.taskId}\``,
    `Status: ${session.status} | Attempts: ${session.worker.attempts}/${session.worker.maxAttempts}`,
    `Duration: ${duration}`,
  ].join('\n');
}

/**
 * Format full discussion history
 */
export function formatDiscussion(session: PairSession): string {
  if (session.messages.length === 0) {
    return '(No discussion history)';
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

// ============================================
// Confidence Tracking
// ============================================

/** Expanded uncertainty word list (from CLAUDE.md behavioral rules) */
const UNCERTAINTY_WORDS = [
  'maybe', 'might', 'possibly', 'not sure', 'unclear',
  'probably', 'perhaps', 'workaround', 'hack', 'temporary fix',
  'not certain', 'could be', 'i think', 'i believe', 'assuming',
  'seems like', 'appears to', 'not tested', 'untested',
];

/**
 * Calculate confidence as a 0-100 percentage based on worker result
 */
export function calculateConfidence(result: WorkerResult): ConfidencePercent {
  // If agent self-reported a percent, use it (clamped)
  if (typeof result.confidencePercent === 'number') {
    return Math.max(0, Math.min(100, result.confidencePercent));
  }

  // If legacy ConfidenceLevel exists, map to percent
  if (result.confidence !== undefined) {
    return [0, 33, 66, 100][result.confidence] ?? 0;
  }

  // Auto-calculate based on heuristics
  if (!result.success || result.error) {
    return 0;
  }

  let score = 100;

  // No files changed → might be incomplete
  if (result.filesChanged.length === 0) {
    score -= 25;
  }

  // Very short output → might be incomplete
  if (result.output.length < 100) {
    score -= 20;
  }

  // Uncertainty words in summary + first 2000 chars of output
  const textToScan = (result.summary + ' ' + result.output.slice(0, 2000)).toLowerCase();
  for (const word of UNCERTAINTY_WORDS) {
    if (textToScan.includes(word)) {
      score -= 15;
    }
  }

  // Explicit halt reason
  if (result.haltReason) {
    score -= 30;
  }

  return Math.max(0, Math.min(100, score));
}

/**
 * Update confidence tracker with new result
 */
export function updateConfidenceTracker(
  sessionId: string,
  result: WorkerResult,
  attempt: number
): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  const confidence = calculateConfidence(result);

  if (!session.confidenceTracker) {
    session.confidenceTracker = {
      history: [],
      streakCount: 0,
      lastConfidence: confidence,
    };
  }

  const tracker = session.confidenceTracker;
  const haltTriggered = confidence < CONFIDENCE_THRESHOLDS.HALT;

  // Add to history
  tracker.history.push({
    attempt,
    confidence,
    timestamp: Date.now(),
    action: result.summary.slice(0, 100),
    haltTriggered,
  });

  // Update streak count
  if (confidence < CONFIDENCE_THRESHOLDS.HALT) {
    tracker.streakCount += 1;
  } else {
    tracker.streakCount = 0; // Reset on good confidence
  }

  tracker.lastConfidence = confidence;

  console.log(`[ConfidenceTracker] Session ${sessionId}: confidence=${confidence}%, streak=${tracker.streakCount}${haltTriggered ? ' [HALT]' : ''}`);
}

/**
 * Check if confidence has degraded significantly
 * Returns true if intervention is needed
 */
export function needsConfidenceIntervention(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session?.confidenceTracker) return false;

  const tracker = session.confidenceTracker;

  // Trigger on 3+ consecutive low confidence results
  if (tracker.streakCount >= 3) {
    console.warn(`[ConfidenceTracker] Session ${sessionId}: Low confidence streak detected (${tracker.streakCount})`);
    return true;
  }

  // Trigger on confidence drop from PROCEED to below HALT
  if (tracker.history.length >= 2) {
    const recent = tracker.history.slice(-2);
    if (recent[0].confidence >= CONFIDENCE_THRESHOLDS.PROCEED && recent[1].confidence < CONFIDENCE_THRESHOLDS.HALT) {
      console.warn(`[ConfidenceTracker] Session ${sessionId}: Sudden confidence drop (${recent[0].confidence}%→${recent[1].confidence}%)`);
      return true;
    }
  }

  return false;
}

/**
 * Get confidence summary for reporting
 */
export function getConfidenceSummary(sessionId: string): string {
  const session = sessions.get(sessionId);
  if (!session?.confidenceTracker) {
    return 'No confidence data';
  }

  const tracker = session.confidenceTracker;
  const avgConfidence = tracker.history.length > 0
    ? tracker.history.reduce((sum, h) => sum + h.confidence, 0) / tracker.history.length
    : 0;

  return [
    `Last: ${tracker.lastConfidence}%`,
    `Average: ${Math.round(avgConfidence)}%`,
    `Low streak: ${tracker.streakCount}`,
    `History: ${tracker.history.map(h => `${h.confidence}%`).join('→')}`,
  ].join(' | ');
}

// ============================================
// Fresh Context Retry Strategy
// ============================================

/**
 * Track failure and decide if fresh context is needed
 * Call this when worker/reviewer iteration fails
 */
export function trackFailure(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.worker.failureStreak += 1;

  console.log(`[FreshContext] Session ${sessionId}: failure streak = ${session.worker.failureStreak}`);

  // Check if fresh context threshold reached
  const threshold = session.worker.freshContextAfter ?? 2;
  if (session.worker.failureStreak >= threshold) {
    session.worker.useFreshContext = true;
    console.log(`[FreshContext] Session ${sessionId}: Fresh context triggered after ${session.worker.failureStreak} failures`);
  }
}

/**
 * Reset failure streak on success
 */
export function resetFailureStreak(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.worker.failureStreak = 0;
  session.worker.useFreshContext = false;
}

/**
 * Check if fresh context should be used
 */
export function shouldUseFreshContext(sessionId: string): boolean {
  const session = sessions.get(sessionId);
  if (!session) return false;

  return session.worker.useFreshContext ?? false;
}

/**
 * Mark that fresh context was consumed (reset flag)
 */
export function consumeFreshContext(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  session.worker.useFreshContext = false;
  // Don't reset failure streak - keep tracking
}

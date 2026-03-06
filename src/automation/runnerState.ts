// ============================================
// OpenSwarm - Runner State Utilities
// Task state persistence + project info query
// ============================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';

/** Check if a resolved path matches or is under any enabled project path */
export function isPathEnabled(resolvedPath: string, enabledProjects: Set<string>): boolean {
  if (enabledProjects.has(resolvedPath)) return true;
  for (const enabled of enabledProjects) {
    if (resolvedPath.startsWith(enabled + '/')) return true;
  }
  return false;
}

export const TASK_STATE_FILE = join(homedir(), '.claude', 'openswarm-task-state.json');
export const PIPELINE_HISTORY_FILE = join(homedir(), '.claude', 'openswarm-pipeline-history.json');
export const REJECTION_STATE_FILE = join(homedir(), '.claude', 'openswarm-rejection-state.json');
export const DECOMPOSITION_STATE_FILE = join(homedir(), '.claude', 'openswarm-decomposition-state.json');
const MAX_PIPELINE_HISTORY = 100;
const MAX_REJECTION_ATTEMPTS = 3;

export interface TaskState {
  completedTaskIds: Set<string>;
  failedTaskCounts: Map<string, number>;
  failedTaskRetryTimes: Map<string, number>; // issueId → next retry timestamp (ms)
}

export function loadTaskState(state: TaskState): void {
  try {
    if (!existsSync(TASK_STATE_FILE)) return;
    const raw = readFileSync(TASK_STATE_FILE, 'utf8');
    const data = JSON.parse(raw) as {
      completed?: string[];
      failed?: Record<string, number>;
      retryTimes?: Record<string, number>;
    };
    if (Array.isArray(data.completed)) {
      for (const id of data.completed) state.completedTaskIds.add(id);
    }
    if (data.failed && typeof data.failed === 'object') {
      for (const [id, count] of Object.entries(data.failed)) {
        state.failedTaskCounts.set(id, count as number);
      }
    }
    if (data.retryTimes && typeof data.retryTimes === 'object') {
      for (const [id, time] of Object.entries(data.retryTimes)) {
        state.failedTaskRetryTimes.set(id, time as number);
      }
    }
    console.log(`[AutonomousRunner] Loaded task state: ${state.completedTaskIds.size} completed, ${state.failedTaskCounts.size} failed`);
  } catch (err) {
    console.warn('[AutonomousRunner] Failed to load task state:', err);
  }
}

export function saveTaskState(state: TaskState): void {
  try {
    const data = {
      completed: Array.from(state.completedTaskIds),
      failed: Object.fromEntries(state.failedTaskCounts),
      retryTimes: Object.fromEntries(state.failedTaskRetryTimes),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(TASK_STATE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('[AutonomousRunner] Failed to save task state:', err);
  }
}

// ============================================
// Pipeline History (persistent, time-ordered)
// ============================================

export interface PipelineHistoryEntry {
  sessionId: string;
  issueIdentifier?: string;
  issueId?: string;
  taskTitle: string;
  projectName?: string;
  projectPath?: string;
  success: boolean;
  finalStatus: string;
  iterations: number;
  totalDuration: number;
  stages: { stage: string; success: boolean; duration: number }[];
  cost?: { costUsd: number; inputTokens: number; outputTokens: number };
  prUrl?: string;
  reviewerFeedback?: string; // Reviewer rejection reason (for debugging)
  completedAt: string; // ISO-8601
}

// ============================================
// Rejection State (track reviewer rejections per issue)
// ============================================

export interface RejectionEntry {
  issueId: string;
  count: number;
  lastRejection: string; // ISO-8601
  reasons: string[]; // Last N rejection reasons
}

export interface RejectionState {
  rejections: Record<string, RejectionEntry>;
  updatedAt: string;
}

// In-memory cache
let rejectionState: RejectionState | null = null;

function ensureRejectionStateLoaded(): RejectionState {
  if (rejectionState !== null) return rejectionState;
  try {
    if (existsSync(REJECTION_STATE_FILE)) {
      const raw = readFileSync(REJECTION_STATE_FILE, 'utf8');
      rejectionState = JSON.parse(raw) as RejectionState;
    } else {
      rejectionState = { rejections: {}, updatedAt: new Date().toISOString() };
    }
  } catch {
    rejectionState = { rejections: {}, updatedAt: new Date().toISOString() };
  }
  return rejectionState;
}

export function getRejectionCount(issueId: string): number {
  const state = ensureRejectionStateLoaded();
  return state.rejections[issueId]?.count || 0;
}

export function incrementRejection(issueId: string, reason: string): number {
  const state = ensureRejectionStateLoaded();
  const entry = state.rejections[issueId] || {
    issueId,
    count: 0,
    lastRejection: new Date().toISOString(),
    reasons: [],
  };

  entry.count++;
  entry.lastRejection = new Date().toISOString();
  entry.reasons.push(reason);

  // Keep only last 5 reasons
  if (entry.reasons.length > 5) {
    entry.reasons = entry.reasons.slice(-5);
  }

  state.rejections[issueId] = entry;
  state.updatedAt = new Date().toISOString();

  // Persist to disk
  try {
    writeFileSync(REJECTION_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[RejectionState] Failed to save:', err);
  }

  return entry.count;
}

export function clearRejection(issueId: string): void {
  const state = ensureRejectionStateLoaded();
  delete state.rejections[issueId];
  state.updatedAt = new Date().toISOString();

  try {
    writeFileSync(REJECTION_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[RejectionState] Failed to save:', err);
  }
}

export function isRejectionLimitReached(issueId: string): boolean {
  return getRejectionCount(issueId) >= MAX_REJECTION_ATTEMPTS;
}

export function getAllRejectionEntries(): RejectionEntry[] {
  const state = ensureRejectionStateLoaded();
  return Object.values(state.rejections);
}

// ============================================
// Decomposition State (track parent-child relationships and daily limits)
// ============================================

export interface DecompositionEntry {
  issueId: string;
  parentId?: string; // Parent issue ID (if this is a sub-issue)
  depth: number; // 0 = root, 1 = child, 2 = grandchild, etc.
  childrenCount: number; // Number of sub-issues created from this issue
  createdAt: string; // ISO-8601
}

export interface DecompositionState {
  decompositions: Record<string, DecompositionEntry>;
  dailyCreationCount: number;
  dailyCreationDate: string; // YYYY-MM-DD
  updatedAt: string;
}

// In-memory cache
let decompositionState: DecompositionState | null = null;

function ensureDecompositionStateLoaded(): DecompositionState {
  if (decompositionState !== null) return decompositionState;
  try {
    if (existsSync(DECOMPOSITION_STATE_FILE)) {
      const raw = readFileSync(DECOMPOSITION_STATE_FILE, 'utf8');
      decompositionState = JSON.parse(raw) as DecompositionState;
      // Reset daily counter if date changed
      const today = new Date().toISOString().split('T')[0];
      if (decompositionState.dailyCreationDate !== today) {
        decompositionState.dailyCreationCount = 0;
        decompositionState.dailyCreationDate = today;
      }
    } else {
      const today = new Date().toISOString().split('T')[0];
      decompositionState = {
        decompositions: {},
        dailyCreationCount: 0,
        dailyCreationDate: today,
        updatedAt: new Date().toISOString(),
      };
    }
  } catch {
    const today = new Date().toISOString().split('T')[0];
    decompositionState = {
      decompositions: {},
      dailyCreationCount: 0,
      dailyCreationDate: today,
      updatedAt: new Date().toISOString(),
    };
  }
  return decompositionState;
}

export function getDecompositionDepth(issueId: string): number {
  const state = ensureDecompositionStateLoaded();
  return state.decompositions[issueId]?.depth || 0;
}

export function getChildrenCount(issueId: string): number {
  const state = ensureDecompositionStateLoaded();
  return state.decompositions[issueId]?.childrenCount || 0;
}

export function getDailyCreationCount(): number {
  const state = ensureDecompositionStateLoaded();
  return state.dailyCreationCount;
}

export function canCreateMoreIssues(dailyLimit: number): boolean {
  return getDailyCreationCount() < dailyLimit;
}

export function registerDecomposition(
  issueId: string,
  parentId: string | undefined,
  childrenIds: string[]
): void {
  const state = ensureDecompositionStateLoaded();

  // Calculate depth
  const parentDepth = parentId ? (state.decompositions[parentId]?.depth || 0) : 0;
  const depth = parentDepth + 1;

  // Update parent's children count
  if (parentId) {
    const parentEntry = state.decompositions[parentId] || {
      issueId: parentId,
      parentId: undefined,
      depth: parentDepth,
      childrenCount: 0,
      createdAt: new Date().toISOString(),
    };
    parentEntry.childrenCount += childrenIds.length;
    state.decompositions[parentId] = parentEntry;
  }

  // Register children
  for (const childId of childrenIds) {
    state.decompositions[childId] = {
      issueId: childId,
      parentId,
      depth,
      childrenCount: 0,
      createdAt: new Date().toISOString(),
    };
  }

  // Increment daily count
  state.dailyCreationCount += childrenIds.length;
  state.updatedAt = new Date().toISOString();

  // Persist to disk
  try {
    writeFileSync(DECOMPOSITION_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[DecompositionState] Failed to save:', err);
  }
}

// ============================================
// Pipeline History (persistent, time-ordered)
// ============================================

// In-memory cache (loaded once at startup, appended per completion)
let pipelineHistory: PipelineHistoryEntry[] | null = null;

function ensureHistoryLoaded(): PipelineHistoryEntry[] {
  if (pipelineHistory !== null) return pipelineHistory;
  try {
    if (existsSync(PIPELINE_HISTORY_FILE)) {
      const raw = readFileSync(PIPELINE_HISTORY_FILE, 'utf8');
      pipelineHistory = JSON.parse(raw) as PipelineHistoryEntry[];
    } else {
      pipelineHistory = [];
    }
  } catch {
    pipelineHistory = [];
  }
  return pipelineHistory;
}

export function appendPipelineHistory(entry: PipelineHistoryEntry): void {
  const history = ensureHistoryLoaded();
  history.unshift(entry); // newest first
  if (history.length > MAX_PIPELINE_HISTORY) {
    history.length = MAX_PIPELINE_HISTORY;
  }
  try {
    writeFileSync(PIPELINE_HISTORY_FILE, JSON.stringify(history, null, 2), 'utf8');
  } catch (err) {
    console.warn('[PipelineHistory] Failed to save:', err);
  }
}

export function getPipelineHistory(limit = 50): PipelineHistoryEntry[] {
  return ensureHistoryLoaded().slice(0, limit);
}

// ============================================
// Project Info Query (for dashboard)
// ============================================

export interface ProjectInfo {
  path: string;
  name: string;
  enabled: boolean;
  running: { id: string; title: string; priority: number }[];
  queued: { id: string; title: string; priority: number }[];
  pending: { id: string; title: string; priority: number; issueIdentifier?: string; linearState?: string }[];
}

type RunningEntry = { task: TaskItem; projectPath: string };
type QueuedEntry = { task: TaskItem; projectPath: string };

export function buildProjectsInfo(
  fetchedTasks: TaskItem[],
  running: RunningEntry[],
  queued: QueuedEntry[],
  pathCache: Map<string, string>,
  enabledProjects: Set<string>,
): ProjectInfo[] {
  const projectMap = new Map<string, { name: string; path: string | null; tasks: TaskItem[] }>();

  for (const task of fetchedTasks) {
    const projName = task.linearProject?.name || '(unknown)';
    if (!projectMap.has(projName)) {
      projectMap.set(projName, { name: projName, path: pathCache.get(projName) ?? null, tasks: [] });
    }
    projectMap.get(projName)!.tasks.push(task);
  }

  for (const r of running) {
    const projName = r.task.linearProject?.name || '(unknown)';
    if (!projectMap.has(projName)) {
      projectMap.set(projName, { name: projName, path: r.projectPath, tasks: [] });
    } else if (!projectMap.get(projName)!.path) {
      projectMap.get(projName)!.path = r.projectPath;
    }
  }
  for (const q of queued) {
    const projName = q.task.linearProject?.name || '(unknown)';
    if (!projectMap.has(projName)) {
      projectMap.set(projName, { name: projName, path: q.projectPath, tasks: [] });
    } else if (!projectMap.get(projName)!.path) {
      projectMap.get(projName)!.path = q.projectPath;
    }
  }

  const activeIds = new Set([
    ...running.map(r => r.task.issueId || r.task.id),
    ...queued.map(q => q.task.issueId || q.task.id),
  ]);

  return Array.from(projectMap.values()).map(proj => {
    const projectPath = proj.path ?? '';
    return {
      path: projectPath,
      name: proj.name,
      enabled: Boolean(projectPath) && isPathEnabled(projectPath, enabledProjects),
      running: running.filter(r => r.task.linearProject?.name === proj.name)
        .map(r => ({ id: r.task.id, title: r.task.title, priority: r.task.priority })),
      queued: queued.filter(q => q.task.linearProject?.name === proj.name)
        .map(q => ({ id: q.task.id, title: q.task.title, priority: q.task.priority })),
      pending: proj.tasks.filter(t => !activeIds.has(t.issueId || t.id))
        .map(t => ({ id: t.id, title: t.title, priority: t.priority, issueIdentifier: t.issueIdentifier || t.issueId, linearState: t.linearState })),
    };
  });
}

// ============================================
// Exponential Backoff for Failed Task Retries
// ============================================

const BACKOFF_MINUTES = [10, 30, 60, 120]; // 10min, 30min, 1h, 2h

/**
 * Calculate backoff delay in milliseconds based on attempt number.
 * @param attemptNumber - 1-indexed attempt number (1 = first failure)
 * @returns Delay in milliseconds
 */
export function calculateBackoffTime(attemptNumber: number): number {
  const index = Math.min(attemptNumber - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[index] * 60 * 1000;
}

/**
 * Check if a task can be retried now (based on scheduled retry time).
 * @param issueId - Issue ID to check
 * @param retryTimes - Map of issueId → next retry timestamp
 * @returns true if retry is allowed now, false if still in backoff period
 */
export function canRetryNow(issueId: string, retryTimes: Map<string, number>): boolean {
  const nextRetryTime = retryTimes.get(issueId);
  if (!nextRetryTime) return true; // No backoff scheduled
  return Date.now() >= nextRetryTime;
}

/**
 * Set next retry time for a failed task using exponential backoff.
 * @param issueId - Issue ID
 * @param attemptNumber - Current attempt number (1-indexed)
 * @param retryTimes - Map to update
 * @returns Next retry timestamp (ms)
 */
export function setRetryTime(
  issueId: string,
  attemptNumber: number,
  retryTimes: Map<string, number>
): number {
  const delayMs = calculateBackoffTime(attemptNumber);
  const nextRetryTime = Date.now() + delayMs;
  retryTimes.set(issueId, nextRetryTime);
  return nextRetryTime;
}

/**
 * Clear retry time for a task (on success or manual recovery).
 * @param issueId - Issue ID
 * @param retryTimes - Map to update
 */
export function clearRetryTime(issueId: string, retryTimes: Map<string, number>): void {
  retryTimes.delete(issueId);
}

/**
 * Get next retry time for a task.
 * @param issueId - Issue ID
 * @param retryTimes - Map to query
 * @returns Next retry timestamp (ms) or undefined if not scheduled
 */
export function getRetryTime(issueId: string, retryTimes: Map<string, number>): number | undefined {
  return retryTimes.get(issueId);
}

/**
 * Format retry time as human-readable string.
 * @param timestamp - Timestamp in milliseconds
 * @returns Formatted string like "in 15 minutes" or "in 2 hours"
 */
export function formatRetryTime(timestamp: number): string {
  const now = Date.now();
  const diffMs = timestamp - now;
  if (diffMs <= 0) return 'now';

  const minutes = Math.ceil(diffMs / (60 * 1000));
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (remainingMinutes === 0) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in ${hours}h ${remainingMinutes}m`;
}

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
const MAX_PIPELINE_HISTORY = 100;
const MAX_REJECTION_ATTEMPTS = 3;

export interface TaskState {
  completedTaskIds: Set<string>;
  failedTaskCounts: Map<string, number>;
}

export function loadTaskState(state: TaskState): void {
  try {
    if (!existsSync(TASK_STATE_FILE)) return;
    const raw = readFileSync(TASK_STATE_FILE, 'utf8');
    const data = JSON.parse(raw) as { completed?: string[]; failed?: Record<string, number> };
    if (Array.isArray(data.completed)) {
      for (const id of data.completed) state.completedTaskIds.add(id);
    }
    if (data.failed && typeof data.failed === 'object') {
      for (const [id, count] of Object.entries(data.failed)) {
        state.failedTaskCounts.set(id, count as number);
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

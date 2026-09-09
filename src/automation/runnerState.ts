// ============================================
// OpenSwarm - Runner State Utilities
// Task state persistence + project info query
// ============================================

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, relative, sep } from 'node:path';
import { taskEventKey, type TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipelineTypes.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';
import { withFileLock } from '../support/fileLock.js';

/**
 * Write-temp-then-rename instead of an in-place write, so a crash mid-write (or
 * two processes racing on the same path) never leaves a truncated/corrupt JSON
 * state file — a reader always sees either the old complete file or the new
 * complete one, never a half-written one. The single-instance daemon guard
 * (service.ts, INT-2570) is the primary defense against concurrent writers on
 * these specific files; this is the cheap defense-in-depth for the crash case.
 */
/** Check if a resolved path matches or is under any enabled project path */
export function isPathEnabled(resolvedPath: string, enabledProjects: Set<string>): boolean {
  for (const enabled of enabledProjects) {
    const rel = relative(enabled, resolvedPath);
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`)
      && !rel.startsWith(`..${sep}`))) {
      return true;
    }
  }
  return false;
}

// ── Paths ──────────────────────────────────

const OPENSWARM_DIR = join(homedir(), '.openswarm');

export const TASK_STATE_FILE = join(OPENSWARM_DIR, 'task-state.json');
export const PIPELINE_HISTORY_FILE = join(OPENSWARM_DIR, 'pipeline-history.json');
export const REJECTION_STATE_FILE = join(OPENSWARM_DIR, 'rejection-state.json');
export const DECOMPOSITION_STATE_FILE = join(OPENSWARM_DIR, 'decomposition-state.json');
export const DAILY_PACE_FILE = join(OPENSWARM_DIR, 'daily-pace.json');
export const PROJECT_SELECTION_FILE = join(OPENSWARM_DIR, 'project-selection.json');

// ── Daily Pace ─────────────────────────────

interface ProjectPaceEntry {
  projectName: string;
  windowCount: number;
  windowStart: string;
}

interface PaceState {
  projects: Record<string, ProjectPaceEntry>;
}

interface DailyPaceState {
  date: string;
  completedCount: number;
}

function ensurePaceDir(): void {
  mkdirSync(OPENSWARM_DIR, { recursive: true });
}

function ensureParentDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

let paceState: PaceState | null = null;

function ensurePaceLoaded(): PaceState {
  if (paceState !== null) return paceState;
  try {
    if (existsSync(DAILY_PACE_FILE)) {
      const raw = readFileSync(DAILY_PACE_FILE, 'utf8');
      paceState = JSON.parse(raw) as PaceState;
    } else {
      paceState = { projects: {} };
    }
  } catch {
    paceState = { projects: {} };
  }
  return paceState;
}

export function getProjectWindowCount(projectName: string): number {
  const state = ensurePaceLoaded();
  const entry = state.projects[projectName];
  if (!entry) return 0;
  const windowStart = new Date(entry.windowStart);
  const now = new Date();
  const hoursDiff = (now.getTime() - windowStart.getTime()) / (1000 * 60 * 60);
  if (hoursDiff > 24) return 0;
  return entry.windowCount;
}

export function canProjectAcceptTask(projectName: string, cap: number): boolean {
  return getProjectWindowCount(projectName) < cap;
}

export function getTotalWindowCount(): number {
  let total = 0;
  for (const projectName of Object.keys(ensurePaceLoaded().projects)) {
    total += getProjectWindowCount(projectName);
  }
  return total;
}

export function getDailyCompletedCount(): number {
  try {
    if (existsSync(DAILY_PACE_FILE)) {
      const raw = readFileSync(DAILY_PACE_FILE, 'utf8');
      const state = JSON.parse(raw) as DailyPaceState;
      const today = new Date().toLocaleDateString('en-CA');
      if (state.date === today) return state.completedCount;
    }
  } catch {
    // ignore
  }
  return 0;
}

/**
 * Increment the daily completed count.
 */
export function incrementDailyCompleted(): void {
  ensurePaceDir();
  void withFileLock(DAILY_PACE_FILE + '.lock', async () => {
    let state: DailyPaceState;
    try {
      if (existsSync(DAILY_PACE_FILE)) {
        const raw = readFileSync(DAILY_PACE_FILE, 'utf8');
        state = JSON.parse(raw) as DailyPaceState;
      } else {
        state = { date: '', completedCount: 0 };
      }
    } catch {
      state = { date: '', completedCount: 0 };
    }
    const today = new Date().toLocaleDateString('en-CA');
    if (state.date !== today) {
      state.date = today;
      state.completedCount = 0;
    }
    state.completedCount++;
    atomicWriteFileSync(DAILY_PACE_FILE, JSON.stringify(state));
  });
}

/**
 * Check if the system can accept more tasks based on daily limit.
 */
export function canAcceptMoreTasks(dailyLimit: number): boolean {
  return getDailyCompletedCount() < dailyLimit;
}

// ── Pipeline History ───────────────────────

export interface PipelineHistoryEntry {
  issueId: string;
  pipelineId: string;
  startedAt: string;
  completedAt: string;
  result: PipelineResult;
  failureCause?: string;
}

export interface PipelineHistory {
  entries: PipelineHistoryEntry[];
}

let pipelineHistory: PipelineHistory | null = null;

function ensurePipelineHistoryLoaded(): PipelineHistory {
  if (pipelineHistory !== null) return pipelineHistory;
  try {
    if (existsSync(PIPELINE_HISTORY_FILE)) {
      const raw = readFileSync(PIPELINE_HISTORY_FILE, 'utf8');
      pipelineHistory = JSON.parse(raw) as PipelineHistory;
    } else {
      pipelineHistory = { entries: [] };
    }
  } catch {
    pipelineHistory = { entries: [] };
  }
  return pipelineHistory;
}

export function addPipelineHistory(entry: PipelineHistoryEntry): void {
  void withFileLock(PIPELINE_HISTORY_FILE + '.lock', async () => {
    const history = ensurePipelineHistoryLoaded();
    history.entries.push(entry);
    // Keep last 100 entries
    if (history.entries.length > 100) {
      history.entries = history.entries.slice(-100);
    }
    try {
      ensureParentDir(PIPELINE_HISTORY_FILE);
      atomicWriteFileSync(PIPELINE_HISTORY_FILE, JSON.stringify(history, null, 2));
    } catch (err) {
      console.warn('[PipelineHistory] Failed to save:', err);
    }
  });
}

export function getPipelineHistory(): PipelineHistoryEntry[] {
  return ensurePipelineHistoryLoaded().entries;
}

export function getPipelineHistoryForIssue(issueId: string): PipelineHistoryEntry[] {
  return ensurePipelineHistoryLoaded().entries.filter(e => e.issueId === issueId);
}

export function getLastPipelineResult(issueId: string): PipelineResult | undefined {
  const entries = getPipelineHistoryForIssue(issueId);
  return entries.length > 0 ? entries[entries.length - 1].result : undefined;
}

export function aggregateFailureCauses(limit: number = 10): Array<{ cause: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entry of ensurePipelineHistoryLoaded().entries) {
    if (entry.failureCause) {
      counts.set(entry.failureCause, (counts.get(entry.failureCause) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([cause, count]) => ({ cause, count }));
}

export function classifyFailureCause(result: PipelineResult): string | undefined {
  if (result.success) return undefined;
  if (result.finalStatus === 'rejected') return 'review_rejected';
  if (result.finalStatus === 'failed') return 'execution_failed';
  if (result.finalStatus === 'error') return 'system_error';
  if (result.finalStatus === 'cancelled') return 'cancelled';
  return 'unknown';
}

// ── Rejection State ──────────────────────────

export interface RejectionEntry {
  issueId: string;
  count: number;
  lastRejection: string; // ISO-8601
  reasons: string[];
}

export interface RejectionState {
  rejections: Record<string, RejectionEntry>;
  updatedAt: string;
}

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
  return state.rejections[issueId]?.count ?? 0;
}

export async function recordRejection(issueId: string, reason: string): Promise<number> {
  const state = ensureRejectionStateLoaded();

  let entry = state.rejections[issueId];
  if (!entry) {
    entry = {
      issueId,
      count: 0,
      lastRejection: new Date().toISOString(),
      reasons: [],
    };
  }

  entry.count++;
  entry.lastRejection = new Date().toISOString();
  entry.reasons.push(reason);

  // Keep only last 5 reasons
  if (entry.reasons.length > 5) {
    entry.reasons = entry.reasons.slice(-5);
  }

  state.rejections[issueId] = entry;
  state.updatedAt = new Date().toISOString();

  // Persist to disk with cross-process lock
  try {
    ensureParentDir(REJECTION_STATE_FILE);
    await withFileLock(REJECTION_STATE_FILE + '.lock', async () => {
      atomicWriteFileSync(REJECTION_STATE_FILE, JSON.stringify(state, null, 2));
    });
  } catch (err) {
    console.warn('[RejectionState] Failed to save:', err);
  }

  return entry.count;
}

export function getRejectionReasons(issueId: string): string[] {
  const state = ensureRejectionStateLoaded();
  return state.rejections[issueId]?.reasons ?? [];
}

export function getRejectionState(): RejectionState {
  return ensureRejectionStateLoaded();
}

// ── Decomposition State ──────────────────────

export interface DecompositionEntry {
  issueId: string;
  decomposedAt: string;
  subtaskCount: number;
}

export interface DecompositionState {
  decompositions: Record<string, DecompositionEntry>;
  dailyCreationCount: number;
  dailyCreationDate: string;
}

let decompositionState: DecompositionState | null = null;

function ensureDecompositionStateLoaded(): DecompositionState {
  if (decompositionState !== null) return decompositionState;
  try {
    if (existsSync(DECOMPOSITION_STATE_FILE)) {
      const raw = readFileSync(DECOMPOSITION_STATE_FILE, 'utf8');
      decompositionState = JSON.parse(raw) as DecompositionState;
      const today = new Date().toLocaleDateString('en-CA');
      if (decompositionState.dailyCreationDate !== today) {
        decompositionState.dailyCreationCount = 0;
        decompositionState.dailyCreationDate = today;
      }
    } else {
      const today = new Date().toLocaleDateString('en-CA');
      decompositionState = {
        decompositions: {},
        dailyCreationCount: 0,
        dailyCreationDate: today,
      };
    }
  } catch {
    const today = new Date().toLocaleDateString('en-CA');
    decompositionState = {
      decompositions: {},
      dailyCreationCount: 0,
      dailyCreationDate: today,
    };
  }
  return decompositionState;
}

export function recordDecomposition(issueId: string, subtaskCount: number): void {
  void withFileLock(DECOMPOSITION_STATE_FILE + '.lock', async () => {
    const state = ensureDecompositionStateLoaded();
    state.decompositions[issueId] = {
      issueId,
      decomposedAt: new Date().toISOString(),
      subtaskCount,
    };
    state.dailyCreationCount++;
    try {
      ensureParentDir(DECOMPOSITION_STATE_FILE);
      atomicWriteFileSync(DECOMPOSITION_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[DecompositionState] Failed to save:', err);
    }
  });
}

export function getDecompositionCount(): number {
  return ensureDecompositionStateLoaded().dailyCreationCount;
}

export function getDecomposition(issueId: string): DecompositionEntry | undefined {
  return ensureDecompositionStateLoaded().decompositions[issueId];
}

// ── Project Selection ────────────────────────

export interface ProjectSelectionEntry {
  projectName: string;
  lastSelected: string;
  selectionCount: number;
}

export interface ProjectSelectionState {
  projects: Record<string, ProjectSelectionEntry>;
}

let projectSelectionState: ProjectSelectionState | null = null;

function ensureProjectSelectionLoaded(): ProjectSelectionState {
  if (projectSelectionState !== null) return projectSelectionState;
  try {
    if (existsSync(PROJECT_SELECTION_FILE)) {
      const raw = readFileSync(PROJECT_SELECTION_FILE, 'utf8');
      projectSelectionState = JSON.parse(raw) as ProjectSelectionState;
    } else {
      projectSelectionState = { projects: {} };
    }
  } catch {
    projectSelectionState = { projects: {} };
  }
  return projectSelectionState;
}

export function recordProjectSelection(projectName: string): void {
  void withFileLock(PROJECT_SELECTION_FILE + '.lock', async () => {
    const state = ensureProjectSelectionLoaded();
    const entry = state.projects[projectName] || {
      projectName,
      lastSelected: new Date().toISOString(),
      selectionCount: 0,
    };
    entry.lastSelected = new Date().toISOString();
    entry.selectionCount++;
    state.projects[projectName] = entry;
    try {
      ensureParentDir(PROJECT_SELECTION_FILE);
      atomicWriteFileSync(PROJECT_SELECTION_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[ProjectSelection] Failed to save:', err);
    }
  });
}

export function loadProjectSelection(): ProjectSelectionState {
  return ensureProjectSelectionLoaded();
}

export function saveProjectSelection(state: ProjectSelectionState): void {
  void withFileLock(PROJECT_SELECTION_FILE + '.lock', async () => {
    try {
      ensureParentDir(PROJECT_SELECTION_FILE);
      atomicWriteFileSync(PROJECT_SELECTION_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[ProjectSelection] Failed to save:', err);
    }
  });
}

// ── Task State ───────────────────────────────

export interface TaskStateEntry {
  issueId: string;
  pipelineId?: string;
  startedAt?: string;
  completedAt?: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: PipelineResult;
}

export interface TaskState {
  tasks: Record<string, TaskStateEntry>;
}

let taskState: TaskState | null = null;

function ensureTaskStateLoaded(): TaskState {
  if (taskState !== null) return taskState;
  try {
    if (existsSync(TASK_STATE_FILE)) {
      const raw = readFileSync(TASK_STATE_FILE, 'utf8');
      taskState = JSON.parse(raw) as TaskState;
    } else {
      taskState = { tasks: {} };
    }
  } catch {
    taskState = { tasks: {} };
  }
  return taskState;
}

export function getTaskState(issueId: string): TaskStateEntry | undefined {
  return ensureTaskStateLoaded().tasks[issueId];
}

export function setTaskState(issueId: string, entry: TaskStateEntry): void {
  void withFileLock(TASK_STATE_FILE + '.lock', async () => {
    const state = ensureTaskStateLoaded();
    state.tasks[issueId] = entry;
    try {
      ensureParentDir(TASK_STATE_FILE);
      atomicWriteFileSync(TASK_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[TaskState] Failed to save:', err);
    }
  });
}

export function getAllTaskStates(): TaskStateEntry[] {
  return Object.values(ensureTaskStateLoaded().tasks);
}

// ── Project Info ─────────────────────────────

export interface ProjectInfo {
  name: string;
  path: string;
  enabled: boolean;
}

export function getProjectInfo(task: TaskItem, allowedProjects: string[]): ProjectInfo | undefined {
  if (!task.description) return undefined;
  for (const projectPath of allowedProjects) {
    if (task.description.includes(projectPath)) {
      return {
        name: basename(projectPath),
        path: projectPath,
        enabled: true,
      };
    }
  }
  return undefined;
}

export function pickPipelineFailureDetail(result: PipelineResult): string | undefined {
  if (result.success) return undefined;
  if (result.finalStatus === 'rejected') {
    return result.lastReviewFeedback ?? result.reviewResult?.feedback ?? 'Review rejected';
  }
  if (result.finalStatus === 'failed') {
    return result.lastExecutionError ?? 'Execution failed';
  }
  if (result.finalStatus === 'error') {
    return result.lastExecutionError ?? 'System error';
  }
  return undefined;
}
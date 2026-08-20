// ============================================
// OpenSwarm - Runner State Utilities
// Task state persistence + project info query
// ============================================

import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, isAbsolute, relative, sep } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipelineTypes.js';
import { atomicWriteFileSync } from '../support/atomicFile.js';

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
    if (rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) return true;
  }
  return false;
}

// State-file paths honor env overrides so tests (and alternate deployments) can
// redirect them off the real ~/.claude state — an unset override keeps the exact
// legacy path (backward compatible). Without this, every runner integration test
// wrote the LIVE daemon's state files (observed: ISSUE-1 accrued 184 phantom failures),
// which also made those tests flaky. Read at import; tests stub the env then re-import.
// NOTE: these use OPENSWARM_RUNNER_* names, deliberately DISTINCT from the canonical
// task store's OPENSWARM_TASK_STATE_FILE (src/taskState/store.ts) — this legacy runner
// state has a different schema ({completed,failed,retryTimes,…}), so sharing the env
// var would let one store silently overwrite the other's file. (INT-2543)
export const TASK_STATE_FILE = process.env.OPENSWARM_RUNNER_TASK_STATE_FILE || join(homedir(), '.claude', 'openswarm-task-state.json');
export const PIPELINE_HISTORY_FILE = process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE || join(homedir(), '.claude', 'openswarm-pipeline-history.json');
export const REJECTION_STATE_FILE = process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE || join(homedir(), '.claude', 'openswarm-rejection-state.json');
export const DECOMPOSITION_STATE_FILE = process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE || join(homedir(), '.claude', 'openswarm-decomposition-state.json');
export const DAILY_PACE_FILE = join(homedir(), '.openswarm', 'daily-pace.json');
export const PROJECT_SELECTION_FILE = join(homedir(), '.openswarm', 'project-selection.json');
const MAX_PIPELINE_HISTORY = 100;
const MAX_REJECTION_ATTEMPTS = 3;

// 5시간 롤링 윈도우 기반 프로젝트별 pace 제어
// Claude Max는 5시간마다 quota가 리프레시되므로 이에 맞춤

const WINDOW_MS = 5 * 60 * 60 * 1000; // 5시간

export interface ProjectPaceEntry {
  completedAt: string; // ISO-8601
  costUsd?: number;
}

export interface PaceState {
  projects: Record<string, ProjectPaceEntry[]>;
  updatedAt: string;
}

export interface DailyPaceState {
  completedToday: number;
  dateKey: string;
  lastCompletionAt: string | null;
  projectCounts: Record<string, number>;
}

let paceState: PaceState | null = null;

function ensurePaceDir(): void {
  const dir = join(homedir(), '.openswarm');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function ensureParentDir(file: string): void {
  mkdirSync(dirname(file), { recursive: true });
}

function ensurePaceLoaded(): PaceState {
  if (paceState) return paceState;
  try {
    if (existsSync(DAILY_PACE_FILE)) {
      const raw = readFileSync(DAILY_PACE_FILE, 'utf8');
      paceState = JSON.parse(raw) as PaceState;
      if (!paceState!.projects) paceState!.projects = {};
    } else {
      paceState = { projects: {}, updatedAt: new Date().toISOString() };
    }
  } catch {
    paceState = { projects: {}, updatedAt: new Date().toISOString() };
  }
  return paceState!;
}

function savePace(): void {
  try {
    ensurePaceDir();
    atomicWriteFileSync(DAILY_PACE_FILE, JSON.stringify(paceState, null, 2));
  } catch (err) {
    console.warn('[Pace] Failed to save:', err);
  }
}

// Persisted dashboard/CLI project selection so "disable all" survives a daemon
// restart (otherwise enabledProjects resets and the run-all fallback kicks back
// in). (INT-2208) `touched` mirrors AutonomousRunner.projectSelectionTouched.
export interface ProjectSelection {
  enabled: string[];
  touched: boolean;
}

export function loadProjectSelection(file: string = PROJECT_SELECTION_FILE): ProjectSelection {
  try {
    if (existsSync(file)) {
      const data = JSON.parse(readFileSync(file, 'utf8'));
      return { enabled: Array.isArray(data.enabled) ? data.enabled : [], touched: !!data.touched };
    }
  } catch {
    /* corrupt/unreadable → safe default below */
  }
  return { enabled: [], touched: false };
}

export function saveProjectSelection(sel: ProjectSelection, file: string = PROJECT_SELECTION_FILE): void {
  try {
    ensureParentDir(file);
    atomicWriteFileSync(file, JSON.stringify(sel, null, 2));
  } catch (err) {
    console.warn('[ProjectSelection] Failed to save:', err);
  }
}

function pruneOldEntries(entries: ProjectPaceEntry[]): ProjectPaceEntry[] {
  const cutoff = Date.now() - WINDOW_MS;
  return entries.filter(e => new Date(e.completedAt).getTime() > cutoff);
}

// Cap helpers (getProjectWindowCount / canProjectAcceptTask / getTotalWindowCount)
// were removed with the per-project 5h cap (INT-2317). Completion recording stays
// below — daily-pace.json remains useful as a cost/throughput telemetry trail.

export function recordProjectCompletion(projectName: string, costUsd?: number): void {
  const state = ensurePaceLoaded();
  if (!state.projects[projectName]) state.projects[projectName] = [];
  state.projects[projectName] = pruneOldEntries(state.projects[projectName]);
  state.projects[projectName].push({ completedAt: new Date().toISOString(), costUsd });
  state.updatedAt = new Date().toISOString();
  savePace();
  console.log(`[Pace] ${projectName}: ${state.projects[projectName].length} tasks in 5h window`);
}

export function getDailyPaceInfo(): DailyPaceState {
  const state = ensurePaceLoaded();
  const projectCounts: Record<string, number> = {};
  let totalToday = 0;
  let lastCompletion: string | null = null;
  const today = new Date().toLocaleDateString('en-CA');

  for (const [name, entries] of Object.entries(state.projects)) {
    const active = pruneOldEntries(entries);
    projectCounts[name] = active.length;
    for (const e of entries) {
      if (e.completedAt.startsWith(today)) totalToday++;
      if (!lastCompletion || e.completedAt > lastCompletion) lastCompletion = e.completedAt;
    }
  }

  return { completedToday: totalToday, dateKey: today, lastCompletionAt: lastCompletion, projectCounts };
}

/** Last failure detail per issue — injected into the next attempt's worker
 * prompt so a re-picked task doesn't repeat the exact mistake the reviewer
 * already called out (INT-2474). Capped and cleared on success. */
export interface LastFailureEntry {
  detail: string;
  at: string; // ISO-8601
}

const MAX_FAILURE_DETAIL_CHARS = 2000;

export interface TaskState {
  completedTaskIds: Set<string>;
  failedTaskCounts: Map<string, number>;
  failedTaskRetryTimes: Map<string, number>; // issueId → next retry timestamp (ms)
  lastFailureDetails: Map<string, LastFailureEntry>; // issueId → last failure feedback
}

/** Placeholder strings that carry zero diagnostic value — never persist these
 *  as a failure detail when something meaningful is available (INT-2504). */
const JUNK_DETAILS = new Set([
  'Unknown error',
  'No feedback provided',
  'No summary provided',
  'Worker execution failed',
  // t('common.fallback.noSummary') literals — the reviewer parse fallback emits
  // these as `feedback` and they leaked through as a persisted "detail" (live:
  // INT-2193 lastFailure === '(no summary)').
  '(no summary)',
  '(요약 없음)',
]);

/**
 * Pick the first MEANINGFUL failure detail. The old chain
 * (`workerResult.error || reviewResult.feedback`) let a junk-but-truthy error
 * string ("Unknown error" from the text-fallback parser) mask the reviewer's
 * actionable feedback — the retry then got injected with garbage (INT-2504).
 */
export function pickFailureDetail(candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    const trimmed = c?.trim();
    if (trimmed && !JUNK_DETAILS.has(trimmed)) return trimmed;
  }
  return undefined;
}

/** Prefer the stage that actually failed over earlier successful feedback. */
export function pickPipelineFailureDetail(result: PipelineResult): string | undefined {
  const testerFailure = result.testerResult?.success === false
    ? pickFailureDetail([
      result.testerResult.error,
      result.testerResult.output,
      result.testerResult.failedTests?.join(', '),
    ])
    : undefined;

  return pickFailureDetail([
    testerFailure,
    result.lastReviewFeedback,
    result.reviewResult?.feedback,
    result.workerResult?.error,
  ]);
}

export function recordLastFailureDetail(state: TaskState, issueId: string, detail: string): void {
  const trimmed = detail.trim();
  if (!trimmed) return;
  state.lastFailureDetails.set(issueId, {
    detail: trimmed.slice(0, MAX_FAILURE_DETAIL_CHARS),
    at: new Date().toISOString(),
  });
}

export function loadTaskState(state: TaskState): void {
  try {
    if (!existsSync(TASK_STATE_FILE)) return;
    const raw = readFileSync(TASK_STATE_FILE, 'utf8');
    const data = JSON.parse(raw) as {
      completed?: string[];
      failed?: Record<string, number>;
      retryTimes?: Record<string, number>;
      lastFailures?: Record<string, LastFailureEntry>;
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
    if (data.lastFailures && typeof data.lastFailures === 'object') {
      for (const [id, entry] of Object.entries(data.lastFailures)) {
        if (entry && typeof entry.detail === 'string') state.lastFailureDetails.set(id, entry);
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
      lastFailures: Object.fromEntries(state.lastFailureDetails),
      updatedAt: new Date().toISOString(),
    };
    ensureParentDir(TASK_STATE_FILE);
    atomicWriteFileSync(TASK_STATE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.warn('[AutonomousRunner] Failed to save task state:', err);
  }
}

// Pipeline History (persistent, time-ordered)

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
  failureCause?: FailureCause;
  completedAt: string; // ISO-8601
}

export type FailureCause = 'reviewer-reject' | 'infra' | 'rate-limit' | 'no-changes' | 'gate-fail' | 'timeout' | 'stuck' | 'cancelled';

export interface FailureCauseSignals {
  success: boolean;
  finalStatus: string;
  failureSignal?: 'gate-fail' | 'timeout' | 'stuck';
  workerFilesChanged?: number;
  reviewerDecision?: string;
}

/** Classify only explicit result fields; never infer from reviewer prose. */
export function classifyFailureCause(signals: FailureCauseSignals): FailureCause | undefined {
  if (signals.success) return undefined;
  if (signals.finalStatus === 'cancelled') return 'cancelled';
  if (signals.finalStatus === 'rate_limited') return 'rate-limit';
  if (signals.failureSignal === 'timeout') return 'timeout';
  if (signals.finalStatus === 'infra_error') return 'infra';
  if (signals.failureSignal === 'stuck') return 'stuck';
  if (signals.workerFilesChanged === 0) return 'no-changes';
  if (signals.failureSignal === 'gate-fail') return 'gate-fail';
  if (signals.finalStatus === 'rejected' || signals.reviewerDecision === 'reject' || signals.reviewerDecision === 'revise') return 'reviewer-reject';
  return undefined;
}

export function aggregateFailureCauses(entries: PipelineHistoryEntry[]): Record<FailureCause, number> {
  const counts: Record<FailureCause, number> = {
    'reviewer-reject': 0, infra: 0, 'rate-limit': 0, 'no-changes': 0,
    'gate-fail': 0, timeout: 0, stuck: 0, cancelled: 0,
  };
  for (const entry of entries) if (entry.failureCause) counts[entry.failureCause]++;
  return counts;
}

// Rejection State (track reviewer rejections per issue)

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
    ensureParentDir(REJECTION_STATE_FILE);
    atomicWriteFileSync(REJECTION_STATE_FILE, JSON.stringify(state, null, 2));
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
    ensureParentDir(REJECTION_STATE_FILE);
    atomicWriteFileSync(REJECTION_STATE_FILE, JSON.stringify(state, null, 2));
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

// Decomposition State (track parent-child relationships and daily limits)

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
        updatedAt: new Date().toISOString(),
      };
    }
  } catch {
    const today = new Date().toLocaleDateString('en-CA');
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

/**
 * Reset daily counter if date has changed (handles long-running service).
 * ensureDecompositionStateLoaded only checks date on initial disk load;
 * this function ensures the counter resets even when using the in-memory cache.
 */
function resetDailyCounterIfNeeded(): void {
  const state = ensureDecompositionStateLoaded();
  const today = new Date().toLocaleDateString('en-CA');
  if (state.dailyCreationDate !== today) {
    console.log(`[DecompositionState] Daily counter reset: ${state.dailyCreationCount} → 0 (date: ${state.dailyCreationDate} → ${today})`);
    state.dailyCreationCount = 0;
    state.dailyCreationDate = today;
    state.updatedAt = new Date().toISOString();
    try {
      ensureParentDir(DECOMPOSITION_STATE_FILE);
      atomicWriteFileSync(DECOMPOSITION_STATE_FILE, JSON.stringify(state, null, 2));
    } catch (err) {
      console.warn('[DecompositionState] Failed to persist daily reset:', err);
    }
  }
}

export function getDailyCreationCount(): number {
  resetDailyCounterIfNeeded();
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
  const now = new Date().toISOString();
  const parentDepth = parentId ? (state.decompositions[parentId]?.depth ?? 0) : -1;
  const issueDepth = parentDepth + 1;
  const uniqueChildren = [...new Set(childrenIds)];
  const existingChildren = new Set(
    Object.values(state.decompositions)
      .filter((entry) => entry.parentId === issueId)
      .map((entry) => entry.issueId),
  );

  // Validate the full batch before mutating the in-memory projection. A child
  // identity collision must leave no half-created parent entry behind.
  for (const childId of uniqueChildren) {
    const existing = state.decompositions[childId];
    if (existing && existing.parentId !== issueId) {
      throw new Error(`Decomposition child ${childId} is already owned by ${existing.parentId ?? 'no parent'}`);
    }
  }

  const existingIssue = state.decompositions[issueId];
  state.decompositions[issueId] = {
    issueId,
    parentId,
    depth: issueDepth,
    childrenCount: new Set([...existingChildren, ...uniqueChildren]).size,
    createdAt: existingIssue?.createdAt ?? now,
  };

  let newlyRegistered = 0;
  for (const childId of uniqueChildren) {
    const existing = state.decompositions[childId];
    if (!existingChildren.has(childId)) newlyRegistered++;
    state.decompositions[childId] = {
      issueId: childId,
      parentId: issueId,
      depth: issueDepth + 1,
      childrenCount: existing?.childrenCount ?? 0,
      createdAt: existing?.createdAt ?? now,
    };
  }

  // Retried deterministic children do not consume the daily budget twice.
  state.dailyCreationCount += newlyRegistered;
  state.updatedAt = new Date().toISOString();

  // Persist to disk
  try {
    ensureParentDir(DECOMPOSITION_STATE_FILE);
    atomicWriteFileSync(DECOMPOSITION_STATE_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.warn('[DecompositionState] Failed to save:', err);
  }
}

// Pipeline History (persistent, time-ordered)

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
    ensureParentDir(PIPELINE_HISTORY_FILE);
    atomicWriteFileSync(PIPELINE_HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch (err) {
    console.warn('[PipelineHistory] Failed to save:', err);
  }
}

export function getPipelineHistory(limit = 50): PipelineHistoryEntry[] {
  return ensureHistoryLoaded().slice(0, limit);
}

// Project Info Query (for dashboard)

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

// Exponential Backoff for Failed Task Retries

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

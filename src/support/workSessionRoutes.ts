// ============================================
// OpenSwarm - Cockpit session routes (INT-3402)
// ============================================
//
// The read surface behind the session cockpit: a clean session list (the old
// /api/tasks serializes AbortController fields as {}), per-task transcripts,
// a worktree diff, and provider quota. Lives outside web.ts (1500-line cap);
// webAppRoutes delegates here AFTER web.ts's auth gates ran.
//
// Security invariant for the diff route: the client never supplies a path in
// any form. taskId resolves to a worktree server-side (ledger first, then the
// deterministic worktree layout), and the result must stay under the task's
// own project root.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import type { RunningTask, QueuedTask } from '../orchestration/taskScheduler.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';
import type { PipelineHistoryEntry } from '../automation/runnerState.js';
import { getTaskLog } from '../core/taskLogStore.js';
import { getStageBuffer } from '../core/eventHub.js';
import { getQuotaSnapshot } from '../adapters/quotaSnapshot.js';

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export interface WorkSessionEntry {
  taskId: string;
  issueIdentifier?: string;
  title: string;
  projectPath: string;
  worktreePath?: string;
  branch?: string;
  stage?: string;
  model?: string;
  startedAt: number;
  status: 'running' | 'queued';
}

export interface WorkSessionRecent {
  taskId: string;
  issueIdentifier?: string;
  title: string;
  projectPath?: string;
  /**
   * 'decomposed' is NOT a completion: the run succeeded at splitting the issue
   * and its children now own the work. Folding it into 'completed' told the
   * cockpit a parent issue was finished. (review finding)
   */
  status: 'completed' | 'failed' | 'decomposed';
  /** Raw pipeline finalStatus, for cases the three buckets flatten. */
  finalStatus: string;
  completedAt: number;
  costUsd?: number;
  durationMs: number;
  failureCause?: string;
}

export interface WorkSessionsResponse {
  runnerAvailable: boolean;
  sessions: WorkSessionEntry[];
  recent: WorkSessionRecent[];
}

/** Latest model seen per taskId, folded from the hub's stage buffer. */
export function buildStageModelIndex(
  stageEvents: Array<{ type: string; data?: { taskId?: string; model?: string } }>,
): Map<string, string> {
  const models = new Map<string, string>();
  for (const event of stageEvents) {
    if (event.type !== 'pipeline:stage') continue;
    const { taskId, model } = event.data ?? {};
    if (typeof taskId === 'string' && typeof model === 'string' && model) {
      models.set(taskId, model);
    }
  }
  return models;
}

/**
 * Pure fold of scheduler + history state into the response shape — the route
 * only gathers inputs. Exported for direct fixture tests.
 */
export function buildSessionList(
  running: RunningTask[],
  queued: QueuedTask[],
  history: PipelineHistoryEntry[],
  resolveWorktree: (task: RunningTask) => { worktreePath?: string; branch?: string },
  stageModels: Map<string, string>,
): Omit<WorkSessionsResponse, 'runnerAvailable'> {
  // The session list must use the same key every hub event uses — see
  // taskEventKey's doc for why a mixed key splits a session.
  const sessions: WorkSessionEntry[] = [];
  for (const item of running) {
    const worktree = resolveWorktree(item);
    sessions.push({
      taskId: taskEventKey(item.task),
      issueIdentifier: item.task.issueIdentifier,
      title: item.task.title,
      projectPath: item.projectPath,
      worktreePath: worktree.worktreePath,
      branch: worktree.branch,
      stage: item.stage,
      model: stageModels.get(taskEventKey(item.task)),
      startedAt: item.startedAt,
      status: 'running',
    });
  }
  for (const item of queued) {
    sessions.push({
      taskId: taskEventKey(item.task),
      issueIdentifier: item.task.issueIdentifier,
      title: item.task.title,
      projectPath: item.projectPath,
      // Documented mapping: a queued session has not started — this is queuedAt.
      startedAt: item.queuedAt,
      status: 'queued',
    });
  }

  // Sessions still on the board must not ALSO appear as history (a retried
  // task id has both a running entry and older completed entries).
  const active = new Set(sessions.map((s) => s.taskId));
  const recent: WorkSessionRecent[] = [];
  for (const entry of history) {
    const taskId = entry.issueId ?? entry.sessionId;
    if (active.has(taskId)) continue;
    const completedAt = Date.parse(entry.completedAt);
    recent.push({
      taskId,
      issueIdentifier: entry.issueIdentifier,
      title: entry.taskTitle,
      projectPath: entry.projectPath,
      status: entry.finalStatus === 'decomposed' ? 'decomposed' : entry.success ? 'completed' : 'failed',
      finalStatus: entry.finalStatus,
      completedAt: Number.isFinite(completedAt) ? completedAt : 0,
      costUsd: entry.cost?.costUsd,
      durationMs: entry.totalDuration,
      failureCause: entry.failureCause,
    });
  }
  return { sessions, recent };
}

/**
 * Server-side taskId → worktree mapping. Ledger first (attachWorktree records
 * the real path), then the deterministic `{projectPath}/worktree/{issueId}`
 * layout. Returns null when nothing exists on disk — never a guessed path.
 */
export function resolveTaskWorktree(
  runner: AutonomousRunner,
  taskId: string,
): { worktreePath: string; branch?: string; projectPath: string } | null {
  // Clients hold the session list's taskId (= taskEventKey); accept the raw
  // task.id too so nothing depends on which spelling a caller saved.
  const running = runner
    .getRunningTasks()
    .find((t) => taskEventKey(t.task) === taskId || t.task.id === taskId);
  const issueId = running?.task.issueId ?? taskId;
  const projectPath = running?.projectPath;

  const record = runner.getDurableRun(issueId);
  if (record?.worktreePath && existsSync(record.worktreePath)) {
    return {
      worktreePath: record.worktreePath,
      branch: record.branchName,
      projectPath: projectPath ?? record.projectPath ?? record.worktreePath,
    };
  }
  if (projectPath) {
    const conventional = `${projectPath}/worktree/${issueId}`;
    if (existsSync(conventional)) {
      return { worktreePath: conventional, branch: record?.branchName, projectPath };
    }
  }
  return null;
}

const DIFF_DEFAULT_MAX_BYTES = 16_000;
const DIFF_HARD_MAX_BYTES = 262_144;

export async function tryHandleWorkSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  requestUrl: URL,
  runner: AutonomousRunner | undefined,
): Promise<boolean> {
  if (req.method !== 'GET') return false;

  if (url === '/api/work/sessions') {
    const limitRaw = parseInt(requestUrl.searchParams.get('limit') ?? '20', 10);
    const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 20, 0), 100);
    // History lives in runnerState (module-level) — readable even without a
    // runner, so a dashboard-only daemon still shows recent work.
    const { getPipelineHistory } = await import('../automation/runnerState.js');
    const history = getPipelineHistory(limit);
    if (!runner) {
      const { sessions, recent } = buildSessionList([], [], history, () => ({}), new Map());
      writeJson(res, 200, { runnerAvailable: false, sessions, recent });
      return true;
    }
    const stageModels = buildStageModelIndex(getStageBuffer() as Array<{ type: string; data?: { taskId?: string; model?: string } }>);
    const { sessions, recent } = buildSessionList(
      runner.getRunningTasks(),
      runner.getQueuedTasks(),
      history,
      (task) => {
        const resolved = resolveTaskWorktree(runner, task.task.id);
        return resolved ? { worktreePath: resolved.worktreePath, branch: resolved.branch } : {};
      },
      stageModels,
    );
    writeJson(res, 200, { runnerAvailable: true, sessions, recent });
    return true;
  }

  const logMatch = url.match(/^\/api\/work\/sessions\/([^/]+)\/log$/);
  if (logMatch) {
    let taskId: string;
    try {
      taskId = decodeURIComponent(logMatch[1]);
    } catch {
      // A malformed escape ('%', '%zz') is a bad request, not a server fault —
      // decodeURIComponent throws and would otherwise surface as a 500.
      writeJson(res, 400, { error: 'Malformed taskId encoding' });
      return true;
    }
    const snapshot = getTaskLog(taskId);
    if (!snapshot) {
      writeJson(res, 404, { error: `No transcript for task ${taskId} (unknown, or retention expired)` });
      return true;
    }
    // Same generation the SSE lines carry: sequences only mean anything
    // within one daemon process.
    const { getInstanceId } = await import('./healthEndpoint.js');
    writeJson(res, 200, { ...snapshot, gen: getInstanceId() });
    return true;
  }

  if (url === '/api/work/diff') {
    const taskId = requestUrl.searchParams.get('taskId');
    if (!taskId) {
      writeJson(res, 400, { error: 'Missing ?taskId=' });
      return true;
    }
    if (!runner) {
      writeJson(res, 503, { error: 'Runner not available (daemon starting or autonomous config missing)' });
      return true;
    }
    const resolved = resolveTaskWorktree(runner, taskId);
    if (!resolved) {
      writeJson(res, 404, { error: `No worktree for task ${taskId}` });
      return true;
    }
    // Defense in depth: even the server-resolved path must stay inside the
    // task's own project boundary.
    const { normalizeProjectPath } = await import('../orchestration/taskScheduler.js');
    const canonicalWorktree = normalizeProjectPath(resolved.worktreePath);
    const canonicalProject = normalizeProjectPath(resolved.projectPath);
    if (canonicalWorktree !== canonicalProject && !canonicalWorktree.startsWith(`${canonicalProject}/`)) {
      writeJson(res, 404, { error: `No worktree for task ${taskId}` });
      return true;
    }
    const maxRaw = parseInt(requestUrl.searchParams.get('maxBytes') ?? '', 10);
    const maxBytes = Math.min(
      Number.isFinite(maxRaw) && maxRaw > 0 ? maxRaw : DIFF_DEFAULT_MAX_BYTES,
      DIFF_HARD_MAX_BYTES,
    );
    const { getWorkingDiffDetail, getDiffText } = await import('./gitTracker.js');
    // Working tree vs HEAD — changes the worker already committed on the
    // branch are not shown; the cockpit's per-stage filesChanged covers those.
    //
    // `git diff HEAD` omits untracked files entirely, so a brand-new file
    // would appear in `files` with no patch to show. `--intent-to-add` on a
    // throwaway index makes git emit their content as an addition without
    // touching the worktree's real index. (review finding)
    const [files, diff] = await Promise.all([
      getWorkingDiffDetail(resolved.worktreePath),
      getDiffText(resolved.worktreePath, undefined, maxBytes, { includeUntracked: true }),
    ]);
    // Both helpers swallow git errors into []/'' (they are advisory elsewhere).
    // Here that would render as "no changes" on a broken worktree — report the
    // ambiguity instead of a clean-looking lie. (review finding)
    if (files.length === 0 && !diff) {
      const { isGitRepo } = await import('./gitTracker.js');
      if (!(await isGitRepo(resolved.worktreePath))) {
        writeJson(res, 409, {
          error: `Worktree for task ${taskId} is no longer a valid git repository`,
          worktreePath: resolved.worktreePath,
        });
        return true;
      }
    }
    writeJson(res, 200, {
      taskId,
      worktreePath: resolved.worktreePath,
      branch: resolved.branch,
      files,
      diff,
      truncated: diff.startsWith('[diff truncated'),
    });
    return true;
  }

  if (url === '/api/quota') {
    const snapshot = getQuotaSnapshot();
    const holdUntil = runner?.getRateLimitHoldUntil() ?? 0;
    writeJson(res, 200, {
      providers: snapshot.providers,
      schedulerHoldUntil: holdUntil > Date.now() ? holdUntil : null,
    });
    return true;
  }

  return false;
}

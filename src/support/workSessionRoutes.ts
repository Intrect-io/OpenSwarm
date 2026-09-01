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

// --- Types ---

interface WorkSessionEntry {
  taskId: string;
  stage: string;
  startedAt: number;
  updatedAt: number;
  status: string;
}

interface WorkSessionRecent {
  taskId: string;
  stage: string;
  startedAt: number;
  updatedAt: number;
  status: string;
  summary?: string;
}

interface WorkSessionsResponse {
  sessions: WorkSessionEntry[];
  recent: WorkSessionRecent[];
}

// --- Helpers ---

function buildStageModelIndex(runner: AutonomousRunner): Map<string, string> {
  const index = new Map<string, string>();
  for (const [taskId, task] of runner.runningTasks) {
    index.set(taskId, task.stageModel ?? '');
  }
  return index;
}

function buildSessionList(
  runner: AutonomousRunner,
  stageModelIndex: Map<string, string>,
): WorkSessionEntry[] {
  const sessions: WorkSessionEntry[] = [];
  const now = Date.now();

  for (const [taskId, task] of runner.runningTasks) {
    sessions.push({
      taskId,
      stage: task.stageModel ?? '',
      startedAt: task.startedAt,
      updatedAt: now,
      status: 'running',
    });
  }

  for (const [taskId, task] of runner.queuedTasks) {
    sessions.push({
      taskId,
      stage: stageModelIndex.get(taskId) ?? '',
      startedAt: task.enqueuedAt,
      updatedAt: now,
      status: 'queued',
    });
  }

  return sessions;
}

function resolveTaskWorktree(
  runner: AutonomousRunner,
  taskId: string,
): { worktreePath: string; projectPath: string; branch: string } | null {
  // First check running tasks
  for (const [id, task] of runner.runningTasks) {
    if (id === taskId) {
      return {
        worktreePath: task.worktreePath,
        projectPath: task.projectPath,
        branch: task.branch,
      };
    }
  }

  // Then check queued tasks
  for (const [id, task] of runner.queuedTasks) {
    if (id === taskId) {
      return {
        worktreePath: task.worktreePath,
        projectPath: task.projectPath,
        branch: task.branch,
      };
    }
  }

  return null;
}

// --- Route handler ---

export async function tryHandleWorkSessionRoutes(
  req: IncomingMessage,
  res: ServerResponse,
  runner?: AutonomousRunner,
): Promise<boolean> {
  const url = req.url ?? '';
  const requestUrl = new URL(url, `http://${req.headers.host ?? 'localhost'}`);

  if (url === '/api/work/sessions') {
    if (!runner) {
      writeJson(res, 503, { error: 'Runner not available (daemon starting or autonomous config missing)' });
      return true;
    }
    const stageModelIndex = buildStageModelIndex(runner);
    const sessions = buildSessionList(runner, stageModelIndex);

    // Recent tasks from pipeline history
    const recent: WorkSessionRecent[] = [];
    const history: PipelineHistoryEntry[] = [];
    try {
      const { getPipelineHistory } = await import('../automation/runnerState.js');
      const allHistory = getPipelineHistory();
      for (const entry of allHistory) {
        if (entry.taskId && entry.stageModel) {
          history.push(entry);
        }
      }
    } catch {
      // Pipeline history not available
    }

    for (const entry of history.slice(-10)) {
      recent.push({
        taskId: entry.taskId,
        stage: entry.stageModel ?? '',
        startedAt: entry.startedAt,
        updatedAt: entry.updatedAt,
        status: entry.status ?? 'completed',
        summary: entry.summary,
      });
    }

    const response: WorkSessionsResponse = { sessions, recent };
    writeJson(res, 200, response);
    return true;
  }

  if (url.startsWith('/api/work/transcript/')) {
    const taskId = url.slice('/api/work/transcript/'.length);
    if (!taskId) {
      writeJson(res, 400, { error: 'Missing taskId in URL path' });
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
    // task's own project boundary.  Re-validate at diff time (not just at
    // resolution time) to resist worktree replacement races.
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
    //
    // Use canonicalWorktree (the containment-validated path) for all I/O,
    // not the raw resolved.worktreePath, to resist symlink replacement races.
    const [files, diff] = await Promise.all([
      getWorkingDiffDetail(canonicalWorktree),
      getDiffText(canonicalWorktree, undefined, maxBytes, { includeUntracked: true }),
    ]);
    // Both helpers swallow git errors into []/'' (they are advisory elsewhere).
    // Here that would render as "no changes" on a broken worktree — report the
    // ambiguity instead of a clean-looking lie. (review finding)
    if (files.length === 0 && !diff) {
      const { isGitRepo } = await import('./gitTracker.js');
      if (!(await isGitRepo(canonicalWorktree))) {
        writeJson(res, 409, {
          error: `Worktree for task ${taskId} is no longer a valid git repository`,
          worktreePath: canonicalWorktree,
        });
        return true;
      }
    }
    writeJson(res, 200, {
      taskId,
      worktreePath: canonicalWorktree,
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

// --- Constants ---

const DIFF_DEFAULT_MAX_BYTES = 50 * 1024;
const DIFF_HARD_MAX_BYTES = 500 * 1024;
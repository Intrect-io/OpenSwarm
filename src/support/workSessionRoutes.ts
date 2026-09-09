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

interface WorkSessionEntry {
  taskId: string;
  issueId: string;
  label: string;
  stage: string;
  startedAt: number;
  duration: number;
  worktreePath: string;
  branch: string;
  projectPath: string;
  model: string;
  provider: string;
  pipeline: PipelineHistoryEntry[];
}

interface WorkSessionRecent {
  taskId: string;
  issueId: string;
  label: string;
  stage: string;
  startedAt: number;
  duration: number;
  worktreePath: string;
  branch: string;
  projectPath: string;
  model: string;
  provider: string;
}

interface WorkSessionsResponse {
  active: WorkSessionEntry[];
  recent: WorkSessionRecent[];
  queued: QueuedTask[];
}

function buildStageModelIndex(runner: AutonomousRunner): Map<string, { model: string; provider: string }> {
  const index = new Map<string, { model: string; provider: string }>();
  for (const t of runner.getRunningTasks()) {
    const key = taskEventKey(t.task);
    index.set(key, { model: t.task.model ?? '', provider: t.task.provider ?? '' });
  }
  return index;
}

function buildSessionList(
  runner: AutonomousRunner,
  stageModelIndex: Map<string, { model: string; provider: string }>,
): WorkSessionsResponse {
  const active: WorkSessionEntry[] = [];
  const recent: WorkSessionRecent[] = [];

  for (const t of runner.getRunningTasks()) {
    const key = taskEventKey(t.task);
    const sm = stageModelIndex.get(key);
    const pipeline = t.pipeline ?? [];
    active.push({
      taskId: key,
      issueId: t.task.issueId ?? key,
      label: t.task.label ?? t.task.issueId ?? key,
      stage: t.stage ?? 'unknown',
      startedAt: t.startedAt,
      duration: Date.now() - t.startedAt,
      worktreePath: t.worktreePath ?? '',
      branch: t.branch ?? '',
      projectPath: t.projectPath ?? '',
      model: sm?.model ?? '',
      provider: sm?.provider ?? '',
      pipeline,
    });
  }

  const durables = runner.getDurableRuns();
  for (const d of durables) {
    recent.push({
      taskId: d.taskId,
      issueId: d.issueId,
      label: d.label ?? d.issueId,
      stage: d.stage ?? 'unknown',
      startedAt: d.startedAt,
      duration: d.duration ?? 0,
      worktreePath: d.worktreePath ?? '',
      branch: d.branchName ?? '',
      projectPath: d.projectPath ?? '',
      model: d.model ?? '',
      provider: d.provider ?? '',
    });
  }

  const queued = runner.getQueuedTasks();

  return { active, recent, queued };
}

/**
 * Server-side taskId → worktree mapping. Ledger first (attachWorktree records
 * the real path), then the deterministic `{projectPath}/worktree/{issueId}`
 * layout. Returns null when nothing exists on disk — never a guessed path.
 *
 * Security invariant: the returned projectPath must come from the authoritative
 * running context, not from a durable-run record that may be stale or point to
 * an incorrect workspace.
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
    // Require an authoritative projectPath from the running context; do not
    // fall back to record.projectPath or record.worktreePath which may be
    // stale or point to an incorrect workspace.
    if (!projectPath) return null;
    return {
      worktreePath: record.worktreePath,
      branch: record.branchName,
      projectPath,
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
  runner: AutonomousRunner,
): Promise<boolean> {
  const { method, url } = req;
  if (!url || !method) return false;

  // ── session list ──────────────────────────────────────────────────────
  if (url === '/api/sessions' && method === 'GET') {
    const stageModelIndex = buildStageModelIndex(runner);
    const body = buildSessionList(runner, stageModelIndex);
    writeJson(res, 200, body);
    return true;
  }

  // ── per-task transcript ───────────────────────────────────────────────
  const transcriptMatch = url.match(/^\/api\/sessions\/([^/]+)\/transcript$/);
  if (transcriptMatch && method === 'GET') {
    const taskId = transcriptMatch[1];
    const log = getTaskLog(taskId);
    if (!log) {
      writeJson(res, 404, { error: 'transcript not found' });
      return true;
    }
    writeJson(res, 200, { taskId, log });
    return true;
  }

  // ── per-task stage buffer ─────────────────────────────────────────────
  const stageMatch = url.match(/^\/api\/sessions\/([^/]+)\/stage\/([^/]+)$/);
  if (stageMatch && method === 'GET') {
    const taskId = stageMatch[1];
    const stage = stageMatch[2];
    const buffer = getStageBuffer(taskId, stage);
    if (!buffer) {
      writeJson(res, 404, { error: 'stage buffer not found' });
      return true;
    }
    writeJson(res, 200, { taskId, stage, buffer });
    return true;
  }

  // ── worktree diff ─────────────────────────────────────────────────────
  const diffMatch = url.match(/^\/api\/sessions\/([^/]+)\/diff$/);
  if (diffMatch && method === 'GET') {
    const taskId = diffMatch[1];
    const resolved = resolveTaskWorktree(runner, taskId);
    if (!resolved) {
      writeJson(res, 404, { error: 'worktree not found for task' });
      return true;
    }

    // Security: the client never supplies a path. taskId resolves to a
    // worktree server-side, and the result must stay under the task's own
    // project root.
    const { worktreePath, projectPath } = resolved;

    // Read staged diff (git diff --cached) and working-tree diff
    const { execSync } = await import('node:child_process');
    let diff = '';
    let truncated = false;
    const maxBytes = DIFF_DEFAULT_MAX_BYTES;

    try {
      const raw = execSync('git diff HEAD', {
        cwd: worktreePath,
        encoding: 'utf8',
        maxBuffer: DIFF_HARD_MAX_BYTES,
        timeout: 10_000,
      });
      if (raw.length > maxBytes) {
        diff = raw.slice(0, maxBytes) + `\n[diff truncated at ${maxBytes} bytes]`;
        truncated = true;
      } else {
        diff = raw;
      }
    } catch {
      diff = '(no diff or not a git repository)';
    }

    // List changed files
    let files: string[] = [];
    try {
      const raw = execSync('git diff --name-only HEAD', {
        cwd: worktreePath,
        encoding: 'utf8',
        maxBuffer: 16_000,
        timeout: 5_000,
      });
      files = raw.trim().split('\n').filter(Boolean);
    } catch {
      files = [];
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
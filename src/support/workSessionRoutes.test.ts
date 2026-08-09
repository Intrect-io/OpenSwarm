import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AutonomousRunner } from '../automation/autonomousRunner.js';
import type { RunningTask, QueuedTask } from '../orchestration/taskScheduler.js';
import type { PipelineHistoryEntry } from '../automation/runnerState.js';

const { existsSyncImpl } = vi.hoisted(() => ({ existsSyncImpl: vi.fn(() => true) }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncImpl };
});

const { getPipelineHistoryImpl } = vi.hoisted(() => ({
  getPipelineHistoryImpl: vi.fn((): PipelineHistoryEntry[] => []),
}));
vi.mock('../automation/runnerState.js', () => ({ getPipelineHistory: getPipelineHistoryImpl }));

const gitTracker = vi.hoisted(() => ({
  getWorkingDiffDetail: vi.fn(async () => [{ file: 'src/a.ts', added: 3, deleted: 1, isNew: false }]),
  getDiffText: vi.fn(async () => 'diff --git a/src/a.ts b/src/a.ts\n+added'),
  isGitRepo: vi.fn(async () => true),
}));
vi.mock('./gitTracker.js', () => gitTracker);

import {
  buildSessionList,
  buildStageModelIndex,
  resolveTaskWorktree,
  tryHandleWorkSessionRoutes,
} from './workSessionRoutes.js';
import { appendTaskLog, __resetTaskLogsForTests } from '../core/taskLogStore.js';
import { recordQuotaObservation, __resetQuotaForTests } from '../adapters/quotaSnapshot.js';

const runningTask = (id: string, over: Partial<RunningTask['task']> = {}): RunningTask =>
  ({
    runId: `run-${id}`,
    task: { id, issueId: id, issueIdentifier: `INT-${id}`, title: `Task ${id}`, ...over },
    projectPath: '/repo',
    startedAt: 1000,
    stage: 'worker',
  }) as unknown as RunningTask;

const queuedTask = (id: string): QueuedTask =>
  ({
    task: { id, issueId: id, issueIdentifier: `INT-${id}`, title: `Task ${id}` },
    projectPath: '/repo',
    queuedAt: 500,
    priority: 2,
  }) as unknown as QueuedTask;

const historyEntry = (over: Partial<PipelineHistoryEntry> = {}): PipelineHistoryEntry =>
  ({
    sessionId: 'sess-1',
    issueId: 'done-1',
    issueIdentifier: 'INT-D1',
    taskTitle: 'Finished task',
    projectPath: '/repo',
    success: true,
    finalStatus: 'completed',
    iterations: 1,
    totalDuration: 60_000,
    stages: [],
    cost: { costUsd: 0.42, inputTokens: 10, outputTokens: 5 },
    completedAt: '2026-08-08T10:00:00.000Z',
    ...over,
  }) as PipelineHistoryEntry;

function mkRunner(over: Partial<Record<string, unknown>> = {}): AutonomousRunner {
  return {
    getRunningTasks: vi.fn(() => [] as RunningTask[]),
    getQueuedTasks: vi.fn(() => [] as QueuedTask[]),
    getDurableRun: vi.fn(() => null),
    getRateLimitHoldUntil: vi.fn(() => 0),
    ...over,
  } as unknown as AutonomousRunner;
}

async function call(
  url: string,
  runner: AutonomousRunner | undefined,
): Promise<{ handled: boolean; status: number; body: any }> {
  let status = 0;
  let payload = '';
  const res = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (body: string) => {
      payload = body;
    },
  } as unknown as ServerResponse;
  const requestUrl = new URL(`http://127.0.0.1${url}`);
  const handled = await tryHandleWorkSessionRoutes(
    { method: 'GET', headers: {} } as IncomingMessage,
    res,
    requestUrl.pathname,
    requestUrl,
    runner,
  );
  return { handled, status, body: payload ? JSON.parse(payload) : null };
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncImpl.mockReturnValue(true);
  getPipelineHistoryImpl.mockReturnValue([]);
  gitTracker.getWorkingDiffDetail.mockResolvedValue([{ file: 'src/a.ts', added: 3, deleted: 1, isNew: false }]);
  gitTracker.getDiffText.mockResolvedValue('diff --git a/src/a.ts b/src/a.ts\n+added');
  gitTracker.isGitRepo.mockResolvedValue(true);
  __resetTaskLogsForTests();
  __resetQuotaForTests();
});

describe('buildStageModelIndex', () => {
  it('keeps the latest model per task and ignores other event types', () => {
    const index = buildStageModelIndex([
      { type: 'pipeline:stage', data: { taskId: 't1', model: 'old-model' } },
      { type: 'task:started', data: { taskId: 't1', model: 'not-a-stage' } },
      { type: 'pipeline:stage', data: { taskId: 't1', model: 'new-model' } },
      { type: 'pipeline:stage', data: { taskId: 't2' } },
    ]);
    expect(index.get('t1')).toBe('new-model');
    expect(index.has('t2')).toBe(false);
  });
});

describe('buildSessionList', () => {
  it('merges running, queued, and history with the documented field mappings', () => {
    const { sessions, recent } = buildSessionList(
      [runningTask('r1')],
      [queuedTask('q1')],
      [historyEntry()],
      () => ({ worktreePath: '/repo/worktree/r1', branch: 'swarm/INT-r1' }),
      new Map([['r1', 'gpt-5.5']]),
    );
    expect(sessions).toEqual([
      expect.objectContaining({
        taskId: 'r1',
        status: 'running',
        worktreePath: '/repo/worktree/r1',
        branch: 'swarm/INT-r1',
        model: 'gpt-5.5',
        stage: 'worker',
        startedAt: 1000,
      }),
      // queuedAt maps onto startedAt for queued rows (documented).
      expect.objectContaining({ taskId: 'q1', status: 'queued', startedAt: 500 }),
    ]);
    expect(recent).toEqual([
      expect.objectContaining({
        taskId: 'done-1',
        status: 'completed',
        costUsd: 0.42,
        completedAt: Date.parse('2026-08-08T10:00:00.000Z'),
      }),
    ]);
  });

  it('keeps a decomposed run distinct from a completed one', () => {
    const { recent } = buildSessionList(
      [],
      [],
      [historyEntry({ issueId: 'parent-1', success: true, finalStatus: 'decomposed' })],
      () => ({}),
      new Map(),
    );
    // success:true, but the children own the work now — not a completion.
    expect(recent[0]).toMatchObject({ status: 'decomposed', finalStatus: 'decomposed' });
  });

  it('drops history entries whose task id is back on the board (retry)', () => {
    const { recent } = buildSessionList(
      [runningTask('done-1')],
      [],
      [historyEntry({ issueId: 'done-1' }), historyEntry({ issueId: 'other', success: false, failureCause: 'timeout' })],
      () => ({}),
      new Map(),
    );
    expect(recent).toEqual([
      expect.objectContaining({ taskId: 'other', status: 'failed', failureCause: 'timeout' }),
    ]);
  });
});

describe('resolveTaskWorktree', () => {
  it('prefers the ledger record when its worktree exists on disk', () => {
    const runner = mkRunner({
      getRunningTasks: vi.fn(() => [runningTask('t1')]),
      getDurableRun: vi.fn(() => ({
        worktreePath: '/repo/worktree/ledger-path',
        branchName: 'swarm/INT-t1',
        projectPath: '/repo',
      })),
    });
    expect(resolveTaskWorktree(runner, 't1')).toEqual({
      worktreePath: '/repo/worktree/ledger-path',
      branch: 'swarm/INT-t1',
      projectPath: '/repo',
    });
  });

  it('falls back to the conventional layout for a running task without a ledger row', () => {
    const runner = mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) });
    expect(resolveTaskWorktree(runner, 't1')).toEqual({
      worktreePath: '/repo/worktree/t1',
      branch: undefined,
      projectPath: '/repo',
    });
  });

  it('returns null when nothing exists on disk — never a guessed path', () => {
    existsSyncImpl.mockReturnValue(false);
    const runner = mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) });
    expect(resolveTaskWorktree(runner, 't1')).toBeNull();
  });
});

describe('GET /api/work/sessions', () => {
  it('serves history with runnerAvailable=false when the runner is absent', async () => {
    getPipelineHistoryImpl.mockReturnValue([historyEntry()]);
    const { handled, status, body } = await call('/api/work/sessions', undefined);
    expect(handled).toBe(true);
    expect(status).toBe(200);
    expect(body.runnerAvailable).toBe(false);
    expect(body.sessions).toEqual([]);
    expect(body.recent).toHaveLength(1);
  });

  it('serves the merged list with worktree resolution when the runner is up', async () => {
    const runner = mkRunner({
      getRunningTasks: vi.fn(() => [runningTask('t1')]),
      getQueuedTasks: vi.fn(() => [queuedTask('q1')]),
    });
    const { status, body } = await call('/api/work/sessions', runner);
    expect(status).toBe(200);
    expect(body.runnerAvailable).toBe(true);
    expect(body.sessions.map((s: { taskId: string }) => s.taskId)).toEqual(['t1', 'q1']);
    expect(body.sessions[0].worktreePath).toBe('/repo/worktree/t1');
  });
});

describe('GET /api/work/sessions/:taskId/log', () => {
  it('returns the transcript snapshot', async () => {
    appendTaskLog('t1', 'worker', 'hello', 42);
    const { status, body } = await call('/api/work/sessions/t1/log', mkRunner());
    expect(status).toBe(200);
    expect(body).toMatchObject({ taskId: 't1', truncated: false });
    // seq is the client's merge key — it must reach the wire, not just the ring.
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]).toMatchObject({ stage: 'worker', line: 'hello', ts: 42 });
    expect(typeof body.lines[0].seq).toBe('number');
  });

  it('404s for an unknown task and decodes the id', async () => {
    appendTaskLog('weird id', 'worker', 'line');
    expect((await call('/api/work/sessions/nope/log', mkRunner())).status).toBe(404);
    expect((await call('/api/work/sessions/weird%20id/log', mkRunner())).status).toBe(200);
  });
});

describe('GET /api/work/diff', () => {
  it('400s without taskId and 503s without a runner', async () => {
    expect((await call('/api/work/diff', mkRunner())).status).toBe(400);
    expect((await call('/api/work/diff?taskId=t1', undefined)).status).toBe(503);
  });

  it('404s when the task has no worktree, without touching git', async () => {
    existsSyncImpl.mockReturnValue(false);
    const { status } = await call('/api/work/diff?taskId=t1', mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) }));
    expect(status).toBe(404);
    expect(gitTracker.getWorkingDiffDetail).not.toHaveBeenCalled();
  });

  it('never lets a traversal-shaped taskId reach git — resolution is server-side only', async () => {
    existsSyncImpl.mockReturnValue(false);
    const { status } = await call(`/api/work/diff?taskId=${encodeURIComponent('../../etc')}`, mkRunner());
    expect(status).toBe(404);
    expect(gitTracker.getWorkingDiffDetail).not.toHaveBeenCalled();
    expect(gitTracker.getDiffText).not.toHaveBeenCalled();
  });

  it('404s when the resolved worktree escapes the project boundary', async () => {
    const runner = mkRunner({
      getRunningTasks: vi.fn(() => [runningTask('t1')]),
      getDurableRun: vi.fn(() => ({
        worktreePath: '/elsewhere/worktree/t1',
        branchName: 'swarm/INT-t1',
        projectPath: '/repo',
      })),
    });
    const { status } = await call('/api/work/diff?taskId=t1', runner);
    expect(status).toBe(404);
    expect(gitTracker.getWorkingDiffDetail).not.toHaveBeenCalled();
  });

  it('serves files + diff text from the resolved worktree', async () => {
    const runner = mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) });
    const { status, body } = await call('/api/work/diff?taskId=t1', runner);
    expect(status).toBe(200);
    expect(body.worktreePath).toBe('/repo/worktree/t1');
    expect(body.files).toHaveLength(1);
    expect(body.diff).toContain('diff --git');
    expect(body.truncated).toBe(false);
    expect(gitTracker.getWorkingDiffDetail).toHaveBeenCalledWith('/repo/worktree/t1');
  });

  it('caps the requested maxBytes at the hard limit and asks for untracked content', async () => {
    const runner = mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) });
    await call('/api/work/diff?taskId=t1&maxBytes=99999999', runner);
    // includeUntracked: a brand-new file appears in `files` but `git diff HEAD`
    // would show no patch for it (review finding).
    expect(gitTracker.getDiffText).toHaveBeenCalledWith('/repo/worktree/t1', undefined, 262_144, {
      includeUntracked: true,
    });
  });

  it('409s instead of reporting a clean diff when the worktree is no longer a git repo', async () => {
    gitTracker.getWorkingDiffDetail.mockResolvedValue([]);
    gitTracker.getDiffText.mockResolvedValue('');
    gitTracker.isGitRepo.mockResolvedValue(false);
    const runner = mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) });
    const { status, body } = await call('/api/work/diff?taskId=t1', runner);
    expect(status).toBe(409);
    expect(body.error).toContain('no longer a valid git repository');
  });

  it('200s with an empty diff when the worktree is healthy and simply clean', async () => {
    gitTracker.getWorkingDiffDetail.mockResolvedValue([]);
    gitTracker.getDiffText.mockResolvedValue('');
    const runner = mkRunner({ getRunningTasks: vi.fn(() => [runningTask('t1')]) });
    const { status, body } = await call('/api/work/diff?taskId=t1', runner);
    expect(status).toBe(200);
    expect(body.files).toEqual([]);
    expect(body.diff).toBe('');
  });
});

describe('GET /api/quota', () => {
  it('serves observations and the scheduler hold when active', async () => {
    recordQuotaObservation({ provider: 'codex', usedPercent: 37, source: 'success-headers', observedAt: 7 });
    const holdUntil = Date.now() + 60_000;
    const runner = mkRunner({ getRateLimitHoldUntil: vi.fn(() => holdUntil) });
    const { status, body } = await call('/api/quota', runner);
    expect(status).toBe(200);
    expect(body.providers).toEqual([
      { provider: 'codex', usedPercent: 37, source: 'success-headers', observedAt: 7 },
    ]);
    expect(body.schedulerHoldUntil).toBe(holdUntil);
  });

  it('always 200s — empty providers and null hold without observations/runner', async () => {
    const { status, body } = await call('/api/quota', undefined);
    expect(status).toBe(200);
    expect(body).toEqual({ providers: [], schedulerHoldUntil: null });
  });
});

describe('non-matching requests', () => {
  it('passes through unrelated URLs and non-GET methods', async () => {
    expect((await call('/api/work/issues', mkRunner())).handled).toBe(false);
    let handled = await tryHandleWorkSessionRoutes(
      { method: 'POST', headers: {} } as IncomingMessage,
      {} as ServerResponse,
      '/api/quota',
      new URL('http://127.0.0.1/api/quota'),
      undefined,
    );
    expect(handled).toBe(false);
  });
});

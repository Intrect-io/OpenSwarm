import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  upsertTaskState,
  getTaskState,
  getTaskReadiness,
  releaseDependentTasks,
  enrichTaskFromState,
  markTaskDone,
  markTaskInProgress,
  updateTaskLinearState,
  completeParentIfChildrenDone,
  buildTaskStateSyncComment,
  hydrateTaskStateFromComments,
  markTaskBacklog,
  resetTaskStateStoreForTests,
  type OpenSwarmTaskState,
} from './store.js';

describe('task state store', () => {
  let stateFile: string;
  let stateDir: string;

  function taskState(
    issueId: string,
    status: OpenSwarmTaskState['execution']['status'],
    linearState: string,
  ): OpenSwarmTaskState {
    return {
      version: 1,
      issueId,
      childIssueIds: [],
      dependencyIssueIds: [],
      dependencyTitles: [],
      fileScope: [],
      execution: { status, retryCount: 0 },
      worktree: {},
      linearState,
      updatedAt: new Date().toISOString(),
    };
  }

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-task-state-'));
    stateFile = join(stateDir, 'state.json');
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    resetTaskStateStoreForTests();
  });

  afterEach(() => {
    resetTaskStateStoreForTests();
    if (existsSync(stateFile)) {
      unlinkSync(stateFile);
    }
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    delete process.env.OPENSWARM_TASK_STATE_TRUSTED_COMMENT_USERS;
  });

  it('enriches a task with canonical dependency data', () => {
    upsertTaskState('ISSUE-2', {
      issueIdentifier: 'INT-2',
      dependencyIssueIds: ['ISSUE-1'],
      parentIssueId: 'PARENT-1',
      topoRank: 1,
      execution: { status: 'blocked', retryCount: 0 },
      updatedAt: new Date().toISOString(),
    });

    const task = enrichTaskFromState({
      id: 'ISSUE-2',
      source: 'linear',
      title: 'child task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-2',
    });

    expect(task.parentId).toBe('PARENT-1');
    expect(task.blockedBy).toEqual(['ISSUE-1']);
    expect(task.topoRank).toBe(1);
  });

  it('persists and enriches planner-declared file scope', () => {
    upsertTaskState('ISSUE-SCOPE', {
      issueIdentifier: 'INT-SCOPE',
      fileScope: ['src/a.ts', 'src/a.test.ts'],
      execution: { status: 'todo', retryCount: 0 },
      updatedAt: new Date().toISOString(),
    });

    const enriched = enrichTaskFromState({
      id: 'ISSUE-SCOPE',
      source: 'linear',
      title: 'scoped task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-SCOPE',
    });

    expect(enriched.fileScope).toEqual(['src/a.ts', 'src/a.test.ts']);

    // An explicit scope already on the task wins over the stored one.
    const overridden = enrichTaskFromState({
      id: 'ISSUE-SCOPE',
      source: 'linear',
      title: 'scoped task',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-SCOPE',
      fileScope: ['src/override.ts'],
    });
    expect(overridden.fileScope).toEqual(['src/override.ts']);
  });

  it('serializes two process writers without losing either update', async () => {
    const fixture = fileURLToPath(new URL('./storeClaimProcess.fixture.ts', import.meta.url));
    const run = (issueId: string, delay: number) => new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, ['--import', 'tsx', fixture, stateFile, issueId, String(delay)], {
        stdio: 'pipe',
      });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      child.on('error', reject);
      child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(stderr || `child exited ${code}`)));
    });

    await Promise.all([run('PROCESS-A', 0), run('PROCESS-B', 0)]);
    resetTaskStateStoreForTests();
    expect(getTaskState('PROCESS-A')?.title).toBe('PROCESS-A');
    expect(getTaskState('PROCESS-B')?.title).toBe('PROCESS-B');
  });

  it('keeps tasks blocked until dependencies are done, then releases them', () => {
    upsertTaskState('ISSUE-1', {
      execution: { status: 'in_progress', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('ISSUE-2', {
      dependencyIssueIds: ['ISSUE-1'],
      execution: { status: 'blocked', retryCount: 0 },
      linearState: 'Backlog',
      updatedAt: new Date().toISOString(),
    });

    const blocked = getTaskReadiness({
      id: 'ISSUE-2',
      source: 'linear',
      title: 'child',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'ISSUE-2',
    });
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(['ISSUE-1']);

    markTaskDone('ISSUE-1');
    const released = releaseDependentTasks('ISSUE-1');
    expect(released).toHaveLength(1);
    expect(released[0].issueId).toBe('ISSUE-2');
    expect(released[0].execution.status).toBe('todo');
    expect(released[0].linearState).toBe('Todo');
  });

  it('gates on TaskItem.blockedBy (Linear-fetched deps) until the blocker is done', () => {
    // INT-1809: blockedBy now arrives on the TaskItem from the Linear fetch
    // (relations + "블로커:" prose), not just from local taskState.dependencyIssueIds.
    // getTaskReadiness must prefer it and gate execution.
    upsertTaskState('KT-307', {
      execution: { status: 'in_progress', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });

    const task = {
      id: 'KT-308',
      source: 'linear' as const,
      title: '[하네스이식 8] eval 회귀 검증',
      priority: 2,
      createdAt: Date.now(),
      issueId: 'KT-308',
      blockedBy: ['KT-307'],
    };

    const blocked = getTaskReadiness(task);
    expect(blocked.ready).toBe(false);
    expect(blocked.blockedBy).toEqual(['KT-307']);
    expect(blocked.reason).toContain('Waiting on dependencies');

    // Blocker completes → dependent becomes ready.
    markTaskDone('KT-307');
    const ready = getTaskReadiness(task);
    expect(ready.ready).toBe(true);
    expect(ready.blockedBy).toEqual([]);
  });

  it('reconciles stale in_progress against Linear state (R5)', () => {
    // Operator parks an actively-running issue → local in_progress is stale.
    markTaskInProgress('KT-400', { linearState: 'In Progress' });
    const parked = updateTaskLinearState('KT-400', 'Backlog');
    expect(parked.linearState).toBe('Backlog');
    expect(parked.execution.status).toBe('backlog');

    // Completed externally → mark done locally.
    markTaskInProgress('KT-401', { linearState: 'In Progress' });
    const done = updateTaskLinearState('KT-401', 'Done');
    expect(done.execution.status).toBe('done');

    // Still actively In Progress → execution status is left untouched.
    markTaskInProgress('KT-402', { linearState: 'In Progress' });
    const running = updateTaskLinearState('KT-402', 'In Progress');
    expect(running.execution.status).toBe('in_progress');
  });

  it('parks a claimed task back in backlog and clears stale worktree data', () => {
    markTaskInProgress('KT-450', {
      issueIdentifier: 'KT-450',
      title: 'Cancel running task',
      linearState: 'In Progress',
      sessionId: 'pipeline-1',
      branchName: 'fix/kt-450',
      worktreePath: '/tmp/openswarm/kt-450',
    });

    const parked = markTaskBacklog('KT-450', {
      issueIdentifier: 'KT-450',
      title: 'Cancel running task',
    });

    expect(parked.execution.status).toBe('backlog');
    expect(parked.execution.lastSessionId).toBe('pipeline-1');
    expect(parked.linearState).toBe('Backlog');
    expect(parked.worktree.branchName).toBeUndefined();
    expect(parked.worktree.worktreePath).toBeUndefined();
  });

  it('preserves existing top-level metadata when convenience patches omit it', () => {
    markTaskInProgress('KT-451', {
      issueIdentifier: 'KT-451',
      title: 'Preserve metadata',
      projectId: 'project-1',
      projectName: 'OpenSwarm',
      linearState: 'In Progress',
      branchName: 'fix/kt-451',
    });

    const done = markTaskDone('KT-451');
    expect(done.issueIdentifier).toBe('KT-451');
    expect(done.title).toBe('Preserve metadata');
    expect(done.projectId).toBe('project-1');
    expect(done.projectName).toBe('OpenSwarm');
    expect(done.linearState).toBe('Done');
  });

  it('completes decomposed parent only after all child issues are done', () => {
    upsertTaskState('PARENT-1', {
      childIssueIds: ['CHILD-1', 'CHILD-2'],
      execution: { status: 'decomposed', retryCount: 0 },
      linearState: 'In Progress',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('CHILD-1', {
      parentIssueId: 'PARENT-1',
      execution: { status: 'done', retryCount: 0 },
      linearState: 'Done',
      updatedAt: new Date().toISOString(),
    });
    upsertTaskState('CHILD-2', {
      parentIssueId: 'PARENT-1',
      execution: { status: 'todo', retryCount: 0 },
      linearState: 'Todo',
      updatedAt: new Date().toISOString(),
    });

    expect(completeParentIfChildrenDone('CHILD-1')).toBeNull();

    markTaskDone('CHILD-2');
    const parent = completeParentIfChildrenDone('CHILD-2');
    expect(parent?.issueId).toBe('PARENT-1');
    expect(parent?.execution.status).toBe('done');
    expect(parent?.linearState).toBe('Done');
  });

  it('hydrates canonical state from the latest Linear sync comment', () => {
    const older = buildTaskStateSyncComment(
      upsertTaskState('ISSUE-9', {
        linearState: 'Backlog',
        execution: { status: 'blocked', retryCount: 0 },
      }),
      'Task blocked'
    );

    const latest = buildTaskStateSyncComment(
      upsertTaskState('ISSUE-9', {
        linearState: 'Done',
        execution: { status: 'done', retryCount: 0 },
      }),
      'Task completed'
    );

    const hydrated = hydrateTaskStateFromComments('ISSUE-9', [
      { body: older, createdAt: '2026-03-18T00:00:00.000Z', source: 'openswarm' },
      { body: latest, createdAt: '2026-03-18T01:00:00.000Z', source: 'openswarm' },
    ]);

    expect(hydrated?.execution.status).toBe('done');
    expect(hydrated?.linearState).toBe('Done');
  });

  it('does not grant execution authority to an authorless copied sync comment', () => {
    const body = buildTaskStateSyncComment(taskState('ISSUE-COPY', 'done', 'Done'), 'Task completed');
    expect(hydrateTaskStateFromComments('ISSUE-COPY', [
      { body, createdAt: '2026-03-18T01:00:00.000Z' },
    ])).toBeUndefined();
  });

  it('ignores untrusted or mismatched task-state sync comments', () => {
    const olderTrusted = buildTaskStateSyncComment(
      taskState('ISSUE-10', 'blocked', 'Backlog'),
      'Task blocked'
    );
    const newerUntrusted = buildTaskStateSyncComment(
      taskState('ISSUE-10', 'done', 'Done'),
      'Task completed'
    );
    const otherIssue = buildTaskStateSyncComment(
      taskState('ISSUE-OTHER', 'done', 'Done'),
      'Task completed'
    );

    const hydrated = hydrateTaskStateFromComments('ISSUE-10', [
      { body: olderTrusted, createdAt: '2026-03-18T00:00:00.000Z', user: 'OpenSwarm Bot' },
      { body: newerUntrusted, createdAt: '2026-03-18T01:00:00.000Z', user: 'Mallory' },
      { body: otherIssue, createdAt: '2026-03-18T02:00:00.000Z', user: 'OpenSwarm Bot' },
    ]);

    expect(hydrated?.execution.status).toBe('blocked');
    expect(hydrated?.linearState).toBe('Backlog');
  });

  it('allows explicitly configured task-state sync comment authors', () => {
    process.env.OPENSWARM_TASK_STATE_TRUSTED_COMMENT_USERS = 'unohee';
    const body = buildTaskStateSyncComment(taskState('ISSUE-11', 'done', 'Done'), 'Task completed');

    const hydrated = hydrateTaskStateFromComments('ISSUE-11', [
      { body, createdAt: '2026-03-18T01:00:00.000Z', user: 'unohee' },
    ]);

    expect(hydrated?.execution.status).toBe('done');
  });

  it('fails closed on corrupt persisted task-state files without overwriting them', () => {
    writeFileSync(stateFile, '{not-json', 'utf8');

    expect(() => getTaskState('ISSUE-CORRUPT')).toThrow(/Task state store is corrupt/);
    expect(readFileSync(stateFile, 'utf8')).toBe('{not-json');
  });
});

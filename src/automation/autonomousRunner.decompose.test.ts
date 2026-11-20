// AGT-4817 B: a task that waits on a decomposed parent is created in Backlog; when the parent
// closes because every child merged, the waiting task must reach Todo in the tracker as well.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AutonomousConfig } from './runnerTypes.js';
import type { ITaskSource } from './taskSource.js';

type AutonomousRunnerCtor = typeof import('./autonomousRunner.js').AutonomousRunner;
type TaskStateStoreModule = typeof import('../taskState/store.js');

let tempDir = '';
let AutonomousRunner: AutonomousRunnerCtor;
let taskStateStore: TaskStateStoreModule;

const cfg = (): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  dryRun: true,
});

interface ParentCompletion {
  completeParentIfChildrenMerged(childIssueId: string, source: ITaskSource): Promise<void>;
}

describe('AutonomousRunner decomposed parent completion (AGT-4817)', () => {
  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'openswarm-decompose-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(tempDir, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(tempDir, 'runner-task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(tempDir, 'runner-rejection-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(tempDir, 'runner-pipeline-history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(tempDir, 'runner-decomposition-state.json'));
    ({ AutonomousRunner } = await import('./autonomousRunner.js'));
    taskStateStore = await import('../taskState/store.js');
  }, 30000);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('moves a blocked Backlog child to Todo when its decomposed parent completes', async () => {
    // GOAL was decomposed into PARENT and WAITER; WAITER depends on PARENT, which was itself
    // decomposed into CHILD-A and CHILD-B. Both children have merged (Done in the tracker).
    const { upsertTaskState, getTaskState } = taskStateStore;
    upsertTaskState('GOAL', { childIssueIds: ['PARENT', 'WAITER'], linearState: 'In Progress' });
    upsertTaskState('PARENT', { parentIssueId: 'GOAL', childIssueIds: ['CHILD-A', 'CHILD-B'], linearState: 'In Progress', execution: { status: 'in_progress', retryCount: 0 } });
    upsertTaskState('WAITER', {
      parentIssueId: 'GOAL',
      dependencyIssueIds: ['PARENT'],
      linearState: 'Backlog',
      execution: { status: 'blocked', blockedReason: 'Waiting on dependencies: PARENT', retryCount: 0 },
    });
    for (const id of ['CHILD-A', 'CHILD-B']) {
      upsertTaskState(id, { parentIssueId: 'PARENT', linearState: 'Done', execution: { status: 'done', retryCount: 0 } });
    }

    const calls: string[] = [];
    const source = {
      kind: 'linear',
      lookupIssueState: vi.fn(async () => ({ ok: true, issue: { state: 'Done', stateType: 'completed' } })),
      addComment: vi.fn(async (issueId: string, body: string) => { calls.push(`comment:${issueId}:${body.split('\n')[0]}`); }),
      updateState: vi.fn(async (issueId: string, state: string) => { calls.push(`state:${issueId}:${state}`); return true; }),
    } as unknown as ITaskSource;

    const runner = new AutonomousRunner(cfg()) as unknown as ParentCompletion;
    await runner.completeParentIfChildrenMerged('CHILD-B', source);

    expect(calls).toEqual([
      'comment:PARENT:All 2 child tasks merged, so this parent closes as Done.',
      'state:PARENT:Done',
      'comment:WAITER:🧭 **[OpenSwarm] Task unblocked and ready**',
      'state:WAITER:Todo',
    ]);
    expect(getTaskState('WAITER')).toMatchObject({ linearState: 'Todo', execution: { status: 'todo' } });
    expect(getTaskState('WAITER')?.releasedAt).toEqual(expect.any(String));
  });
});

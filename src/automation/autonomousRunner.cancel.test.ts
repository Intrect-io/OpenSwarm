import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { ITaskSource } from './taskSource.js';

type AutonomousRunnerCtor = typeof import('./autonomousRunner.js').AutonomousRunner;
type RunnerExecutionModule = typeof import('./runnerExecution.js');
type TaskStateStoreModule = typeof import('../taskState/store.js');

let tempDir = '';
let AutonomousRunner: AutonomousRunnerCtor;
let runnerExecution: RunnerExecutionModule;
let taskStateStore: TaskStateStoreModule;

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  dryRun: true,
  ...over,
});

const task = (): TaskItem => ({
  id: 'task-1',
  source: 'linear',
  issueId: 'ISSUE-1',
  issueIdentifier: 'INT-1',
  title: 'Cancel me',
  priority: 3,
  createdAt: Date.now(),
});

const cancelledResult = (): PipelineResult => ({
  success: false,
  sessionId: 'pipeline-1',
  iterations: 0,
  totalDuration: 25,
  finalStatus: 'cancelled',
  stages: [],
});

function mockTaskSource() {
  return {
    kind: 'local',
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => {}),
  } as unknown as ITaskSource & {
    updateState: ReturnType<typeof vi.fn>;
    addComment: ReturnType<typeof vi.fn>;
  };
}

describe('AutonomousRunner cancellation state sync', () => {
  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'openswarm-cancel-sync-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(tempDir, 'task-state.json')); // canonical store (taskState/store)
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(tempDir, 'runner-task-state.json')); // legacy runnerState
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(tempDir, 'runner-rejection-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(tempDir, 'runner-pipeline-history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(tempDir, 'runner-decomposition-state.json'));
    ({ AutonomousRunner } = await import('./autonomousRunner.js'));
    runnerExecution = await import('./runnerExecution.js');
    taskStateStore = await import('../taskState/store.js');
  }, 30000);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('parks durable task state when the scheduler emits cancelled', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    taskStateStore.markTaskInProgress('ISSUE-1', {
      issueIdentifier: 'INT-1',
      title: 'Cancel me',
      sessionId: 'pipeline-1',
      branchName: 'fix/int-1',
      worktreePath: '/tmp/openswarm/int-1',
    });

    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    scheduler.startTask(task(), '/repo', async () => cancelledResult());
    await new Promise((resolve) => setTimeout(resolve, 20));

    const state = taskStateStore.getTaskState('ISSUE-1');
    expect(state?.execution.status).toBe('backlog');
    expect(state?.linearState).toBe('Backlog');
    expect(state?.worktree.worktreePath).toBeUndefined();
    expect(source.updateState).toHaveBeenCalledWith('ISSUE-1', 'Backlog');
    expect(source.addComment).toHaveBeenCalledWith(
      'ISSUE-1',
      expect.stringContaining('Task cancelled'),
      undefined,
    );
  });
});

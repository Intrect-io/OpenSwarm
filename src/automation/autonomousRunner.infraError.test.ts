import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { ITaskSource } from './taskSource.js';

// Regression for INT-2010: adapter CLI/infra failures (the worker/reviewer never
// ran) must NOT drive a completable issue to durable STUCK. They get a backoff
// retry, like rate limits — not a logStuck.

type AutonomousRunnerCtor = typeof import('./autonomousRunner.js').AutonomousRunner;
type RunnerExecutionModule = typeof import('./runnerExecution.js');

let tempDir = '';
let AutonomousRunner: AutonomousRunnerCtor;
let runnerExecution: RunnerExecutionModule;

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
  title: 'Edit some files',
  priority: 3,
  createdAt: Date.now(),
});

const result = (finalStatus: PipelineResult['finalStatus']): PipelineResult => ({
  success: false,
  sessionId: 'pipeline-1',
  iterations: 0,
  totalDuration: 5,
  finalStatus,
  stages: [],
  workerResult: { success: false, summary: '', filesChanged: [], commands: [], output: '', error: 'codex CLI failed with code 1' },
});

function mockTaskSource() {
  return {
    kind: 'local',
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
  } as unknown as ITaskSource & {
    updateState: ReturnType<typeof vi.fn>;
    addComment: ReturnType<typeof vi.fn>;
    logStuck: ReturnType<typeof vi.fn>;
  };
}

async function runN(scheduler: TaskScheduler, finalStatus: PipelineResult['finalStatus'], n: number) {
  for (let i = 0; i < n; i++) {
    scheduler.startTask(task(), '/repo', async () => result(finalStatus));
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

describe('AutonomousRunner infra_error handling (INT-2010)', () => {
  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'openswarm-infra-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(tempDir, 'task-state.json')); // canonical store (taskState/store)
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(tempDir, 'runner-task-state.json')); // legacy runnerState
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(tempDir, 'runner-rejection-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(tempDir, 'runner-pipeline-history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(tempDir, 'runner-decomposition-state.json'));
    ({ AutonomousRunner } = await import('./autonomousRunner.js'));
    runnerExecution = await import('./runnerExecution.js');
  }, 30000);

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('never marks STUCK even after many infra_error runs', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    await runN(scheduler, 'infra_error', 6); // well past MAX_RETRY_COUNT (4)

    expect(source.logStuck).not.toHaveBeenCalled();
    expect(source.updateState).not.toHaveBeenCalled(); // no failure-state sync
    const history = JSON.parse(readFileSync(join(tempDir, 'runner-pipeline-history.json'), 'utf8'));
    expect(history).toHaveLength(6);
    expect(history.every((entry: { failureCause?: string }) => entry.failureCause === 'infra')).toBe(true);
  });

  it('retries a pair-level stuck result with fresh outer context before requiring a human', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;
    const stuck: PipelineResult = {
      ...result('failed'),
      failureSignal: 'stuck',
      stuckReason: 'Same error repeated 3 times: schema validation failed',
      taskContext: { issueIdentifier: 'INT-1', projectPath: '/repo', taskTitle: 'Edit some files' },
    };

    scheduler.startTask(task(), '/repo', async () => stuck);
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(source.logStuck).not.toHaveBeenCalled();
    expect(source.updateState).toHaveBeenCalledWith('ISSUE-1', 'Todo');
    const state = JSON.parse(readFileSync(join(tempDir, 'runner-task-state.json'), 'utf8'));
    expect(state.failed['ISSUE-1']).toBe(1);
    expect(state.retryTimes['ISSUE-1']).toBeGreaterThan(Date.now());
  });

  it('does not persist a superseded open issue as completed (INT-2568)', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;
    const superseded: PipelineResult = { ...result('superseded'), success: true };

    scheduler.startTask(task(), '/repo', async () => superseded);
    await new Promise((resolve) => setTimeout(resolve, 25));

    const state = JSON.parse(readFileSync(join(tempDir, 'runner-task-state.json'), 'utf8'));
    expect(state.completed).not.toContain('ISSUE-1');
    expect(state.retryTimes['ISSUE-1']).toBeGreaterThan(Date.now());
    expect(scheduler.getStats()).toMatchObject({ completed: 0, failed: 0 });
    expect(source.updateState).not.toHaveBeenCalled();
  });

  it('still marks STUCK after MAX_RETRY_COUNT genuine failures (control)', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    await runN(scheduler, 'failed', 4);

    expect(source.logStuck).toHaveBeenCalled();
    expect(source.updateState).toHaveBeenCalledTimes(3); // retries only; terminal attempt is parked by logStuck
  });

  it('returns a retryable genuine failure to Todo immediately', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    await runN(scheduler, 'failed', 1);

    expect(source.updateState).toHaveBeenCalledWith('ISSUE-1', 'Todo');
  });

  it('does not expose terminal failure synchronization as retryable Todo', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);

    await runnerExecution.syncFailureState(task(), 'terminal retries exhausted');

    expect(source.updateState).not.toHaveBeenCalled();
    expect(source.addComment).toHaveBeenCalled();
  });

  it('reports a refused Todo transition instead of claiming sync success', async () => {
    const source = mockTaskSource();
    source.updateState.mockResolvedValue(false);
    runnerExecution.setTaskSource(source);

    const synced = await runnerExecution.syncFailureState(task(), 'retryable failure', 'Todo');

    expect(synced).toBe(false);
    expect(source.updateState).toHaveBeenCalledWith('ISSUE-1', 'Todo');
  });

  it('records rate limits before the retry-hold early return', async () => {
    const source = mockTaskSource();
    runnerExecution.setTaskSource(source);
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    await runN(scheduler, 'rate_limited', 1);

    const history = JSON.parse(readFileSync(join(tempDir, 'runner-pipeline-history.json'), 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0].failureCause).toBe('rate-limit');
  });

  it('records the scheduler hard watchdog as a timeout', async () => {
    vi.useFakeTimers();
    const runner = new AutonomousRunner(cfg());
    const scheduler = (runner as unknown as { scheduler: TaskScheduler }).scheduler;

    scheduler.startTask(task(), '/repo', async () => await new Promise<PipelineResult>(() => {}));
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    const history = JSON.parse(readFileSync(join(tempDir, 'runner-pipeline-history.json'), 'utf8'));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ failureCause: 'timeout', finalStatus: 'infra_error' });
  });
});

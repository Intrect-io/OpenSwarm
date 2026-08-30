// The serial (maxConcurrentTasks <= 1) execution path must emit the same
// task:started/completed lifecycle the scheduler emits for the parallel path.
// Without it the cockpit's per-task transcript buffer never reaches its
// retention timer and leaks for the process's lifetime. (INT-3402 review)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { HubEvent } from '../core/eventHub.js';

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({ recordTaskOutcome: vi.fn(async () => {}) }));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));

type InternalRunner = {
  executeDurably: (task: TaskItem, projectPath: string) => Promise<PipelineResult>;
  executeTaskPairMode: (task: TaskItem) => Promise<void>;
  resolveProjectPath: (task: TaskItem) => Promise<string | null>;
  config: { maxConcurrentTasks?: number };
};

const task: TaskItem = {
  id: 'task-local-id',
  issueId: 'issue-uuid',
  issueIdentifier: 'INT-1',
  title: 'Serial task',
  description: '',
  priority: 2,
  source: 'linear',
} as unknown as TaskItem;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'serial-lifecycle-'));
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

async function runSerial(result: PipelineResult | Error): Promise<HubEvent[]> {
  const [{ AutonomousRunner }, hub] = await Promise.all([
    import('./autonomousRunner.js'),
    import('../core/eventHub.js'),
  ]);
  hub.__resetForTests();

  const runner = new AutonomousRunner({
    linearTeamId: 'team',
    allowedProjects: ['/repo'],
    heartbeatSchedule: '0 * * * *',
    autoExecute: true,
    dryRun: true,
    pairMode: true,
    // The serial branch: no parallel scheduler, so nothing else emits lifecycle.
    maxConcurrentTasks: 1,
    automationLedgerMode: 'off',
    automationDbPath: join(root, 'automation.db'),
  });
  const internal = runner as unknown as InternalRunner;
  internal.resolveProjectPath = vi.fn(async () => '/repo');
  internal.executeDurably = vi.fn(async () => {
    if (result instanceof Error) throw result;
    return result;
  });

  try {
    await internal.executeTaskPairMode(task);
  } catch {
    // The throwing case still has to have emitted its terminal event.
  }
  return hub.getStageBuffer();
}

describe('serial execution lifecycle events (INT-3402)', () => {
  it('emits task:started and task:completed keyed by taskEventKey', async () => {
    const events = await runSerial({
      success: true,
      sessionId: 'session-1',
      stages: [],
      finalStatus: 'approved',
      totalDuration: 1_000,
      iterations: 1,
    } as unknown as PipelineResult);

    const started = events.find((e) => e.type === 'task:started');
    const completed = events.find((e) => e.type === 'task:completed');
    // issueId wins over the local task id — the key every other emitter uses.
    expect(started?.data).toMatchObject({ taskId: 'issue-uuid' });
    expect(completed?.data).toMatchObject({ taskId: 'issue-uuid', success: true, duration: 1_000 });
  });

  it('still emits a terminal event when the pipeline throws', async () => {
    const events = await runSerial(new Error('pipeline exploded'));
    const completed = events.find((e) => e.type === 'task:completed');
    expect(completed?.data).toMatchObject({ taskId: 'issue-uuid', success: false });
  });

  it('reaps the transcript buffer once the serial run completes', async () => {
    const { appendTaskLog, getTaskLog, TASK_LOG_RETENTION_MS, __resetTaskLogsForTests } =
      await import('../core/taskLogStore.js');
    __resetTaskLogsForTests();
    appendTaskLog('issue-uuid', 'worker', 'serial output');

    await runSerial({
      success: true,
      sessionId: 'session-1',
      stages: [],
      finalStatus: 'approved',
      totalDuration: 1_000,
      iterations: 1,
    } as unknown as PipelineResult);

    vi.useFakeTimers();
    try {
      // The completed event above armed the retention timer.
      vi.advanceTimersByTime(TASK_LOG_RETENTION_MS + 1);
      expect(getTaskLog('issue-uuid')).toBeNull();
    } finally {
      vi.useRealTimers();
      __resetTaskLogsForTests();
    }
  });
});

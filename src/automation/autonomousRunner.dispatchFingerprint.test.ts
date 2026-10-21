// ============================================
// OpenSwarm - idle_fill does not lift a park the issue's input never changed (AGT-4787)
// ============================================
//
// The module is tested on its own in dispatchFingerprint.test.ts. This pins the
// consumer: the real `filterAlreadyProcessed`, with a real ledger, must leave an
// unchanged parked issue alone and still lift it once a person has edited it.
// Each blocking case has a control that differs only in the input, so a gate
// that blocks everything — or nothing — cannot pass.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));

type InternalRunner = {
  scheduler: TaskScheduler;
  durableRuns: DurableRunCoordinator;
  filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[];
  resolveProjectPath(task: TaskItem): Promise<string | null>;
};

const REPO = '/repo';
const TASK: TaskItem = {
  id: 'AGT-1', issueId: 'AGT-1', issueIdentifier: 'AGT-1',
  source: 'linear', title: 'import is dropping rows', description: 'See the failing fixture.', priority: 2, createdAt: 0,
  linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
};
const EDITED: TaskItem = { ...TASK, description: 'See the failing fixture. Use the staging DB.' };

describe('idle_fill and the issue input (AGT-4787)', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-dispatch-fp-'));
    dbPath = join(root, 'runs.db');
    process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
    process.env.OPENSWARM_TASK_STATE_FILE = join(root, 'task-state.json');
    process.env.OPENSWARM_RUNNER_TASK_STATE_FILE = join(root, 'runner-state.json');
    process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE = join(root, 'rejections.json');
    process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE = join(root, 'history.json');
    process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE = join(root, 'decomposition.json');
    process.env.OPENSWARM_AUTOMATION_DB = dbPath;
  });

  afterEach(async () => {
    for (const key of [
      'OPENSWARM_COORDINATION_FILE', 'OPENSWARM_TASK_STATE_FILE', 'OPENSWARM_RUNNER_TASK_STATE_FILE',
      'OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE',
      'OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'OPENSWARM_AUTOMATION_DB',
    ]) delete process.env[key];
    (await import('./dispatchFingerprint.js')).resetDispatchFingerprintForTests();
    (await import('./execHold.js')).resetExecHoldForTests();
    (await import('../coordination/coordinationStore.js')).resetCoordinationStoreForTests();
    (await import('../coordination/coordinationTrace.js')).resetTraceDbForTests();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function makeRunner(): Promise<InternalRunner> {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: [REPO], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: dbPath,
    });
    const internal = runner as unknown as InternalRunner;
    internal.resolveProjectPath = vi.fn(async () => REPO);
    internal.durableRuns.observeTask(TASK, REPO);
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    return internal;
  }

  /** The run started on `task`'s input and then parked, as a real run does. */
  async function startedOn(task: TaskItem): Promise<void> {
    const fp = await import('./dispatchFingerprint.js');
    fp.resetDispatchFingerprintForTests();
    fp.recordRunInput(task);
  }

  it('does not lift a NEEDS_HUMAN park while the issue is unchanged', async () => {
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    await startedOn(TASK);
    const resume = vi.spyOn(internal.durableRuns, 'resumeNeedsHuman');

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    expect(resume).not.toHaveBeenCalled();
  });

  it('lifts the same park once a person edited the issue (control)', async () => {
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    await startedOn(TASK);

    expect(internal.filterAlreadyProcessed([EDITED])).toEqual([EDITED]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
  });

  it('lifts a park for an issue it never recorded a run for (control: no record never blocks)', async () => {
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
  });

  it('does not pull a RETRY_AT backoff forward while the issue is unchanged, and does once it is edited', async () => {
    const internal = await makeRunner();
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const claim = ledger.claimRun('AGT-1', { ownerInstanceId: 'seed', leaseMs: 60_000, maxActiveForProject: 1 });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'RETRY_AT', { retryAt: Date.now() + 3_600_000, errorCode: 'infra_error' })).toBe(true);
    ledger.close();
    await startedOn(TASK);

    const markReady = vi.spyOn(internal.durableRuns, 'markReady');
    expect(internal.filterAlreadyProcessed([TASK])).toEqual([]);
    expect(markReady).not.toHaveBeenCalled();
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('RETRY_AT');

    expect(internal.filterAlreadyProcessed([EDITED])).toEqual([EDITED]);
    expect(markReady).toHaveBeenCalledWith('AGT-1');
  });

  it('ignores the daemon\'s own writes: a changed update time alone does not unblock', async () => {
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    await startedOn(TASK);
    // The daemon's progress comment and state change bump the tracker's update time.
    const touchedByDaemon: TaskItem = { ...TASK, trackerUpdatedAt: Date.now() + 60_000 };

    expect(internal.filterAlreadyProcessed([touchedByDaemon])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
  });
});

// ============================================
// OpenSwarm - `exec --issue` hold keeps idle_fill off a run its external
// orchestrator is watching (the elevation that must not be silently ignored)
// ============================================
//
// `openswarm exec --issue INT-123` hands a run to an external orchestrator and
// the daemon's idle_fill is designed to lift parks (AGT-4257). Without a hold
// that lift re-runs the task out from under the `exec await` that is waiting on
// it — the AGT-4155/AGT-4306 park→idle_fill loop reached through elevation.
// These tests pin the three idle_fill branches of `filterAlreadyProcessed`
// closed while a hold is in force, and prove the same branches still open when
// it is not — the control is what makes the gate, not the fixture, the subject.
//
// Every module under test is loaded with a dynamic import AFTER the temp DB env
// is set and `vi.resetModules()` has run: a static import would bind the module
// graph (hold store, ledger, trace) to whatever OPENSWARM_AUTOMATION_DB was at
// collection time, i.e. not this test's database.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
  failedTaskRetryTimes: Map<string, number>;
  filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[];
  resolveProjectPath(task: TaskItem): Promise<string | null>;
};

const REPO = '/repo';
const TASK: TaskItem = {
  id: 'AGT-1', issueId: 'AGT-1', issueIdentifier: 'AGT-1',
  source: 'linear', title: 'blocked on Google credentials', priority: 2, createdAt: 0,
  linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
};

const SECOND: TaskItem = {
  ...TASK, id: 'AGT-2', issueId: 'AGT-2', issueIdentifier: 'AGT-2', title: 'also parked',
};

describe('exec hold gates the idle_fill branches that would ignore an elevation', () => {
  let root: string;
  let dbPath: string;

  // Every test re-imports the runner after `vi.resetModules()`, but the first one
  // also paid the one-off transform of autonomousRunner's whole import chain and
  // ran past the 30s test timeout under a loaded worker pool. Warm the transform
  // cache here, under a hook budget sized for it, then drop the evaluated module
  // so the first test still binds the env its own beforeEach sets.
  beforeAll(async () => {
    await import('./autonomousRunner.js');
    vi.resetModules();
  }, 120_000);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-exec-hold-'));
    dbPath = join(root, 'runs.db');
    process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
    process.env.OPENSWARM_TASK_STATE_FILE = join(root, 'task-state.json');
    process.env.OPENSWARM_RUNNER_TASK_STATE_FILE = join(root, 'runner-state.json');
    process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE = join(root, 'rejections.json');
    process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE = join(root, 'history.json');
    process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE = join(root, 'decomposition.json');
    // The hold store, the run ledger and the coordination trace all resolve the
    // same durable database. Production config does the same; tests must not
    // split it.
    process.env.OPENSWARM_AUTOMATION_DB = dbPath;
  });

  afterEach(async () => {
    delete process.env.OPENSWARM_COORDINATION_FILE;
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_TASK_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE;
    delete process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE;
    delete process.env.OPENSWARM_AUTOMATION_DB;
    const hold = await import('./execHold.js');
    hold.resetExecHoldForTests();
    const store = await import('../coordination/coordinationStore.js');
    store.resetCoordinationStoreForTests();
    const trace = await import('../coordination/coordinationTrace.js');
    trace.resetTraceDbForTests();
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
    return internal;
  }

  /** Import the hold store after `resetModules` so it binds this test's temp DB. */
  async function markHeld(issueId: string): Promise<void> {
    const hold = await import('./execHold.js');
    hold.resetExecHoldForTests();
    hold.markExecHold(issueId, 'external:cli');
  }

  it('does not idle-fill a NEEDS_HUMAN park while an external orchestrator holds it', async () => {
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    await markHeld('AGT-1');

    // Installed before the filter runs: the point is that no resume path fires
    // at all, not merely that the row keeps its state.
    const resume = vi.spyOn(internal.durableRuns, 'resumeNeedsHuman');

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    expect(resume).not.toHaveBeenCalled();
    internal.durableRuns.close();
  });

  it('lifts the same NEEDS_HUMAN park when no hold is present (control)', async () => {
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('does not pull a RETRY_AT backoff forward while the run is held', async () => {
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const claim = ledger.claimRun('AGT-1', { ownerInstanceId: 'seed', leaseMs: 60_000, maxActiveForProject: 1 });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'RETRY_AT', {
      retryAt: Date.now() + 3_600_000, errorCode: 'infra_error',
    })).toBe(true);
    ledger.close();
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('RETRY_AT');
    await markHeld('AGT-1');

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('RETRY_AT');
    internal.durableRuns.close();
  });

  it('lets a free slot chew the same RETRY_AT backoff when no hold is present (control)', async () => {
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const claim = ledger.claimRun('AGT-1', { ownerInstanceId: 'seed', leaseMs: 60_000, maxActiveForProject: 1 });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'RETRY_AT', {
      retryAt: Date.now() + 3_600_000, errorCode: 'infra_error',
    })).toBe(true);
    ledger.close();

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('does not reopen a finished Backlog run while the run is held', async () => {
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const claim = ledger.claimRun('AGT-1', { ownerInstanceId: 'seed', leaseMs: 60_000, maxActiveForProject: 1 });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'EXECUTING', {})).toBe(true);
    expect(ledger.transition(claim!, 'SYNC_PENDING', {})).toBe(true);
    expect(ledger.finalizeSyncedRun('AGT-1')).toBe(true);
    ledger.close();
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('DONE');
    await markHeld('AGT-1');

    const backlog: TaskItem = { ...TASK, linearState: 'Backlog' };
    expect(internal.filterAlreadyProcessed([backlog])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('DONE');
    internal.durableRuns.close();
  });

  it('reopens the same finished Backlog run when no hold is present (control)', async () => {
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const claim = ledger.claimRun('AGT-1', { ownerInstanceId: 'seed', leaseMs: 60_000, maxActiveForProject: 1 });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'EXECUTING', {})).toBe(true);
    expect(ledger.transition(claim!, 'SYNC_PENDING', {})).toBe(true);
    expect(ledger.finalizeSyncedRun('AGT-1')).toBe(true);
    ledger.close();
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('DONE');

    const backlog: TaskItem = { ...TASK, linearState: 'Backlog' };
    expect(internal.filterAlreadyProcessed([backlog])).toEqual([backlog]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('lifts only the unheld issue in a pass where another issue is held', async () => {
    // A `heldExecRuns` Set applied coarsely (e.g. "any hold present ⇒ skip idle
    // fill for everything") would starve the unheld task. The gate is per-id.
    const internal = await makeRunner();
    internal.durableRuns.observeTask(SECOND, REPO);
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    internal.durableRuns.markNeedsHuman('AGT-2', 'Reviewer rejected 4 attempts: still failing lint');
    await markHeld('AGT-1');

    const selected = internal.filterAlreadyProcessed([TASK, SECOND]);

    expect(selected).toEqual([SECOND]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    expect(internal.durableRuns.getRun('AGT-2')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });
});

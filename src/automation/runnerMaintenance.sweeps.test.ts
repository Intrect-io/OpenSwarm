// Created: 2026-11-22
// Purpose: pin the MaintenanceHost contract for the lanes slice F moved — the ledger retrospective, decomposed-parent
//          completion and stalled In Progress sweep read the runner through the host at call time (AGT-4867 slice F)
// Dependencies: runnerMaintenance, autonomousRunner
// Test Status: passing

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { ITaskSource } from './taskSource.js';
import { setTaskSource } from './runnerExecution.js';
import {
  createMaintenanceState,
  maybeRunLedgerRetrospective,
  reconcileStalledInProgress,
  type MaintenanceHost,
} from './runnerMaintenance.js';

const { runLedgerRetrospectiveMock } = vi.hoisted(() => ({
  runLedgerRetrospectiveMock: vi.fn(async () => ({ filed: true, identifier: 'RET-1', reason: 'largest bucket' })),
}));
vi.mock('./ledgerRetrospective.js', () => ({ runLedgerRetrospective: runLedgerRetrospectiveMock }));

function fakeHost(over: Partial<MaintenanceHost> = {}): MaintenanceHost {
  return {
    maintenance: createMaintenanceState(),
    config: { allowedProjects: [], retrospectiveProjectId: 'proj-1' },
    scheduler: { isTaskQueued: () => false, isTaskRunning: () => false },
    durableRuns: { getRun: () => null, recordPullRequestState: () => false, isPrimary: true } as unknown as MaintenanceHost['durableRuns'],
    stopping: false,
    syslog: () => {},
    resolveProjectPath: async () => null,
    resolveRegistryProjectId: (projectPath) => projectPath,
    groupTasksForGrooming: async () => new Map(),
    completeParentIfChildrenMerged: async () => {},
    ...over,
  };
}

describe('MaintenanceHost sweeps (AGT-4867 slice F)', () => {
  beforeEach(() => {
    runLedgerRetrospectiveMock.mockClear();
    setTaskSource({ kind: 'local' } as unknown as ITaskSource);
  });

  it('the retrospective files through the host and logs through its syslog', async () => {
    const syslog = vi.fn();
    await maybeRunLedgerRetrospective(fakeHost({ syslog }));
    expect(runLedgerRetrospectiveMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1' }));
    expect(syslog).toHaveBeenCalledWith(expect.stringContaining('Retrospective filed RET-1'));
  });

  it('the retrospective stays silent while the host is stopping or not primary', async () => {
    await maybeRunLedgerRetrospective(fakeHost({ stopping: true }));
    await maybeRunLedgerRetrospective(fakeHost({
      durableRuns: { getRun: () => null, recordPullRequestState: () => false, isPrimary: false } as unknown as MaintenanceHost['durableRuns'],
    }));
    expect(runLedgerRetrospectiveMock).not.toHaveBeenCalled();
  });

  it('the stalled sweep leaves tasks untouched without a Linear source', async () => {
    const resolveProjectPath = vi.fn(async () => '/repo');
    const tasks = [{ id: 'T-1', issueId: 'T-1', linearState: 'In Progress' } as TaskItem];
    expect(await reconcileStalledInProgress(fakeHost({ resolveProjectPath }), tasks)).toBe(tasks);
    expect(resolveProjectPath).not.toHaveBeenCalled();
  });
});

describe('the runner maintenance host reads stopping and syslog at call time (AGT-4867 slice F)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-maintenance-sweeps-'));
    for (const [key, file] of [
      ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
      ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
      ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'],
    ] as const) vi.stubEnv(key, join(root, file));
    runLedgerRetrospectiveMock.mockClear();
    setTaskSource({ kind: 'local' } as unknown as ITaskSource);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  type Internal = {
    stopping: boolean;
    durableRuns: DurableRunCoordinator;
    syslog(line: string): void;
    maintenanceHost(): MaintenanceHost;
    maybeRunLedgerRetrospective(): Promise<void>;
  };

  it('honours stopping, durableRuns and syslog changed after the host is built', async () => {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: false, dryRun: true, automationLedgerMode: 'off', retrospectiveProjectId: 'proj-1',
    }) as unknown as Internal;
    const host = runner.maintenanceHost();
    // Ledger 'off' is not primary: nothing is filed.
    await runner.maybeRunLedgerRetrospective();
    expect(runLedgerRetrospectiveMock).not.toHaveBeenCalled();

    runner.durableRuns = { isPrimary: true } as unknown as DurableRunCoordinator;
    const syslog = vi.fn();
    runner.syslog = syslog;
    expect(runner.maintenanceHost()).toBe(host);
    await runner.maybeRunLedgerRetrospective();
    expect(runLedgerRetrospectiveMock).toHaveBeenCalledTimes(1);
    expect(syslog).toHaveBeenCalledWith(expect.stringContaining('RET-1'));

    runner.stopping = true;
    expect(host.stopping).toBe(true);
    await runner.maybeRunLedgerRetrospective();
    expect(runLedgerRetrospectiveMock).toHaveBeenCalledTimes(1);
  });
});

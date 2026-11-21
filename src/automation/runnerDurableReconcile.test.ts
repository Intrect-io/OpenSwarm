// Created: 2026-11-22
// Purpose: pin the DurableReconcileHost contract — state is per runner, runner methods are read at call time,
//          and concurrent outbox drains coalesce into one in-flight drain per runner (AGT-4867 slice E)
// Dependencies: runnerDurableReconcile, autonomousRunner
// Test Status: passing

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { EffectClaim } from './runLedger.js';
import {
  createDurableReconcileState,
  drainDurableOutbox,
  executeDurably,
  migrateLegacyRunState,
  type DurableReconcileHost,
} from './runnerDurableReconcile.js';

vi.mock('../coordination/coordinationThreadOutbox.js', () => ({
  drainCoordinationThreadOutbox: vi.fn(async () => ({ delivered: 0, pending: 0, warnings: [] })),
}));
vi.mock('../coordination/channelQueue.js', () => ({ interruptEndedTaskDeliveries: vi.fn() }));
vi.mock('../support/repoMetadata.js', () => ({ loadRepoMetadata: vi.fn(async () => null) }));
vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));

type Gate = { promise: Promise<void>; open(): void; fail(error: Error): void };
function gate(): Gate {
  let open!: () => void;
  let fail!: (error: Error) => void;
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject; });
  return { promise, open, fail };
}

const effect = { issueId: 'ISSUE-1' } as unknown as EffectClaim;

/** A primary-ledger stub whose drain waits on a gate and hands one effect to the deliverer. */
function stubLedger(drainGate: Gate) {
  const drainOutbox = vi.fn(async (deliver: (claim: EffectClaim) => Promise<void>) => {
    await drainGate.promise;
    await deliver(effect);
    return { applied: 1, retried: 0, dead: 0 };
  });
  const ledger = {
    isPrimary: true,
    drainOutbox,
    getRun: vi.fn(() => ({ state: 'DONE' })),
  };
  return { ledger: ledger as unknown as DurableRunCoordinator, drainOutbox };
}

function fakeHost(durableRuns: DurableRunCoordinator): DurableReconcileHost {
  return {
    durableReconcile: createDurableReconcileState(),
    config: { linearTeamId: 'team', allowedProjects: [], heartbeatSchedule: '0 * * * *', autoExecute: true },
    durableRuns,
    pauses: { pausedResult: () => undefined, consumePauseCancel: () => false },
    stopping: false,
    completedTaskIds: new Set<string>(),
    failedTaskCounts: new Map<string, number>(),
    failedTaskRetryTimes: new Map<string, number>(),
    consecutiveInfraErrorCounts: new Map<string, number>(),
    lastFailureDetails: new Map(),
    maxRetryCount: 4,
    getRunningTasks: () => [],
    syslog: () => {},
    saveTaskState: () => {},
    resolveProjectPath: async () => null,
    executePipeline: async () => { throw new Error('not expected'); },
    deliverOutboxEffect: async () => {},
    drainDurableOutbox: async () => {},
  };
}

const task = { id: 'ISSUE-1', issueId: 'ISSUE-1', issueIdentifier: 'INT-1', title: 'Task', source: 'linear', priority: 2, createdAt: 0 } as TaskItem;

describe('DurableReconcileHost contract (AGT-4867 slice E)', () => {
  it('coalesces concurrent drains into one in-flight drain held on the host state, cleared in finally', async () => {
    const drainGate = gate();
    const { ledger, drainOutbox } = stubLedger(drainGate);
    const host = fakeHost(ledger);
    const delivered: EffectClaim[] = [];
    host.deliverOutboxEffect = async (claim) => { delivered.push(claim); };
    const saved = vi.fn();
    host.saveTaskState = saved;

    const first = drainDurableOutbox(host);
    const second = drainDurableOutbox(host);
    await vi.waitFor(() => expect(drainOutbox).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    const inFlight = host.durableReconcile.outboxDrain;
    expect(inFlight).not.toBeNull();
    const third = drainDurableOutbox(host);
    await Promise.resolve();
    await Promise.resolve();
    expect(host.durableReconcile.outboxDrain).toBe(inFlight);
    expect(drainOutbox).toHaveBeenCalledTimes(1);

    drainGate.open();
    await third;
    await Promise.all([first, second]);
    expect(drainOutbox).toHaveBeenCalledTimes(1);
    expect(delivered).toEqual([effect]);
    expect(host.completedTaskIds.has('ISSUE-1')).toBe(true);
    expect(saved).toHaveBeenCalledTimes(1);
    expect(host.durableReconcile.outboxDrain).toBeNull();
  });

  it('clears the in-flight drain when it rejects, so the next drain starts fresh', async () => {
    const drainGate = gate();
    const { ledger, drainOutbox } = stubLedger(drainGate);
    const host = fakeHost(ledger);

    const first = drainDurableOutbox(host);
    await vi.waitFor(() => expect(drainOutbox).toHaveBeenCalledTimes(1));
    drainGate.fail(new Error('ledger down'));
    await expect(first).rejects.toThrow('ledger down');
    expect(host.durableReconcile.outboxDrain).toBeNull();

    drainOutbox.mockImplementationOnce(async () => ({ applied: 0, retried: 0, dead: 0 }));
    await drainDurableOutbox(host);
    expect(drainOutbox).toHaveBeenCalledTimes(2);
  });

  it('skips the ledger drain on a non-primary ledger and reads stopping through the host', async () => {
    const drainOutbox = vi.fn();
    const host = fakeHost({ isPrimary: false, drainOutbox } as unknown as DurableRunCoordinator);
    await drainDurableOutbox(host);
    expect(drainOutbox).not.toHaveBeenCalled();
    expect(host.durableReconcile.outboxDrain).toBeNull();

    const stoppingHost = { ...fakeHost({ isPrimary: true } as unknown as DurableRunCoordinator), stopping: true };
    const resolveProjectPath = vi.fn(async () => '/repo');
    stoppingHost.resolveProjectPath = resolveProjectPath;
    await migrateLegacyRunState(stoppingHost, [task]);
    expect(resolveProjectPath).not.toHaveBeenCalled();
    const result = await executeDurably(stoppingHost, task, '/repo');
    expect(result.finalStatus).toBe('cancelled');
  });
});

describe('the runner builds its durable-reconcile host late-bound (AGT-4867 slice E)', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-durable-reconcile-host-'));
    for (const [key, file] of [
      ['OPENSWARM_TASK_STATE_FILE', 'task-state.json'], ['OPENSWARM_RUNNER_TASK_STATE_FILE', 'runner-state.json'],
      ['OPENSWARM_RUNNER_REJECTION_STATE_FILE', 'rejections.json'], ['OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', 'history.json'],
      ['OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', 'decomposition.json'],
    ] as const) vi.stubEnv(key, join(root, file));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  type Internal = {
    durableRuns: DurableRunCoordinator;
    durableReconcileState: { outboxDrain: Promise<void> | null };
    deliverOutboxEffect(claim: EffectClaim): Promise<void>;
    saveTaskState(): void;
    getRunningTasks(): unknown[];
    executePipeline(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult>;
    drainDurableOutbox(): Promise<void>;
    executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult>;
  };

  async function makeRunner(): Promise<Internal> {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    return new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true, automationLedgerMode: 'off',
    }) as unknown as Internal;
  }

  it('honours members reassigned after the host is built, and keeps one in-flight drain per runner', async () => {
    const a = await makeRunner();
    const b = await makeRunner();
    // Build (and cache) each host before reassigning anything: the ledger is 'off' here.
    await a.drainDurableOutbox();
    await b.drainDurableOutbox();

    const gateA = gate();
    const gateB = gate();
    const ledgerA = stubLedger(gateA);
    const ledgerB = stubLedger(gateB);
    a.durableRuns = ledgerA.ledger;
    b.durableRuns = ledgerB.ledger;
    const deliveredA = vi.fn(async () => {});
    const deliveredB = vi.fn(async () => {});
    a.deliverOutboxEffect = deliveredA;
    b.deliverOutboxEffect = deliveredB;
    a.saveTaskState = vi.fn();
    b.saveTaskState = vi.fn();
    const runningA = vi.fn(() => []);
    a.getRunningTasks = runningA;

    const a1 = a.drainDurableOutbox();
    const a2 = a.drainDurableOutbox();
    const b1 = b.drainDurableOutbox();
    await vi.waitFor(() => {
      expect(ledgerA.drainOutbox).toHaveBeenCalledTimes(1);
      expect(ledgerB.drainOutbox).toHaveBeenCalledTimes(1);
    });
    await Promise.resolve();
    // Both runners have their own drain in flight at the same time.
    expect(a.durableReconcileState.outboxDrain).not.toBeNull();
    expect(b.durableReconcileState.outboxDrain).not.toBeNull();
    expect(a.durableReconcileState.outboxDrain).not.toBe(b.durableReconcileState.outboxDrain);

    gateA.open();
    gateB.open();
    await Promise.all([a1, a2, b1]);
    expect(ledgerA.drainOutbox).toHaveBeenCalledTimes(1);
    expect(ledgerB.drainOutbox).toHaveBeenCalledTimes(1);
    expect(deliveredA).toHaveBeenCalledWith(effect);
    expect(deliveredB).toHaveBeenCalledWith(effect);
    expect(runningA).toHaveBeenCalled();
    expect(a.durableReconcileState.outboxDrain).toBeNull();
    expect(b.durableReconcileState.outboxDrain).toBeNull();
  });

  it('runs executeDurably through the reassigned ledger and executePipeline', async () => {
    const runner = await makeRunner();
    await runner.drainDurableOutbox(); // build the host first
    const expected = { success: true, finalStatus: 'approved' } as PipelineResult;
    const executePipeline = vi.fn(async () => expected);
    runner.executePipeline = executePipeline;
    const execute = vi.fn(async (
      _task: TaskItem,
      _projectPath: string,
      run: (durability: unknown, leaseSignal: AbortSignal) => Promise<PipelineResult>,
    ) => run({}, new AbortController().signal));
    runner.durableRuns = { isPrimary: true, execute } as unknown as DurableRunCoordinator;

    await expect(runner.executeDurably(task, '/repo')).resolves.toBe(expected);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(executePipeline).toHaveBeenCalledTimes(1);
    expect(executePipeline.mock.calls[0][0]).toBe(task);
  });
});

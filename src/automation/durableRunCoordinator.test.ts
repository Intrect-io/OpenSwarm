import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator, formatFenceWait, retryAtFor, runRecordToTask } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';

const roots: string[] = [];

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-coordinator-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function task(id: string, state = 'Todo'): TaskItem {
  return {
    id,
    issueId: id,
    issueIdentifier: id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 2,
    createdAt: Date.now(),
    linearState: state,
    linearProject: { id: 'project', name: 'Repo' },
  };
}

function result(success = true): PipelineResult {
  return {
    success,
    sessionId: 'session-1',
    stages: [],
    finalStatus: success ? 'approved' : 'infra_error',
    totalDuration: 100,
    iterations: 1,
  };
}

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('DurableRunCoordinator', () => {
  it('exponentially backs off repeated superseded attempts with a six-hour cap', () => {
    const superseded = { ...result(true), finalStatus: 'superseded' as const };

    expect(retryAtFor(superseded, 1_000, 1)).toBe(1_000 + 5 * 60_000);
    expect(retryAtFor(superseded, 1_000, 2)).toBe(1_000 + 10 * 60_000);
    expect(retryAtFor(superseded, 1_000, 3)).toBe(1_000 + 20 * 60_000);
    expect(retryAtFor(superseded, 1_000, 20)).toBe(1_000 + 6 * 60 * 60_000);
  });

  it('reports the deadline the age sweep will actually act on', () => {
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'daemon', reconcileAbandonMs: 10 * 60_000,
    });

    // Read off updatedAt — the same field the sweep compares — so the reported
    // wait and the actual free cannot drift. (AGT-4126)
    expect(coordinator.reconcileAbandonDeadline({ updatedAt: 1_000 })).toBe(1_000 + 10 * 60_000);
  });

  it('names a checkable condition and a time in the fence message', () => {
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'daemon', reconcileAbandonMs: 10 * 60_000,
    });

    const message = coordinator.fenceWaitMessage({ updatedAt: 0, identifier: 'AX-879', issueId: 'uuid-1' });

    expect(message).toContain('AX-879');
    expect(message).toContain('1970-01-01T00:10:00.000Z');
    // Both exits the sweep has, and only those: nothing renews a row that has
    // already sat through a full lease of silence.
    expect(message).toContain('by age');
    expect(message).toContain('exited');
    expect(message).not.toContain('renew');
    // The old wording pointed at an event no one can observe once the container
    // holding that executor has been replaced, so a self-healing wait read as a
    // permanent wedge.
    expect(message).not.toContain('original executor');
  });

  it('falls back to the issue id when a run has no identifier', () => {
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'daemon', reconcileAbandonMs: 60_000,
    });

    expect(coordinator.fenceWaitMessage({ updatedAt: 0, issueId: 'uuid-1' })).toContain('uuid-1');
  });

  it('formats the wait without needing a coordinator', () => {
    expect(formatFenceWait('AX-1', 0)).toBe(
      '[Reconciler] Keeping AX-1 fenced — its claim is still held;'
      + ' frees at 1970-01-01T00:00:00.000Z by age,'
      + ' or sooner if its owner process is seen to have exited',
    );
  });

  it('admits only one concurrent run per repository across coordinator instances', async () => {
    const path = dbPath();
    const first = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'a' });
    const second = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'b' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const firstRun = first.execute(task('A'), '/repo', async () => {
      await held;
      return result();
    }, {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `A:${claim.attemptNo}`, payload: {},
      }),
    });
    const secondResult = await second.execute(task('B'), '/repo', async () => result());

    expect(secondResult.finalStatus).toBe('superseded');
    expect(second.getRun('B')).toMatchObject({ state: 'RETRY_AT' });
    expect(second.getRun('B')?.retryAt).toBeGreaterThan(Date.now());
    release();
    expect((await firstRun).success).toBe(true);
    first.close();
    second.close();
  });

  it('runs disjoint same-repository scopes concurrently in separate worktrees', async () => {
    const path = dbPath();
    const first = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'a', maxActiveForProject: 2 });
    const second = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'b', maxActiveForProject: 2 });
    const firstTask = { ...task('PAR-A'), fileScope: ['src/a.ts'] };
    const secondTask = { ...task('PAR-B'), fileScope: ['src/b.ts'] };
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });

    const firstRun = first.execute(firstTask, '/repo', async () => {
      await held;
      return result();
    }, { admission: { maxConcurrent: 2, conflictScope: firstTask.fileScope } });
    await Promise.resolve();
    const secondResult = await second.execute(secondTask, '/repo', async () => result(), {
      admission: { maxConcurrent: 2, conflictScope: secondTask.fileScope },
    });

    expect(secondResult.success).toBe(true);
    expect(first.getRun('PAR-A')?.state).toBe('EXECUTING');
    release();
    expect((await firstRun).success).toBe(true);
    first.close();
    second.close();
  });

  it('records worktree, verification, publication, and durable sync state', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const pipeline = await coordinator.execute(task('FLOW'), '/repo', async (hooks) => {
      expect(await hooks.onWorktree({
        issueId: 'FLOW', branchName: 'swarm/FLOW',
        worktreePath: '/repo/worktree/FLOW', originalPath: '/repo',
      })).toBe(true);
      expect(await hooks.onStage('worker')).toBe(true);
      expect(await hooks.onStage('reviewer')).toBe(true);
      expect(await hooks.onStage('tester')).toBe(true);
      expect(await hooks.beforePublish()).toBe(true);
      expect(await hooks.onPublication('https://github.test/pr/1', 'abc123')).toBe(true);
      return { ...result(), prUrl: 'https://github.test/pr/1' };
    }, {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete',
        dedupeKey: `FLOW:${claim.attemptNo}`,
        payload: { marker: 'FLOW:1' },
      }),
    });

    expect(pipeline.success).toBe(true);
    expect(coordinator.getRun('FLOW')).toMatchObject({
      state: 'SYNC_PENDING',
      worktreePath: '/repo/worktree/FLOW',
      branchName: 'swarm/FLOW',
      prUrl: 'https://github.test/pr/1',
      headSha: 'abc123',
    });
    expect(coordinator.getProtectedWorktreePaths('/repo')).toEqual(new Set(['/repo/worktree/FLOW']));
    coordinator.close();
  });

  it('renews a live execution lease before it can expire', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'renew-owner', leaseMs: 3_000,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = coordinator.execute(task('RENEW-LEASE'), '/repo', async (_hooks, signal) => {
      expect(signal.aborted).toBe(false);
      await held;
      return result();
    });
    await Promise.resolve();

    expect(ledger.getRun('RENEW-LEASE')?.leaseExpiresAt).toBe(4_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(ledger.getRun('RENEW-LEASE')?.leaseExpiresAt).toBe(5_000);

    release();
    await expect(running).resolves.toMatchObject({ success: true, finalStatus: 'approved' });
    expect(ledger.getRun('RENEW-LEASE')?.state).toBe('DONE');
    coordinator.close();
    ledger.close();
  });

  it('fails closed when ledger ownership reads and exit acknowledgement both fail transiently', async () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'unreadable-ledger', leaseMs: 3_000,
    });
    const ownershipProbe = vi.spyOn(ledger, 'isClaimCurrent').mockImplementation(() => {
      throw new Error('sqlite read failed');
    });
    const exitAck = vi.spyOn(ledger, 'confirmExecutorExit').mockImplementation(() => {
      throw new Error('sqlite writer busy');
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fenced = await coordinator.execute(task('LEDGER-READ-FAIL'), '/repo', async () => result());
    expect(fenced).toMatchObject({
      success: false,
      finalStatus: 'infra_error',
      failureSignal: 'timeout',
    });
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Executor-exit acknowledgement deferred'),
      expect.any(Error),
    );
    expect(ledger.getRun('LEDGER-READ-FAIL')).toMatchObject({
      state: 'EXECUTING',
      ownerInstanceId: 'unreadable-ledger',
    });

    ownershipProbe.mockRestore();
    exitAck.mockRestore();
    warning.mockRestore();
    // 2, not 1: the expired-lease reconciliation itself, plus the same call's
    // NEEDS_RECONCILE pass auto-reopening the row straight to READY once its
    // owner/lease just cleared and nothing was ever published (AGT-4054
    // follow-up — previously this sat in NEEDS_RECONCILE forever, unclaimable
    // yet still counted against the project's admission cap).
    expect(coordinator.reconcile(Date.now() + 4_000)).toHaveLength(2);
    expect(ledger.getRun('LEDGER-READ-FAIL')).toMatchObject({
      state: 'READY',
      ownerInstanceId: undefined,
      leaseToken: undefined,
    });
    coordinator.close();
    ledger.close();
  });

  it('fences a lease-renewal loser and releases ownership only after reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'renew-loser', leaseMs: 3_000,
    });
    vi.spyOn(ledger, 'renewLease').mockReturnValue(null);
    let release!: () => void;
    let leaseSignal!: AbortSignal;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const running = coordinator.execute(task('LOSE-LEASE'), '/repo', async (_hooks, signal) => {
      leaseSignal = signal;
      await held;
      return result();
    });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(leaseSignal.aborted).toBe(true);
    release();
    await expect(running).resolves.toMatchObject({
      success: false,
      finalStatus: 'infra_error',
      failureSignal: 'timeout',
    });
    expect(ledger.getRun('LOSE-LEASE')).toMatchObject({
      state: 'EXECUTING',
      ownerInstanceId: 'renew-loser',
    });

    vi.setSystemTime(5_000);
    // 2, not 1 — see the identical note in the ledger-read-failure test above
    // (AGT-4054 follow-up): auto-reopen fires in the same call that clears
    // the loser's owner/lease, since nothing was ever published.
    expect(coordinator.reconcile(5_000)).toHaveLength(2);
    expect(ledger.getRun('LOSE-LEASE')).toMatchObject({
      state: 'READY',
      ownerInstanceId: undefined,
      leaseToken: undefined,
    });
    coordinator.close();
    ledger.close();
  });

  it('records executor throws as retryable failures before rethrowing', async () => {
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'throw-owner',
    });

    await expect(coordinator.execute(task('EXECUTOR-THROW'), '/repo', async () => {
      throw new Error('worker crashed');
    })).rejects.toThrow('worker crashed');
    expect(coordinator.getRun('EXECUTOR-THROW')).toMatchObject({
      state: 'RETRY_AT',
      lastErrorCode: 'executor_throw',
      lastErrorMessage: 'worker crashed',
    });
    coordinator.close();
  });

  it("keeps an operator park as the run's own retry reason", async () => {
    // Everything downstream reads the park off `lastErrorCode`: it is what says a
    // backoff may be cut short once the answer lands, and it expires with its own
    // attempt because the next transition overwrites it. Recorded as a plain
    // failure — by a branch added above the default below, or by the pipeline
    // stopping naming the status — the task sits out its full backoff with the
    // answer already on the board, and nothing here would say so.
    //
    // The literal is deliberate on both sides: it pins that the pipeline's
    // `finalStatus` and the code stored on the run are the same wire value.
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'park-owner',
    });

    await coordinator.execute(task('AGT-PARK'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'waiting_on_operator',
    }));

    expect(coordinator.getRun('AGT-PARK')).toMatchObject({
      state: 'RETRY_AT',
      lastErrorCode: 'waiting_on_operator',
    });
    coordinator.close();
  });

  it('a parked result carrying a prUrl stops being a park (AGT-4076 guard)', async () => {
    // Why the parked-publish path in runnerExecution attaches the PR to the
    // LEDGER but never writes `result.prUrl`. `publishedNeedsReconcile` treats
    // any prUrl on a non-approved result as publication debt, so setting it
    // would turn an operator park — which frees the repository admission slot
    // and resumes on the answer — into a NEEDS_RECONCILE row that holds one.
    // If this classification ever changes, the comment in runnerExecution.ts
    // is stale and this test is where that shows up.
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), instanceId: 'park-with-pr',
    });

    await coordinator.execute(task('AGT-PARK-PR'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'waiting_on_operator',
      prUrl: 'https://github.com/o/r/pull/1',
    }));

    expect(coordinator.getRun('AGT-PARK-PR')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      lastErrorCode: 'publication_reconcile',
    });
    coordinator.close();
  });

  it('reconciles a published PR before any retry when publication attachment throws', async () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'daemon',
    });
    vi.spyOn(ledger, 'attachPublication').mockImplementation(() => {
      throw new Error('database unavailable after GitHub accepted the PR');
    });

    const published = await coordinator.execute(task('PUBLISH-RACE'), '/repo', async (hooks) => {
      expect(await hooks.beforePublish()).toBe(true);
      const prUrl = 'https://github.test/pr/42';
      try {
        await hooks.onPublication(prUrl, 'deadbeef');
      } catch {
        // executePipeline preserves the URL and converts this exact boundary
        // failure into an infra_error result.
      }
      return { ...result(false), prUrl };
    }, {
      admission: { maxFailuresPerHour: 1 },
    });

    expect(published).toMatchObject({
      success: false,
      finalStatus: 'infra_error',
      prUrl: 'https://github.test/pr/42',
    });
    expect(coordinator.getRun('PUBLISH-RACE')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      prUrl: 'https://github.test/pr/42',
      lastErrorCode: 'publication_reconcile',
    });

    const duplicateExecutor = vi.fn(async () => result());
    expect((await coordinator.execute(task('PUBLISH-RACE'), '/repo', duplicateExecutor)).finalStatus)
      .toBe('superseded');
    expect(duplicateExecutor).not.toHaveBeenCalled();

    // A publication reconciliation is coordination debt, not evidence that the
    // repository itself is failing. It must not open the failure circuit.
    expect((await coordinator.execute(task('AFTER-PUBLISH-RACE'), '/repo', async () => result(), {
      admission: { maxConcurrent: 2, maxFailuresPerHour: 1 },
    })).success).toBe(true);
    expect(ledger.getMetrics().openCircuits).toBe(0);

    coordinator.close();
    ledger.close();
  });

  it('finalizes only after its durable outbox effect is acknowledged', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('SYNC'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `SYNC:${claim.attemptNo}`, payload: { marker: 'SYNC:1' },
      }),
    });
    expect(coordinator.getRun('SYNC')?.state).toBe('SYNC_PENDING');

    const delivered: string[] = [];
    await expect(coordinator.drainOutbox(async (effect) => {
      delivered.push(effect.dedupeKey);
    })).resolves.toMatchObject({ applied: 1, retried: 0, dead: 0 });

    expect(delivered).toEqual(['SYNC:1']);
    expect(coordinator.getRun('SYNC')?.state).toBe('DONE');
    coordinator.close();
  });

  it('renews an outbox lease while a slow delivery is still in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'outbox-renewer',
    });
    await coordinator.execute(task('OUTBOX-RENEW'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `OUTBOX-RENEW:${claim.attemptNo}`, payload: {},
      }),
    });
    const renewSpy = vi.spyOn(ledger, 'renewEffectLease');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const draining = coordinator.drainOutbox(async () => held, { maxEffects: 1, leaseMs: 3_000 });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(renewSpy).toHaveBeenCalledOnce();
    release();
    await expect(draining).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(coordinator.getRun('OUTBOX-RENEW')?.state).toBe('DONE');
    coordinator.close();
    ledger.close();
  });

  it('does not acknowledge a delivery after losing its outbox lease', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const path = dbPath();
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'outbox-loser',
    });
    await coordinator.execute(task('OUTBOX-LOSE'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `OUTBOX-LOSE:${claim.attemptNo}`, payload: {},
      }),
    });
    vi.spyOn(ledger, 'renewEffectLease').mockReturnValue(null);
    const ackSpy = vi.spyOn(ledger, 'ackEffectAndFinalizeRun');
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const draining = coordinator.drainOutbox(async () => held, { maxEffects: 1, leaseMs: 3_000 });
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(1_000);
    release();
    await expect(draining).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    expect(ackSpy).not.toHaveBeenCalled();
    expect(coordinator.getRun('OUTBOX-LOSE')?.state).toBe('SYNC_PENDING');
    coordinator.close();
    ledger.close();
  });

  it('keeps cancellation fenced until tracker synchronization is acknowledged', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const cancelled = await coordinator.execute(task('CANCEL-SYNC'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'cancelled',
    }), {
      cancelEffect: (_pipeline, claim) => ({
        kind: 'tracker.cancel',
        dedupeKey: `CANCEL-SYNC:${claim.attemptNo}`,
        payload: { marker: 'CANCEL-SYNC:1' },
      }),
    });

    expect(cancelled.finalStatus).toBe('cancelled');
    expect(coordinator.getRun('CANCEL-SYNC')?.state).toBe('SYNC_PENDING');
    // A stale Todo observation cannot reopen a cancellation whose remote state
    // has not converged yet.
    expect(coordinator.observeTask(task('CANCEL-SYNC', 'Todo'), '/repo')?.state).toBe('SYNC_PENDING');

    await expect(coordinator.drainOutbox(async () => {
      throw new Error('tracker unavailable');
    }, { maxEffects: 1 })).resolves.toEqual({ applied: 0, retried: 1, dead: 0 });
    expect(coordinator.getRun('CANCEL-SYNC')?.state).toBe('SYNC_PENDING');

    await expect(coordinator.drainOutbox(async () => {}, {
      maxEffects: 1,
      now: () => Date.now() + 60_000,
    })).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(coordinator.getRun('CANCEL-SYNC')?.state).toBe('CANCELLED');
    coordinator.close();
  });

  it('returns a shutdown cancellation to RETRY_AT without emitting a tracker cancellation', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const cancelEffect = vi.fn();
    const cancelled = await coordinator.execute(task('SHUTDOWN-RETRY'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'cancelled',
    }), {
      retryCancellation: () => true,
      cancelEffect,
    });

    expect(cancelled.finalStatus).toBe('cancelled');
    expect(cancelEffect).not.toHaveBeenCalled();
    expect(coordinator.getRun('SHUTDOWN-RETRY')).toMatchObject({
      state: 'RETRY_AT',
      lastErrorCode: 'shutdown_cancelled',
    });
    expect(coordinator.getRun('SHUTDOWN-RETRY')?.retryAt).toBeGreaterThan(Date.now());
    coordinator.close();
  });

  it('defers an unclaimed run until the repository circuit reopens', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const admission = { maxAttemptsPerHour: 1, circuitCooldownMs: 60_000 };

    await coordinator.execute(task('CIRCUIT-1'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'infra_error',
    }), { admission });

    const before = Date.now();
    const blocked = await coordinator.execute(task('CIRCUIT-2'), '/repo', async () => result(), { admission });
    const run = coordinator.getRun('CIRCUIT-2');

    expect(blocked.taskContext?.taskTitle).toContain('durable claim unavailable');
    expect(run).toMatchObject({ state: 'RETRY_AT', lastErrorCode: 'claim_deferred' });
    expect(run!.retryAt).toBeGreaterThanOrEqual(before + 59_000);
    coordinator.close();
  });

  it('keeps a failed delivery pending and never reports the run done', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('RETRY'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `RETRY:${claim.attemptNo}`, payload: {},
      }),
    });

    const drained = await coordinator.drainOutbox(async () => {
      throw new Error('tracker unavailable');
    }, { maxEffects: 1 });
    expect(drained).toEqual({ applied: 0, retried: 1, dead: 0 });
    expect(coordinator.getRun('RETRY')?.state).toBe('SYNC_PENDING');
    coordinator.close();
  });

  it('parks a run for human intervention when an outbox effect exhausts delivery', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('DEAD'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `DEAD:${claim.attemptNo}`, payload: {},
      }),
    });

    await expect(coordinator.drainOutbox(async () => {
      throw new Error('permanent permission failure');
    }, { maxEffects: 1, maxAttempts: 1 })).resolves.toEqual({ applied: 0, retried: 0, dead: 1 });
    expect(coordinator.getRun('DEAD')).toMatchObject({ state: 'NEEDS_HUMAN', lastErrorCode: 'needs_human' });

    expect(coordinator.resumeNeedsHuman('DEAD')).toBe('SYNC_PENDING');
    await expect(coordinator.drainOutbox(async () => {})).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(coordinator.getRun('DEAD')?.state).toBe('DONE');
    coordinator.close();
  });

  it('backs a superseded preflight off instead of spinning in WAITING_EXTERNAL', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const effectFactory = vi.fn();
    const deferred = await coordinator.execute(task('SUPERSEDED'), '/repo', async () => ({
      ...result(true), finalStatus: 'superseded',
    }), { successEffect: effectFactory });
    expect(deferred.finalStatus).toBe('superseded');
    expect(coordinator.getRun('SUPERSEDED')).toMatchObject({ state: 'RETRY_AT' });
    expect(coordinator.getRun('SUPERSEDED')?.retryAt).toBeGreaterThan(Date.now());
    expect(effectFactory).not.toHaveBeenCalled();
    await expect(coordinator.drainOutbox(async () => {})).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    coordinator.close();
  });

  it('persists deterministic tester output instead of an earlier reviewer approval', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    await coordinator.execute(task('VERIFY-FAIL'), '/repo', async () => ({
      ...result(false),
      finalStatus: 'failed',
      lastReviewFeedback: 'Work complete and approved.',
      reviewResult: { decision: 'approve', feedback: 'Work complete and approved.' },
      testerResult: {
        success: false,
        testsPassed: 0,
        testsFailed: 1,
        output: '[cargo test] rustdoc: No such file or directory',
        deterministic: true,
      },
    }));

    expect(coordinator.getRun('VERIFY-FAIL')).toMatchObject({
      state: 'RETRY_AT',
      lastErrorMessage: '[cargo test] rustdoc: No such file or directory',
    });
    coordinator.close();
  });

  it('treats successful decomposition as DECOMPOSED without tracker completion effects', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'daemon' });
    const effectFactory = vi.fn();
    const decomposed = await coordinator.execute(task('PARENT'), '/repo', async () => ({
      ...result(), finalStatus: 'decomposed', success: true,
    }), { successEffect: effectFactory });

    expect(decomposed.finalStatus).toBe('decomposed');
    expect(coordinator.getRun('PARENT')?.state).toBe('DECOMPOSED');
    expect(effectFactory).not.toHaveBeenCalled();
    await expect(coordinator.drainOutbox(async () => {})).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    coordinator.close();
  });

  it('reopens every terminal state only from an explicit Todo observation', async () => {
    for (const terminal of ['DONE', 'DECOMPOSED', 'CANCELLED'] as const) {
      const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: `daemon-${terminal}` });
      const issue = `REOPEN-${terminal}`;
      const completed = await coordinator.execute(task(issue), '/repo', async () => ({
        ...result(terminal === 'DONE'),
        success: terminal !== 'CANCELLED',
        finalStatus: terminal === 'DECOMPOSED' ? 'decomposed' : terminal === 'CANCELLED' ? 'cancelled' : 'approved',
      }));
      expect(completed.finalStatus).toBe(terminal === 'DONE' ? 'approved' : terminal === 'DECOMPOSED' ? 'decomposed' : 'cancelled');
      expect(coordinator.getRun(issue)?.state).toBe(terminal);

      expect(coordinator.observeTask(task(issue, 'In Progress'), '/repo')?.state).toBe(terminal);
      expect(coordinator.observeTask(task(issue, 'Todo'), '/repo')?.state).toBe('READY');
      coordinator.close();
    }
  });

  it('shadow mode observes but does not block execution when another owner holds the claim', async () => {
    const path = dbPath();
    const primary = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'primary' });
    const shadow = new DurableRunCoordinator({ mode: 'shadow', dbPath: path, instanceId: 'shadow' });
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const primaryRun = primary.execute(task('SHADOW'), '/repo', async () => {
      await held;
      return result(false);
    });
    const shadowExecutor = vi.fn(async () => result(false));

    expect((await shadow.execute(task('SHADOW'), '/repo', shadowExecutor)).finalStatus).toBe('infra_error');
    expect(shadowExecutor).toHaveBeenCalledOnce();
    release();
    await primaryRun;
    primary.close();
    shadow.close();
  });

  it('shadow mode never creates a claim or outbox effect when it is the only observer', async () => {
    const shadow = new DurableRunCoordinator({ mode: 'shadow', dbPath: dbPath(), instanceId: 'shadow' });
    const effectFactory = vi.fn(() => ({
      kind: 'tracker.complete', dedupeKey: 'SHADOW-ONLY:1', payload: {},
    }));

    expect((await shadow.execute(task('SHADOW-ONLY'), '/repo', async () => result(), {
      successEffect: effectFactory,
    })).success).toBe(true);
    expect(shadow.getRun('SHADOW-ONLY')).toMatchObject({ state: 'READY', attemptNo: 0 });
    expect(effectFactory).not.toHaveBeenCalled();
    await expect(shadow.drainOutbox(async () => {})).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    shadow.close();
  });

  it('off mode exposes inert durability hooks without creating local state', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'off', instanceId: 'off' });
    const pipeline = await coordinator.execute(task('OFF'), '/repo', async (hooks, signal) => {
      expect(signal.aborted).toBe(false);
      expect(await hooks.onWorktree({
        issueId: 'OFF', branchName: 'swarm/OFF', worktreePath: '/repo/OFF', originalPath: '/repo',
      })).toBe(true);
      expect(await hooks.onStage('worker')).toBe(true);
      expect(await hooks.beforePublish()).toBe(true);
      expect(await hooks.onPublication('https://github.test/pr/off')).toBe(true);
      return result();
    });

    expect(pipeline.success).toBe(true);
    expect(coordinator.getRun('OFF')).toBeNull();
    expect(coordinator.markNeedsHuman('OFF', 'unused')).toBe(false);
    expect(coordinator.reconcile()).toEqual([]);
    coordinator.close();
    coordinator.close();
  });

  it('shadow mode cannot deliver another coordinator\'s shared outbox effect', async () => {
    const path = dbPath();
    const primary = new DurableRunCoordinator({ mode: 'primary', dbPath: path, instanceId: 'primary' });
    const shadow = new DurableRunCoordinator({ mode: 'shadow', dbPath: path, instanceId: 'shadow' });
    await primary.execute(task('SHADOW-OUTBOX'), '/repo', async () => result(), {
      successEffect: (_pipeline, claim) => ({
        kind: 'tracker.complete', dedupeKey: `SHADOW-OUTBOX:${claim.attemptNo}`, payload: {},
      }),
    });
    const deliver = vi.fn(async () => {});

    await expect(shadow.drainOutbox(deliver)).resolves.toEqual({ applied: 0, retried: 0, dead: 0 });
    expect(deliver).not.toHaveBeenCalled();
    await expect(primary.drainOutbox(deliver)).resolves.toEqual({ applied: 1, retried: 0, dead: 0 });
    expect(deliver).toHaveBeenCalledOnce();
    primary.close();
    shadow.close();
  });

  it('keeps the repository fenced until a lease-lost executor actually exits', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const path = dbPath();
    const old = new DurableRunCoordinator({
      mode: 'primary', dbPath: path, instanceId: 'old', leaseMs: 3_000,
    });
    let oldHooks!: Parameters<Parameters<DurableRunCoordinator['execute']>[2]>[0];
    let oldLeaseSignal!: AbortSignal;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const oldRun = old.execute(task('FENCE-STAGE'), '/repo', async (hooks, leaseSignal) => {
      oldHooks = hooks;
      oldLeaseSignal = leaseSignal;
      expect(await hooks.onStage('reviewer')).toBe(true);
      await held;
      return result();
    });
    await Promise.resolve();

    vi.setSystemTime(5_000); // do not run the old renewal interval
    const replacementLedger = new RunLedger(path);
    replacementLedger.registerRun({
      issueId: 'FENCE-OTHER', source: 'linear', projectPath: '/repo',
    }, 5_000);
    expect(replacementLedger.reconcileExpiredLeases(5_000)).toHaveLength(1);
    expect(replacementLedger.markReady('FENCE-STAGE', 5_001)).toBe(false);
    expect(replacementLedger.claimRun('FENCE-OTHER', {
      ownerInstanceId: 'new', leaseMs: 3_000, now: 5_001,
    })).toBeNull();

    expect(await oldHooks.onStage('reviewer')).toBe(false);
    expect(oldLeaseSignal.aborted).toBe(true);
    release();
    expect((await oldRun).finalStatus).toBe('infra_error');
    expect(replacementLedger.getRun('FENCE-STAGE')?.ownerInstanceId).toBeUndefined();
    expect(replacementLedger.markReady('FENCE-STAGE', 5_002)).toBe(true);
    expect(replacementLedger.claimRun('FENCE-OTHER', {
      ownerInstanceId: 'new', leaseMs: 3_000, now: 5_003,
    })).not.toBeNull();
    replacementLedger.close();
    old.close();
  });

  it('releases an expired owner only after proving its process is dead', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    ledger.registerRun({ issueId: 'DEAD-OWNER', source: 'linear', projectPath: '/repo' }, 1_000);
    const stale = ledger.claimRun('DEAD-OWNER', {
      ownerInstanceId: '424242-dead-owner', leaseMs: 3_000, now: 1_000,
    })!;
    expect(ledger.transition(stale, 'EXECUTING', {}, 1_100)).toBe(true);
    const replacement = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'replacement', processIsAlive: () => false,
    });

    expect(replacement.reconcile(4_001)).toHaveLength(1);
    expect(ledger.getRun('DEAD-OWNER')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: undefined,
      leaseToken: undefined,
    });
    expect(ledger.markReady('DEAD-OWNER', 4_002)).toBe(true);
    replacement.close();
    ledger.close();
  });

  it('uses the default PID probe to retain live owners and release dead owners', () => {
    const livePath = dbPath();
    const liveLedger = new RunLedger(livePath);
    liveLedger.registerRun({ issueId: 'LIVE-PID', source: 'linear', projectPath: '/live-repo' }, 1_000);
    const liveClaim = liveLedger.claimRun('LIVE-PID', {
      ownerInstanceId: `${process.pid}-live-owner`, leaseMs: 3_000, now: 1_000,
    })!;
    expect(liveLedger.transition(liveClaim, 'EXECUTING', {}, 1_100)).toBe(true);
    const liveReplacement = new DurableRunCoordinator({
      mode: 'primary', ledger: liveLedger, instanceId: 'live-replacement',
    });

    expect(liveReplacement.reconcile(4_001)).toHaveLength(1);
    expect(liveLedger.getRun('LIVE-PID')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: `${process.pid}-live-owner`,
    });
    liveReplacement.close();
    liveLedger.close();

    const deadPath = dbPath();
    const deadLedger = new RunLedger(deadPath);
    deadLedger.registerRun({ issueId: 'DEAD-PID', source: 'linear', projectPath: '/dead-repo' }, 1_000);
    const deadClaim = deadLedger.claimRun('DEAD-PID', {
      ownerInstanceId: '999999-dead-owner', leaseMs: 3_000, now: 1_000,
    })!;
    expect(deadLedger.transition(deadClaim, 'EXECUTING', {}, 1_100)).toBe(true);
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('missing process'), { code: 'ESRCH' });
    });
    const deadReplacement = new DurableRunCoordinator({
      mode: 'primary', ledger: deadLedger, instanceId: 'dead-replacement',
    });

    expect(deadReplacement.reconcile(4_001)).toHaveLength(1);
    expect(deadLedger.getRun('DEAD-PID')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: undefined,
      leaseToken: undefined,
    });
    kill.mockRestore();
    deadReplacement.close();
    deadLedger.close();
  });

  it('rejects a negative reconcileAbandonMs instead of silently collapsing the safety margin', () => {
    expect(() => new DurableRunCoordinator({
      mode: 'primary', dbPath: dbPath(), reconcileAbandonMs: -1,
    })).toThrow(/reconcileAbandonMs/);
  });

  // AGT-4052: a container assigns the daemon the same pid every restart, so
  // a NEEDS_RECONCILE row orphaned by a restart has processIsAlive report
  // true forever (the new daemon's own pid probe hits itself). Age must be
  // able to free it even while the pid probe insists the owner is alive.
  it('abandons a NEEDS_RECONCILE owner by age once a pid probe alone can never disprove it', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    ledger.registerRun({ issueId: 'PID-REUSE', source: 'linear', projectPath: '/repo' }, 1_000);
    const claim = ledger.claimRun('PID-REUSE', {
      ownerInstanceId: '7-orphaned-generation', leaseMs: 3_000, now: 1_000,
    })!;
    expect(ledger.transition(claim, 'EXECUTING', {}, 1_100)).toBe(true);

    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: '7-current-generation',
      // Simulates pid reuse: a live daemon now occupies the orphaned row's
      // pid, so a bare pid probe can never prove the original owner is dead.
      processIsAlive: () => true,
      reconcileAbandonMs: 5_000,
    });

    // First reconcile() call: reconcileExpiredLeases() moves EXECUTING ->
    // NEEDS_RECONCILE at t=4_001 (lease expired at 4_000), setting
    // updatedAt=4_001. The NEEDS_RECONCILE loop runs in the same call but
    // the row is brand new (age 0), so it must stay fenced despite the
    // stubbed-alive pid — proving the age check doesn't free prematurely.
    expect(coordinator.reconcile(4_001)).toHaveLength(1);
    expect(ledger.getRun('PID-REUSE')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: '7-orphaned-generation',
      leaseToken: claim.leaseToken,
    });

    // Just under the abandon threshold: still fenced.
    coordinator.reconcile(4_001 + 4_999);
    expect(ledger.getRun('PID-REUSE')).toMatchObject({
      ownerInstanceId: '7-orphaned-generation',
    });

    // At/past the abandon threshold: freed by age alone, even though
    // processIsAlive still (falsely) reports the owner as alive.
    coordinator.reconcile(4_001 + 5_000);
    expect(ledger.getRun('PID-REUSE')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: undefined,
      leaseToken: undefined,
    });
    expect(ledger.markReady('PID-REUSE', 4_001 + 5_001)).toBe(true);

    coordinator.close();
    ledger.close();
  });

  // AGT-4054 follow-up: AGT-4052 only cleared a NEEDS_RECONCILE row's stale
  // owner/lease — it never advanced the row's STATE, so a row a prior sweep
  // (or claimRun()'s own reconcileExpiredRows()) already orphaned is stuck
  // forever: not claimable (CLAIMABLE_STATES excludes NEEDS_RECONCILE) yet
  // still counted against claimRun()'s per-project admission cap. Confirmed
  // live on vela: AX-1018/885/1044 sat 2+ hours post-restart with owner/lease
  // already null, silently starving 5 other CGF-Portal claims every
  // heartbeat with "Durable claim unavailable ... concurrent owner".
  it('auto-reopens an orphaned NEEDS_RECONCILE row once nothing was published', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    ledger.registerRun({ issueId: 'ORPHAN-NO-PR', source: 'linear', projectPath: '/repo' }, 1_000);
    const claim = ledger.claimRun('ORPHAN-NO-PR', {
      ownerInstanceId: 'dead-generation', leaseMs: 3_000, now: 1_000,
    })!;
    expect(ledger.transition(claim, 'EXECUTING', {}, 1_100)).toBe(true);

    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'live-generation',
      processIsAlive: () => true, // pid reuse — probe alone can never disprove
      reconcileAbandonMs: 5_000,
    });

    // Same 3-call cadence as the PID-REUSE test above: lease expires -> brand
    // new NEEDS_RECONCILE (age 0, stays fenced) -> still under threshold
    // (stays fenced) -> age threshold crossed (owner/lease cleared here).
    coordinator.reconcile(4_001);
    coordinator.reconcile(4_001 + 4_999);
    coordinator.reconcile(4_001 + 5_000);
    expect(ledger.getRun('ORPHAN-NO-PR')).toMatchObject({
      state: 'NEEDS_RECONCILE', ownerInstanceId: undefined, leaseToken: undefined, prUrl: undefined,
    });

    // The very next reconcile() — no manual markReady() call — must reopen it.
    const reopened = coordinator.reconcile(4_001 + 5_001);
    expect(ledger.getRun('ORPHAN-NO-PR')).toMatchObject({ state: 'READY' });
    expect(reopened.map((r) => r.issueId)).toContain('ORPHAN-NO-PR');

    coordinator.close();
    ledger.close();
  });

  it('leaves an orphaned NEEDS_RECONCILE row alone when a PR was actually published', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    ledger.registerRun({ issueId: 'ORPHAN-WITH-PR', source: 'linear', projectPath: '/repo' }, 1_000);
    const claim = ledger.claimRun('ORPHAN-WITH-PR', {
      ownerInstanceId: 'dead-generation', leaseMs: 3_000, now: 1_000,
    })!;
    expect(ledger.transition(claim, 'EXECUTING', {}, 1_100)).toBe(true);
    expect(ledger.transition(claim, 'PUBLISHING', { prUrl: 'https://github.com/x/y/pull/1' }, 1_200)).toBe(true);

    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'live-generation',
      processIsAlive: () => true,
      reconcileAbandonMs: 5_000,
    });

    coordinator.reconcile(4_001);
    coordinator.reconcile(4_001 + 4_999);
    coordinator.reconcile(4_001 + 5_000);
    expect(ledger.getRun('ORPHAN-WITH-PR')).toMatchObject({
      state: 'NEEDS_RECONCILE', ownerInstanceId: undefined, leaseToken: undefined,
      prUrl: 'https://github.com/x/y/pull/1',
    });

    // A discovered PR means artifact state a human/reconciler still needs to
    // look at (recoverPublishedRun/markNeedsHuman own that path) — must NOT
    // be silently reopened as if nothing happened.
    coordinator.reconcile(4_001 + 5_001);
    expect(ledger.getRun('ORPHAN-WITH-PR')).toMatchObject({ state: 'NEEDS_RECONCILE' });

    coordinator.close();
    ledger.close();
  });

  // Caught by fresh PR review, not self-caught: prUrl == null only proves the
  // LEDGER never recorded a PR — it does not prove nothing was pushed. A row
  // can reach here having run `gh pr create` successfully but died before the
  // ledger write that would have set prUrl. reconcileDurableArtifacts() (in
  // autonomousRunner.ts) owns exactly this case: it checks GitHub for a real
  // PR by branchName before ever falling back to worktree-evidence
  // inspection. reconcile() has no filesystem/GitHub access, so it must defer
  // to that path — not race ahead of it — for any row with a branchName.
  // Confirmed live on vela: AX-1018/AX-885/AX-1044 all carry a branchName.
  it('leaves a branchName-carrying orphaned NEEDS_RECONCILE row for reconcileDurableArtifacts, not a direct reopen', () => {
    const path = dbPath();
    const ledger = new RunLedger(path);
    ledger.registerRun({ issueId: 'ORPHAN-WITH-BRANCH', source: 'linear', projectPath: '/repo' }, 1_000);
    const claim = ledger.claimRun('ORPHAN-WITH-BRANCH', {
      ownerInstanceId: 'dead-generation', leaseMs: 3_000, now: 1_000,
    })!;
    expect(ledger.transition(claim, 'EXECUTING', { branchName: 'swarm/ORPHAN-WITH-BRANCH' }, 1_100)).toBe(true);

    const coordinator = new DurableRunCoordinator({
      mode: 'primary', ledger, instanceId: 'live-generation',
      processIsAlive: () => true,
      reconcileAbandonMs: 5_000,
    });

    coordinator.reconcile(4_001);
    coordinator.reconcile(4_001 + 4_999);
    coordinator.reconcile(4_001 + 5_000);
    expect(ledger.getRun('ORPHAN-WITH-BRANCH')).toMatchObject({
      state: 'NEEDS_RECONCILE', ownerInstanceId: undefined, leaseToken: undefined,
      branchName: 'swarm/ORPHAN-WITH-BRANCH', prUrl: undefined,
    });

    // Must stay parked here even though prUrl is null — only
    // reconcileDurableArtifacts()'s GitHub lookup can prove nothing was
    // published for this branch.
    coordinator.reconcile(4_001 + 5_001);
    expect(ledger.getRun('ORPHAN-WITH-BRANCH')).toMatchObject({ state: 'NEEDS_RECONCILE' });

    coordinator.close();
    ledger.close();
  });
});

describe('runRecordToTask', () => {
  // AGT-4094: reconciliation has to finish a published run whose tracker card
  // already went Done, and a Done card is never in the fetch — so the run
  // record itself has to be able to stand in for the task it was registered
  // from. This is the inverse of observeTask's mapping; round-tripping it is
  // what keeps the two from drifting apart.
  function record(overrides: Partial<Parameters<typeof runRecordToTask>[0]> = {}) {
    return {
      issueId: 'f8c57098', source: 'linear', identifier: 'AX-876',
      title: 'account master', projectPath: '/work/cgf-portal',
      state: 'NEEDS_RECONCILE' as const, stateVersion: 130, attemptNo: 4, leaseEpoch: 4,
      discoveredAt: 1_787_897_771_595, updatedAt: 1_788_009_300_002,
      metadata: { projectId: 'cgf', projectName: 'CGF-Portal', fileScope: ['a.ts'] },
      ...overrides,
    };
  }

  it('carries every field the completion effect reads back off the durable row', () => {
    expect(runRecordToTask(record())).toMatchObject({
      id: 'f8c57098',
      issueId: 'f8c57098',
      issueIdentifier: 'AX-876',
      source: 'linear',
      title: 'account master',
      projectPath: '/work/cgf-portal',
      linearProject: { id: 'cgf', name: 'CGF-Portal' },
      fileScope: ['a.ts'],
      createdAt: 1_787_897_771_595,
    });
  });

  it('round-trips what observeTask wrote, so the two mappings cannot drift apart', () => {
    const ledger = new RunLedger(dbPath());
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger });
    const original: TaskItem = {
      id: 'issue-1', issueId: 'issue-1', issueIdentifier: 'AX-1', source: 'linear',
      title: 'round trip', priority: 2, createdAt: 1_000,
      linearProject: { id: 'proj', name: 'Proj' }, fileScope: ['x.ts'],
    };
    const stored = coordinator.observeTask(original, '/repo');
    expect(stored).not.toBeNull();

    const rebuilt = runRecordToTask(stored!);
    expect(rebuilt.issueId).toBe(original.issueId);
    expect(rebuilt.issueIdentifier).toBe(original.issueIdentifier);
    expect(rebuilt.title).toBe(original.title);
    expect(rebuilt.source).toBe(original.source);
    expect(rebuilt.linearProject).toEqual(original.linearProject);
    expect(rebuilt.fileScope).toEqual(original.fileScope);
    coordinator.close();
    ledger.close();
  });

  it('names an unrecognized source instead of asserting it into the union', () => {
    // The column is a free-form string, so a record written by a build that
    // knew a source this one does not must not be cast into a member it isn't.
    expect(runRecordToTask(record({ source: 'jira' })).source).toBe('discovered');
  });

  it('falls back through title -> identifier -> issue id, so a title is never empty', () => {
    expect(runRecordToTask(record({ title: undefined })).title).toBe('AX-876');
    expect(runRecordToTask(record({ title: undefined, identifier: undefined })).title).toBe('f8c57098');
  });

  it('omits linearProject when the row never recorded one', () => {
    expect(runRecordToTask(record({ metadata: {} })).linearProject).toBeUndefined();
    expect(runRecordToTask(record({ metadata: undefined })).linearProject).toBeUndefined();
  });
});

describe('activeWorkerIdentifiers', () => {
  // AGT-4097: an open PR reserves its files only while a worker holds the run.
  // The first attempt keyed on WHY a run stopped (lastErrorCode) and did not
  // survive production: every blocking PR's run had parked on an operator
  // question, but later dispatches overwrote that code, so only 2 of 10 still
  // said so. A lease is not overwritten by the next attempt.
  it('reports runs a worker holds and nothing else', () => {
    const ledger = new RunLedger(dbPath());
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger });
    ledger.importRun({
      issueId: 'ready', source: 'linear', identifier: 'AX-1', title: 'claimable',
      projectPath: '/repo', state: 'READY',
    });
    ledger.importRun({
      issueId: 'parked', source: 'linear', identifier: 'AX-2', title: 'operator park',
      projectPath: '/repo', state: 'RETRY_AT', errorCode: 'waiting_on_operator',
    });
    ledger.importRun({
      issueId: 'superseded', source: 'linear', identifier: 'AX-3', title: 'gate park',
      projectPath: '/repo', state: 'RETRY_AT', errorCode: 'superseded',
    });
    ledger.importRun({
      issueId: 'escalated', source: 'linear', identifier: 'AX-4', title: 'needs human',
      projectPath: '/repo', state: 'NEEDS_HUMAN',
    });
    expect(coordinator.activeWorkerIdentifiers('/repo')).toEqual([]);

    // Claiming one is what makes it reserve: the lease, not the error code.
    expect(ledger.claimRun('ready', { ownerInstanceId: 'owner', leaseMs: 60_000 })).not.toBeNull();
    expect(coordinator.activeWorkerIdentifiers('/repo')).toEqual(['AX-1']);

    // Another project's held run must not leak into this project's answer.
    ledger.importRun({
      issueId: 'other', source: 'linear', identifier: 'KT-1', title: 'elsewhere',
      projectPath: '/other', state: 'READY',
    });
    expect(ledger.claimRun('other', { ownerInstanceId: 'owner', leaseMs: 60_000 })).not.toBeNull();
    expect(coordinator.activeWorkerIdentifiers('/repo')).toEqual(['AX-1']);
    coordinator.close();
    ledger.close();
  });

  it('drops a run whose lease has lapsed, since no worker is left holding it', () => {
    const ledger = new RunLedger(dbPath());
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger });
    ledger.importRun({
      issueId: 'held', source: 'linear', identifier: 'AX-5', title: 'held',
      projectPath: '/repo', state: 'READY',
    });
    expect(ledger.claimRun('held', { ownerInstanceId: 'owner', leaseMs: 1_000, now: 1_000 })).not.toBeNull();

    // Inside the lease the PR still reserves; past it the row is only waiting
    // for a reconciliation sweep, and its files are nobody's.
    expect(coordinator.activeWorkerIdentifiers('/repo', 1_500)).toEqual(['AX-5']);
    expect(coordinator.activeWorkerIdentifiers('/repo', 2_001)).toEqual([]);
    coordinator.close();
    ledger.close();
  });

  // A coordinator that never claims cannot say the set is empty — it can only
  // say it does not know. Returning [] here would assert "nothing is held" and
  // the overlap gate, which fails closed on undefined, would stop reserving.
  it('answers undefined rather than empty when it does not claim', () => {
    const off = new DurableRunCoordinator({ mode: 'off' });
    expect(off.activeWorkerIdentifiers('/repo')).toBeUndefined();
    off.close();

    const shadowLedger = new RunLedger(dbPath());
    const shadow = new DurableRunCoordinator({ mode: 'shadow', ledger: shadowLedger });
    shadowLedger.importRun({
      issueId: 'observed', source: 'linear', identifier: 'AX-9', title: 'observed only',
      projectPath: '/repo', state: 'READY',
    });
    expect(shadow.activeWorkerIdentifiers('/repo')).toBeUndefined();
    shadow.close();
    shadowLedger.close();
  });
});

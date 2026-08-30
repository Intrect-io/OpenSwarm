// Purpose: explicit dispatch (INT-3388) — enqueueIssues queues exactly the
// user-chosen tasks (scheduler dedupe intact) and starts execution, and
// autonomousHeartbeat:false starts the runner without any heartbeat cron.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutonomousRunner } from './autonomousRunner.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/x/a'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  maxConsecutiveTasks: 1,
  cooldownSeconds: 0,
  dryRun: true,
  pairMode: true,
  maxConcurrentTasks: 4,
  ...over,
});

const task = (id: string): TaskItem => ({
  id,
  source: 'linear',
  title: `Task ${id}`,
  priority: 2,
  issueId: id,
  issueIdentifier: `INT-${id}`,
  createdAt: Date.now(),
});

type Internal = { runAvailableTasks(): Promise<void>; cronJob: unknown };

describe('AutonomousRunner.enqueueIssues (INT-3388)', () => {
  it('queues each task, kicks execution once, and dedupes re-queues via the scheduler', async () => {
    const runner = new AutonomousRunner(cfg());
    const runSpy = vi.fn(async () => {});
    (runner as unknown as Internal).runAvailableTasks = runSpy;

    const first = await runner.enqueueIssues([task('1'), task('2')], '/x/a');
    expect(first.queued).toEqual(['1', '2']);
    expect(first.rejected).toEqual([]);
    expect(runSpy).toHaveBeenCalledTimes(1);

    // Same issues again: scheduler's already-queued dedupe rejects them and
    // no extra execution kick happens.
    const second = await runner.enqueueIssues([task('1'), task('3')], '/x/a');
    expect(second.queued).toEqual(['3']);
    expect(second.rejected).toEqual([{ id: '1', reason: 'duplicate' }]);
    expect(runSpy).toHaveBeenCalledTimes(2);

    const third = await runner.enqueueIssues([task('1')], '/x/a');
    expect(third.queued).toEqual([]);
    expect(third.rejected).toEqual([{ id: '1', reason: 'duplicate' }]);
    expect(runSpy).toHaveBeenCalledTimes(2); // nothing new queued → no kick
  });

  it('throws loudly on a config whose scheduler never executes (solo mode) instead of stranding the queue (review finding)', async () => {
    const noPair = new AutonomousRunner(cfg({ pairMode: false }));
    await expect(noPair.enqueueIssues([task('1')], '/x/a')).rejects.toThrow(/pairMode/);

    const noConcurrency = new AutonomousRunner(cfg({ maxConcurrentTasks: undefined }));
    await expect(noConcurrency.enqueueIssues([task('1')], '/x/a')).rejects.toThrow(/maxConcurrentTasks/);
  });

  it('refuses dispatch during an active provider rate-limit hold (review finding)', async () => {
    const runner = new AutonomousRunner(cfg());
    (runner as unknown as { rateLimitUntil: number }).rateLimitUntil = Date.now() + 60_000;
    await expect(runner.enqueueIssues([task('1')], '/x/a')).rejects.toThrow(/rate limit active/);
  });

  it('enableHeartbeat turns the cron on for an explicit-mode runner exactly once (review finding)', () => {
    const runner = new AutonomousRunner(cfg({ autonomousHeartbeat: false }));
    type CronInternal = { cronJob: { stop(): void } | null };
    expect((runner as unknown as CronInternal).cronJob ?? null).toBeNull();
    expect(runner.enableHeartbeat()).toBe(true);
    expect((runner as unknown as CronInternal).cronJob).not.toBeNull();
    // Second call is a no-op — a cron already exists.
    expect(runner.enableHeartbeat()).toBe(false);
    (runner as unknown as CronInternal).cronJob?.stop();
  });

  it('suppresses the automatic post-completion heartbeat re-fire in explicit-dispatch mode (review finding)', async () => {
    vi.useFakeTimers();
    try {
      type HeartbeatInternal = { scheduleNextHeartbeat(): void; heartbeat(): Promise<void>; _nextHeartbeatTimer: unknown };

      const explicit = new AutonomousRunner(cfg({ autonomousHeartbeat: false }));
      const explicitBeat = vi.fn(async () => {});
      (explicit as unknown as HeartbeatInternal).heartbeat = explicitBeat;
      (explicit as unknown as HeartbeatInternal).scheduleNextHeartbeat();
      expect((explicit as unknown as HeartbeatInternal)._nextHeartbeatTimer).toBeNull();
      await vi.runAllTimersAsync();
      expect(explicitBeat).not.toHaveBeenCalled();

      // Default (heartbeat mode) keeps the re-fire behavior.
      const auto = new AutonomousRunner(cfg());
      const autoBeat = vi.fn(async () => {});
      (auto as unknown as HeartbeatInternal).heartbeat = autoBeat;
      (auto as unknown as HeartbeatInternal).scheduleNextHeartbeat();
      await vi.runAllTimersAsync();
      expect(autoBeat).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a transiently deferred explicit dispatch even when heartbeat is disabled', async () => {
    vi.useFakeTimers();
    try {
      const runner = new AutonomousRunner(cfg({
        autonomousHeartbeat: false,
        autoExecute: true,
        maxConcurrentTasks: 2,
        allowSameProjectConcurrent: true,
        worktreeMode: true,
      }));
      type DispatchInternal = Internal & {
        executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult>;
        scheduler: { getQueuedTasks(): Array<{ task: TaskItem; availableAt?: number }> };
      };
      const internal = runner as unknown as DispatchInternal;
      let releaseFirst!: (result: PipelineResult) => void;
      const firstHeld = new Promise<PipelineResult>((resolve) => { releaseFirst = resolve; });
      let secondAttempts = 0;
      internal.executeDurably = vi.fn(async (queuedTask) => {
        if (queuedTask.id === '1') return firstHeld;
        secondAttempts++;
        if (secondAttempts === 1) {
          return {
            success: false,
            sessionId: 'deferred-attempt',
            stages: [],
            finalStatus: 'deferred',
            retryAt: Date.now() + 1_000,
            totalDuration: 0,
            iterations: 0,
          };
        }
        return {
          success: true,
          sessionId: 'approved-attempt',
          stages: [],
          finalStatus: 'approved',
          totalDuration: 1,
          iterations: 1,
        };
      });

      await runner.enqueueIssues([task('1'), task('2')], '/x/a');
      await vi.advanceTimersByTimeAsync(0);
      expect(secondAttempts).toBe(1);
      expect(internal.scheduler.getQueuedTasks()).toEqual([
        expect.objectContaining({ task: expect.objectContaining({ id: '2' }), availableAt: expect.any(Number) }),
      ]);

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(secondAttempts).toBe(2);
      expect(internal.scheduler.getQueuedTasks()).toEqual([]);

      releaseFirst({
        success: true,
        sessionId: 'first-approved',
        stages: [],
        finalStatus: 'approved',
        totalDuration: 1,
        iterations: 1,
      });
      await vi.advanceTimersByTimeAsync(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('AutonomousRunner shutdown claim rollback (INT-3388, review finding)', () => {
  it('rolls back Linear claims for explicit dispatches discarded by shutdown, using the atomic discard snapshot', async () => {
    const { updateIssueState, isLinearInitialized } = vi.hoisted(() => ({
      updateIssueState: vi.fn(async () => true),
      isLinearInitialized: vi.fn(() => true),
    }));
    vi.doMock('../linear/linear.js', () => ({ updateIssueState, isLinearInitialized }));
    try {
      const runner = new AutonomousRunner(cfg());
      const runSpy = vi.fn(async () => {}); // keep queued tasks from executing
      (runner as unknown as Internal).runAvailableTasks = runSpy;

      const dispatched: TaskItem = {
        ...task('d1'),
        explicitDispatch: true,
        explicitDispatchPriorState: 'Backlog',
        linearState: 'Backlog',
      };
      const heartbeatPicked: TaskItem = task('h1'); // no explicitDispatch marker
      await runner.enqueueIssues([dispatched], '/x/a');
      // Simulate a heartbeat-enqueued task sharing the queue.
      (runner as unknown as { enqueueCandidate(t: TaskItem, p: string): boolean }).enqueueCandidate(heartbeatPicked, '/x/a');

      await runner.stop();

      // The dispatched task's claim is restored to its recorded prior state;
      // the heartbeat task (never claimed at queue time) is untouched.
      expect(updateIssueState).toHaveBeenCalledWith('d1', 'Backlog');
      expect(updateIssueState).not.toHaveBeenCalledWith('h1', expect.anything());

      // An abort-ignoring executor can settle after shutdown's grace snapshot.
      // The scheduler emits `discarded` in that case; the runner must still
      // restore the explicit claim instead of leaving Linear In Progress.
      const late: TaskItem = {
        ...task('d2'),
        explicitDispatch: true,
        explicitDispatchPriorState: 'Todo',
        linearState: 'Todo',
      };
      (runner as unknown as { scheduler: { emit(event: string, value: unknown): void } })
        .scheduler.emit('discarded', { task: late });
      await vi.waitFor(() => expect(updateIssueState).toHaveBeenCalledWith('d2', 'Todo'));

      const resumed: TaskItem = {
        ...task('d3'),
        explicitDispatch: true,
        linearState: 'In Progress',
      };
      (runner as unknown as { scheduler: { emit(event: string, value: unknown): void } })
        .scheduler.emit('discarded', { task: resumed });
      await Promise.resolve();
      expect(updateIssueState).not.toHaveBeenCalledWith('d3', expect.anything());
    } finally {
      vi.doUnmock('../linear/linear.js');
    }
  });
});

describe('AutonomousRunner explicit-dispatch start (INT-3388)', () => {
  let dbDir: string | null = null;

  afterEach(() => {
    if (dbDir) rmSync(dbDir, { recursive: true, force: true });
    dbDir = null;
  });

  it('autonomousHeartbeat:false starts without a heartbeat cron; default keeps it', async () => {
    dbDir = mkdtempSync(join(tmpdir(), 'osw-dispatch-'));

    const explicit = new AutonomousRunner(cfg({
      autonomousHeartbeat: false,
      triggerNow: false,
      automationLedgerMode: 'primary',
      automationDbPath: join(dbDir, 'a.db'),
    }));
    await explicit.start();
    expect((explicit as unknown as Internal).cronJob).toBeNull();
    expect(explicit.getState().isRunning).toBe(true);
    await explicit.stop();

    const heartbeat = new AutonomousRunner(cfg({
      triggerNow: false,
      automationLedgerMode: 'primary',
      automationDbPath: join(dbDir, 'b.db'),
    }));
    await heartbeat.start();
    expect((heartbeat as unknown as Internal).cronJob).not.toBeNull();
    await heartbeat.stop();
  });
});

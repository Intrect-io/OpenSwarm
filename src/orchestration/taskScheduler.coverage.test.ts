// Coverage gap-filling tests for taskScheduler.ts. Complements
// taskScheduler.cancel.test.ts (cancellation) and
// taskScheduler.concurrency.test.ts (same-project concurrency) by exercising
// paths those two files don't touch: queue mutation (dequeue/clearQueue),
// getNextExecutable's paused/no-slot/no-executable returns, runAvailable's
// full start loop, waitAll/pause/resume, stats/queue accessors, the module
// singleton helpers, and a few edge branches in the watchdog/error paths.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  TaskScheduler,
  normalizeProjectPath,
  getScheduler,
  initScheduler,
  resetScheduler,
} from './taskScheduler.js';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const task = (id: string, priority = 3): TaskItem => ({ id, title: id, priority } as TaskItem);
const okResult = (): PipelineResult => ({ success: true, finalStatus: 'approved' } as PipelineResult);
const failResult = (): PipelineResult => ({ success: false, finalStatus: 'rejected' } as PipelineResult);

// Same shape as the deferred executor in taskScheduler.cancel.test.ts, plus a
// reject hook so we can drive the handleTaskError path directly.
function deferredExecutor() {
  let resolve!: (r: PipelineResult) => void;
  let reject!: (e: unknown) => void;
  const done = new Promise<PipelineResult>((res, rej) => { resolve = res; reject = rej; });
  let abortedSignal: AbortSignal | undefined;
  const exec = (signal: AbortSignal) => { abortedSignal = signal; return done; };
  return { exec, resolve, reject, wasAborted: () => !!abortedSignal?.aborted };
}

// Never settles — keeps a task "running" so slot/queue state is inspectable.
function pendingExecutor() {
  return () => new Promise<PipelineResult>(() => {});
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('normalizeProjectPath edge cases', () => {
  it('normalizes the filesystem root to "/" instead of an empty string', () => {
    expect(normalizeProjectPath('/')).toBe('/');
  });
});

describe('TaskScheduler queue management', () => {
  let sched: TaskScheduler;
  beforeEach(() => { sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true }); });

  it('enqueue skips a task that is already queued', () => {
    const events: string[] = [];
    sched.on('enqueued', () => events.push('enqueued'));
    sched.enqueue(task('a'), '/repo');
    sched.enqueue(task('a'), '/repo'); // duplicate id — no-op
    expect(events).toEqual(['enqueued']);
    expect(sched.getQueuedTasks()).toHaveLength(1);
  });

  it('enqueue skips a task that is already running', () => {
    sched.startTask(task('a'), '/repo', pendingExecutor());
    sched.enqueue(task('a'), '/repo2');
    expect(sched.isTaskQueued('a')).toBe(false);
  });

  it('enqueue inserts a higher-priority task before lower-priority queued ones', () => {
    sched.enqueue(task('low', 4), '/repo');
    sched.enqueue(task('urgent', 1), '/repo');
    expect(sched.getQueuedTasks().map((t) => t.task.id)).toEqual(['urgent', 'low']);
  });

  it('dequeue removes a queued task and reports success', () => {
    sched.enqueue(task('a'), '/repo');
    expect(sched.dequeue('a')).toBe(true);
    expect(sched.getQueuedTasks()).toHaveLength(0);
  });

  it('dequeue returns false for a task that is not queued', () => {
    expect(sched.dequeue('missing')).toBe(false);
  });

  it('clearQueue empties the queue', () => {
    sched.enqueue(task('a'), '/repo');
    sched.enqueue(task('b'), '/repo2');
    sched.clearQueue();
    expect(sched.getQueuedTasks()).toEqual([]);
  });

  it('getAvailableSlots reflects running tasks against maxConcurrent', () => {
    expect(sched.getAvailableSlots()).toBe(4);
    sched.startTask(task('a'), '/repo', pendingExecutor());
    expect(sched.getAvailableSlots()).toBe(3);
  });
});

describe('TaskScheduler.getBusyProjects in default (serialized) mode', () => {
  it('lists every project with a running task when same-project concurrency is off', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    sched.startTask(task('a'), '/repoA', pendingExecutor());
    sched.startTask(task('b'), '/repoB', pendingExecutor());
    expect(new Set(sched.getBusyProjects())).toEqual(new Set(['/repoA', '/repoB']));
  });
});

describe('TaskScheduler.getNextExecutable', () => {
  it('returns null while paused', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    sched.enqueue(task('a'), '/repo');
    sched.pause();
    expect(sched.getNextExecutable()).toBeNull();
  });

  it('returns null when no slots are available', () => {
    const sched = new TaskScheduler({ maxConcurrent: 1, worktreeMode: true });
    sched.startTask(task('running'), '/repoA', pendingExecutor());
    sched.enqueue(task('queued'), '/repoB');
    expect(sched.getNextExecutable()).toBeNull();
  });

  it('returns null when every queued task belongs to a busy project', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    sched.startTask(task('running'), '/repo', pendingExecutor());
    sched.enqueue(task('queued'), '/repo'); // same project as the running task
    expect(sched.getNextExecutable()).toBeNull();
  });
});

describe('TaskScheduler.startTask synchronous executor throw', () => {
  it('rejects the task when the executor throws synchronously instead of returning a rejected promise', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    sched.startTask(task('a'), '/repo', () => { throw new Error('boom'); });
    await flush();
    expect(sched.getStats().failed).toBe(1);
    expect(sched.isTaskRunning('a')).toBe(false);
  });
});

describe('TaskScheduler.handleTaskComplete branches', () => {
  it('counts a resolved-but-unsuccessful, non-cancelled result as failed', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const d = deferredExecutor();
    const events: string[] = [];
    sched.on('failed', () => events.push('failed'));
    sched.startTask(task('a'), '/repo', d.exec);
    d.resolve(failResult());
    await flush();
    expect(events).toEqual(['failed']);
    expect(sched.getStats().failed).toBe(1);
  });

  it('does not count a decomposed parent as a completed implementation', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const d = deferredExecutor();
    const events: string[] = [];
    sched.on('decomposed', () => events.push('decomposed'));
    sched.on('completed', () => events.push('completed'));
    sched.startTask(task('parent'), '/repo', d.exec);
    d.resolve({ ...okResult(), finalStatus: 'decomposed' });
    await flush();

    expect(events).toEqual(['decomposed']);
    expect(sched.getStats()).toMatchObject({ completed: 0, failed: 0 });
  });

  it('does not failure-count a run waiting on an operator decision', async () => {
    // The only blocker is a human answering in Discord; counting the run
    // failed burns the task's failure/STUCK budget while nobody can act.
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const d = deferredExecutor();
    const events: string[] = [];
    sched.on('waiting_on_operator', () => events.push('waiting_on_operator'));
    sched.on('failed', () => events.push('failed'));
    sched.startTask(task('blocked'), '/repo', d.exec);
    d.resolve({ ...failResult(), finalStatus: 'waiting_on_operator' });
    await flush();

    expect(events).toEqual(['waiting_on_operator']);
    expect(sched.getStats()).toMatchObject({ completed: 0, failed: 0 });
  });

  it("refuses to overwrite a running generation with the same task id", async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const current = deferredExecutor();
    const replacement = deferredExecutor();
    expect(sched.startTask(task('dup'), '/repo', current.exec)).toBe(true);
    expect(sched.startTask(task('dup'), '/repo', replacement.exec)).toBe(false);

    current.resolve(okResult());
    await flush();
    expect(sched.getStats().completed).toBe(1);
    expect(replacement.wasAborted()).toBe(false);
  });

  it("allows a task id to be reused only after its prior generation exits", async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const first = deferredExecutor();
    const second = deferredExecutor();
    expect(sched.startTask(task('dup'), '/repo', first.exec)).toBe(true);
    first.reject(new Error('first failed'));
    await flush();
    expect(sched.startTask(task('dup'), '/repo', second.exec)).toBe(true);
    second.resolve(okResult());
    await flush();
    expect(sched.getStats()).toMatchObject({ failed: 1, completed: 1 });
  });
});

describe('TaskScheduler error emission when listeners exist', () => {
  it('emits an error event (and still frees the slot) when an error listener is registered', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const d = deferredExecutor();
    const errors: unknown[] = [];
    sched.on('error', (payload) => errors.push(payload));
    sched.startTask(task('a'), '/repo', d.exec);
    d.reject(new Error('adapter crashed'));
    await flush();
    expect(errors).toHaveLength(1);
    expect(sched.getStats().failed).toBe(1);
    expect(sched.isTaskRunning('a')).toBe(false);
  });
});

describe('TaskScheduler hard watchdog fencing (INT-2521)', () => {
  it("quarantines the repository until an abort-ignoring executor really exits", async () => {
    vi.useFakeTimers();
    try {
      const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, hardTaskTimeoutMs: 100 });
      const hung = deferredExecutor();
      sched.startTask(task('hung'), '/repo', hung.exec);
      await vi.advanceTimersByTimeAsync(101);

      expect(hung.wasAborted()).toBe(true);
      expect(sched.isTaskRunning('hung')).toBe(false); // logical slot reclaimed
      expect(sched.getStats().failed).toBe(1);
      expect(sched.getStats().quarantined).toBe(1);

      const replacement = deferredExecutor();
      expect(sched.startTask(task('replacement'), '/repo', replacement.exec)).toBe(false);

      hung.resolve(okResult()); // old process finally acknowledges cancellation
      await vi.advanceTimersByTimeAsync(0);
      expect(sched.getStats().quarantined).toBe(0);
      expect(sched.startTask(task('replacement'), '/repo', replacement.exec)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a same-project quarantine until every timed-out executor exits', async () => {
    vi.useFakeTimers();
    try {
      const sched = new TaskScheduler({
        maxConcurrent: 3,
        worktreeMode: true,
        allowSameProjectConcurrent: true,
        maxConcurrentPerProject: 2,
        hardTaskTimeoutMs: 100,
      });
      const first = deferredExecutor();
      const second = deferredExecutor();
      expect(sched.startTask(task('hung-a'), '/repo', first.exec)).toBe(true);
      expect(sched.startTask(task('hung-b'), '/repo', second.exec)).toBe(true);
      await vi.advanceTimersByTimeAsync(101);
      expect(sched.getStats().quarantined).toBe(2);

      first.resolve(okResult());
      await vi.advanceTimersByTimeAsync(0);
      expect(sched.getStats().quarantined).toBe(1);
      expect(sched.startTask(task('replacement'), '/repo', pendingExecutor())).toBe(false);

      second.resolve(okResult());
      await vi.advanceTimersByTimeAsync(0);
      expect(sched.getStats().quarantined).toBe(0);
      expect(sched.startTask(task('replacement'), '/repo', pendingExecutor())).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TaskScheduler graceful shutdown races', () => {
  it('suppresses slotFreed scheduling while shutdown races task completion', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 1, worktreeMode: true });
    const d = deferredExecutor();
    const slotFreed = vi.fn();
    sched.on('slotFreed', slotFreed);
    sched.startTask(task('running'), '/repo', d.exec);

    const stopping = sched.shutdown(1_000);
    expect(d.wasAborted()).toBe(true);
    d.resolve({ success: false, finalStatus: 'cancelled' } as PipelineResult);

    await expect(stopping).resolves.toMatchObject({ drained: true, remaining: 0 });
    expect(slotFreed).not.toHaveBeenCalled();
    expect(sched.enqueue(task('late'), '/other')).toBe(false);
    expect(sched.startTask(task('late'), '/other', pendingExecutor())).toBe(false);
  });

  it('returns a bounded non-drained result when an executor ignores abort', async () => {
    vi.useFakeTimers();
    try {
      const sched = new TaskScheduler({ maxConcurrent: 1, worktreeMode: true });
      const d = deferredExecutor();
      sched.startTask(task('hung'), '/repo', d.exec);
      const stopping = sched.shutdown(100);
      await vi.advanceTimersByTimeAsync(101);
      await expect(stopping).resolves.toMatchObject({ drained: false, remaining: 1 });
      expect(d.wasAborted()).toBe(true);
      expect(sched.getUnsettledExecutorCount()).toBe(1);
      d.resolve({ success: false, finalStatus: 'cancelled' } as PipelineResult);
      await vi.advanceTimersByTimeAsync(0);
      await expect(sched.waitForExecutorExit()).resolves.toBeUndefined();
      expect(sched.getUnsettledExecutorCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('TaskScheduler.runAvailable', () => {
  it('starts queued tasks up to the available slot budget and returns the count', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 2, worktreeMode: true });
    sched.enqueue(task('a'), '/repoA');
    sched.enqueue(task('b'), '/repoB');
    sched.enqueue(task('c'), '/repoC');
    const executor = vi.fn(() => new Promise<PipelineResult>(() => {}));
    const started = await sched.runAvailable(executor);
    expect(started).toBe(2);
    expect(sched.getRunningTasks()).toHaveLength(2);
    expect(sched.getQueuedTasks()).toHaveLength(1); // 'c' held back — no free slot
    expect(executor).toHaveBeenCalledTimes(2);
  });

  it('starts nothing when the only queued task belongs to an already-busy project', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    sched.startTask(task('running'), '/repo', pendingExecutor());
    sched.enqueue(task('blocked'), '/repo');
    const executor = vi.fn(() => new Promise<PipelineResult>(() => {}));
    const started = await sched.runAvailable(executor);
    expect(started).toBe(0);
    expect(executor).not.toHaveBeenCalled();
  });

  it('starts a task when maxConcurrentPerProject is configured', async () => {
    const sched = new TaskScheduler({
      maxConcurrent: 4,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
      maxConcurrentPerProject: 2,
    });
    sched.enqueue(task('a'), '/repo');
    const executor = vi.fn(() => new Promise<PipelineResult>(() => {}));
    const started = await sched.runAvailable(executor);
    expect(started).toBe(1);
  });
});

describe('TaskScheduler.waitAll', () => {
  it('resolves with the settled results of every running task', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const d = deferredExecutor();
    sched.startTask(task('a'), '/repo', d.exec);
    const waitPromise = sched.waitAll();
    d.resolve(okResult());
    await expect(waitPromise).resolves.toEqual([okResult()]);
  });

  it('resolves to an empty array when nothing is running', async () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    await expect(sched.waitAll()).resolves.toEqual([]);
  });
});

describe('TaskScheduler pause/resume', () => {
  it('pause sets isPaused and emits a paused event', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const events: string[] = [];
    sched.on('paused', () => events.push('paused'));
    expect(sched.isPaused()).toBe(false);
    sched.pause();
    expect(sched.isPaused()).toBe(true);
    expect(events).toEqual(['paused']);
  });

  it('resume clears isPaused and emits a resumed event', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    const events: string[] = [];
    sched.on('resumed', () => events.push('resumed'));
    sched.pause();
    sched.resume();
    expect(sched.isPaused()).toBe(false);
    expect(events).toEqual(['resumed']);
  });
});

describe('TaskScheduler.getStats byProject aggregation', () => {
  it('counts multiple running tasks under the same project key', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    sched.startTask(task('a'), '/repo', pendingExecutor());
    sched.startTask(task('b'), '/repo', pendingExecutor());
    const stats = sched.getStats();
    expect(stats.byProject.get('/repo')).toBe(2);
    expect(stats.running).toBe(2);
  });
});

describe('TaskScheduler.setTaskStage on an unknown id', () => {
  it('is a no-op when the task id is not currently running', () => {
    const sched = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    expect(() => sched.setTaskStage('missing', 'reviewer')).not.toThrow();
    expect(sched.getRunningTasks()).toHaveLength(0);
  });
});

describe('scheduler singleton helpers', () => {
  afterEach(() => { resetScheduler(); });

  it('getScheduler throws when not initialized and no config is given', () => {
    resetScheduler();
    expect(() => getScheduler()).toThrow(/not initialized/i);
  });

  it('getScheduler(config) creates a singleton, and a later config-less call returns the same instance', () => {
    resetScheduler();
    const first = getScheduler({ maxConcurrent: 2, worktreeMode: true });
    const second = getScheduler();
    expect(second).toBe(first);
  });

  it('initScheduler always creates a fresh instance, replacing any existing one', () => {
    resetScheduler();
    const first = initScheduler({ maxConcurrent: 2, worktreeMode: true });
    const second = initScheduler({ maxConcurrent: 3, worktreeMode: true });
    expect(second).not.toBe(first);
    expect(getScheduler()).toBe(second);
  });

  it('resetScheduler clears the singleton so the next getScheduler() call requires config again', () => {
    initScheduler({ maxConcurrent: 2, worktreeMode: true });
    resetScheduler();
    expect(() => getScheduler()).toThrow();
  });
});

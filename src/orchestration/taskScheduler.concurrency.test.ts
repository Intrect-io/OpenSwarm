// Purpose: same-repo concurrency flag + worktree-isolation guard (INT-1975).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TaskScheduler } from './taskScheduler.js';
import type { TaskItem } from './decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const task = (id: string, priority = 3): TaskItem => ({ id, title: id, priority } as TaskItem);

// Executor that never resolves — keeps the task "running" so isProjectBusy is testable.
function pendingExecutor() {
  return () => new Promise<PipelineResult>(() => {});
}

const approvedResult = (): PipelineResult => ({
  success: true,
  sessionId: 'fairness-test',
  stages: [],
  finalStatus: 'approved',
  totalDuration: 1,
  iterations: 1,
});

describe('TaskScheduler same-project concurrency (INT-1975)', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('serializes same-repo tasks by default (no flag)', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true });
    s.startTask(task('a'), '/repo', pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(true);
  });

  it('allows same-repo parallelism when flag + worktreeMode are both on', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    s.startTask(task('a'), '/repo', pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(false);
    expect(s.getBusyProjects()).toEqual([]);
  });

  it('force-disables the flag when worktreeMode is off, and warns', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: false, allowSameProjectConcurrent: true });
    s.startTask(task('a'), '/repo', pendingExecutor());
    // Guard ignored the flag → project is still busy (serialized, safe).
    expect(s.isProjectBusy('/repo')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requires worktreeMode'));
  });

  it('getNextExecutable hands out two same-repo tasks when concurrency is allowed', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    s.enqueue(task('a'), '/repo');
    s.enqueue(task('b'), '/repo');
    const first = s.getNextExecutable();
    s.startTask(first!.task, first!.projectPath, pendingExecutor());
    // Without the flag this would return null (project busy); with it, 'b' is dispatchable.
    expect(s.getNextExecutable()?.task.id).toBe('b');
  });

  it('caps same-repo parallelism when maxConcurrentPerProject is set', () => {
    const s = new TaskScheduler({
      maxConcurrent: 4,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
      maxConcurrentPerProject: 2,
    });
    s.enqueue(task('a'), '/repo');
    s.enqueue(task('b'), '/repo');
    s.enqueue(task('c'), '/repo');
    s.enqueue(task('d'), '/other');

    const first = s.getNextExecutable();
    s.startTask(first!.task, first!.projectPath, pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(false);

    // Fair selection gives the idle project a slot before /repo fills its cap.
    const other = s.getNextExecutable();
    expect(other?.task.id).toBe('d');
    s.startTask(other!.task, other!.projectPath, pendingExecutor());

    const second = s.getNextExecutable();
    expect(second?.task.id).toBe('b');
    s.startTask(second!.task, second!.projectPath, pendingExecutor());
    expect(s.isProjectBusy('/repo')).toBe(true);
    expect(s.getBusyProjects()).toEqual(['/repo']);

    // Third same-repo task is held back at the explicit project cap.
    expect(s.getNextExecutable()).toBeNull();
  });

  it('reapplies the same-project worktree guard when config is updated', () => {
    const s = new TaskScheduler({ maxConcurrent: 4, worktreeMode: true, allowSameProjectConcurrent: true });
    s.updateConfig({ worktreeMode: false, allowSameProjectConcurrent: true });
    s.startTask(task('a'), '/repo', pendingExecutor());

    expect(s.isProjectBusy('/repo')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('requires worktreeMode'));
  });
});

describe('TaskScheduler project-fair selection (AGT-4146)', () => {
  it('admits other projects before one dominant queue fills every slot', async () => {
    const s = new TaskScheduler({
      maxConcurrent: 5,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    for (let i = 1; i <= 8; i++) s.enqueue(task(`a${i}`), '/repo-a');
    s.enqueue(task('b1'), '/repo-b');
    s.enqueue(task('c1'), '/repo-c');

    await s.runAvailable(async () => new Promise<PipelineResult>(() => {}));

    const byProject = s.getRunningTasks().reduce<Record<string, number>>((counts, running) => {
      counts[running.projectPath] = (counts[running.projectPath] ?? 0) + 1;
      return counts;
    }, {});
    expect(byProject).toEqual({ '/repo-a': 3, '/repo-b': 1, '/repo-c': 1 });
  });

  it('remains work-conserving when only one project has queued work', async () => {
    const s = new TaskScheduler({
      maxConcurrent: 4,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    for (let i = 1; i <= 4; i++) s.enqueue(task(`a${i}`), '/repo-a');

    expect(await s.runAvailable(async () => new Promise<PipelineResult>(() => {}))).toBe(4);
    expect(s.getRunningTasks()).toHaveLength(4);
  });

  it('gives urgent work a larger deterministic share without starving low priority', async () => {
    const s = new TaskScheduler({
      maxConcurrent: 5,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    for (let i = 1; i <= 8; i++) s.enqueue(task(`urgent-${i}`, 1), '/urgent');
    for (let i = 1; i <= 3; i++) s.enqueue(task(`low-${i}`, 4), '/low');

    await s.runAvailable(async () => new Promise<PipelineResult>(() => {}));

    expect(s.getRunningTasks().filter((running) => running.projectPath === '/urgent')).toHaveLength(4);
    expect(s.getRunningTasks().filter((running) => running.projectPath === '/low')).toHaveLength(1);
  });

  it('does not reset fairness after every completion when only one slot exists', async () => {
    const s = new TaskScheduler({
      maxConcurrent: 1,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    for (let i = 1; i <= 10; i++) s.enqueue(task(`urgent-${i}`, 1), '/urgent');
    for (let i = 1; i <= 3; i++) s.enqueue(task(`low-${i}`, 4), '/low');

    const selected: string[] = [];
    for (let i = 0; i < 7; i++) {
      const next = s.getNextExecutable();
      selected.push(next!.projectPath);
      s.startTask(next!.task, next!.projectPath, async () => approvedResult());
      await vi.waitFor(() => expect(s.getRunningTasks()).toHaveLength(0));
    }

    expect(selected).toEqual(['/urgent', '/low', '/urgent', '/urgent', '/urgent', '/urgent', '/low']);
  });

  it('preserves FIFO order within each project while rotating across projects', () => {
    const s = new TaskScheduler({
      maxConcurrent: 3,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    s.enqueue(task('a-first'), '/repo-a');
    s.enqueue(task('a-second'), '/repo-a');
    s.enqueue(task('b-first'), '/repo-b');

    const selected: string[] = [];
    for (let i = 0; i < 3; i++) {
      const next = s.getNextExecutable();
      selected.push(next!.task.id);
      s.startTask(next!.task, next!.projectPath, pendingExecutor());
    }

    expect(selected).toEqual(['a-first', 'b-first', 'a-second']);
  });

  it('exposes the last weighted decision and per-project blocking state', () => {
    const s = new TaskScheduler({
      maxConcurrent: 1,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    s.enqueue(task('urgent', 1), '/repo-a');
    s.enqueue(task('low', 4), '/repo-b');

    const selected = s.getNextExecutable()!;
    s.startTask(selected.task, selected.projectPath, pendingExecutor());

    const fairness = s.getStats().fairness;
    expect(fairness.lastSelection).toMatchObject({
      taskId: 'urgent',
      projectPath: '/repo-a',
      weight: 4,
      virtualRuntimeBefore: 0,
      virtualRuntimeAfter: 0.25,
    });
    expect(fairness.lastSelection?.contenders).toEqual([
      expect.objectContaining({ projectPath: '/repo-a', taskId: 'urgent', weight: 4 }),
      expect.objectContaining({ projectPath: '/repo-b', taskId: 'low', weight: 1 }),
    ]);
    expect(fairness.projects).toEqual([
      expect.objectContaining({ projectPath: '/repo-a', running: 1, queued: 0 }),
      expect.objectContaining({
        projectPath: '/repo-b',
        running: 0,
        queued: 1,
        blockedReason: 'global-capacity',
      }),
    ]);
  });

  it('uses only the priority/FIFO head of each project as a fairness candidate', () => {
    const s = new TaskScheduler({
      maxConcurrent: 4,
      worktreeMode: true,
      allowSameProjectConcurrent: true,
    });
    s.enqueue(task('a-low-first', 4), '/repo-a');
    s.enqueue(task('b-normal', 3), '/repo-b');
    s.enqueue(task('a-urgent-later', 1), '/repo-a');
    s.enqueue(task('a-low-second', 4), '/repo-a');

    const selected: string[] = [];
    for (let i = 0; i < 4; i++) {
      const next = s.getNextExecutable();
      selected.push(next!.task.id);
      s.startTask(next!.task, next!.projectPath, pendingExecutor());
    }

    // Linear priority leads inside /repo-a; equal-priority lows remain FIFO.
    // /repo-b still receives a slot before /repo-a fills the pool.
    expect(selected).toEqual(['a-urgent-later', 'b-normal', 'a-low-first', 'a-low-second']);
  });
});

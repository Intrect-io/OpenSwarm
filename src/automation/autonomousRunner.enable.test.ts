// Purpose: enableProject must also add the repo to allowedProjects so
// resolveProjectPath reads its openswarm.json mapping (INT-1973).
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { AutonomousRunner, decisionSelectionBudget } from './autonomousRunner.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { normalizeProjectPath } from '../orchestration/taskScheduler.js';

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/x/a'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  dryRun: true,
  ...over,
});

describe('AutonomousRunner.enableProject (INT-1973)', () => {
  it('enabling a repo also allows it (resolveProjectPath reads only allowed paths)', () => {
    const r = new AutonomousRunner(cfg());
    r.enableProject('/x/wave');
    expect(r.getEnabledProjects()).toContain('/x/wave');
    expect(r.getAllowedProjects()).toContain('/x/wave');
  });

  it('does not duplicate an already-allowed path', () => {
    const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
    r.enableProject('/x/a');
    expect(r.getAllowedProjects().filter((p) => p === '/x/a')).toHaveLength(1);
    expect(r.getEnabledProjects()).toContain('/x/a');
  });

  it('uses one canonical identity when enable and disable arrive through path aliases', () => {
    const root = mkdtempSync(join(tmpdir(), 'openswarm-project-alias-'));
    const repo = join(root, 'repo');
    const alias = join(root, 'repo-alias');
    try {
      mkdirSync(repo);
      symlinkSync(repo, alias, 'dir');
      const r = new AutonomousRunner(cfg({ allowedProjects: [alias] }));

      r.enableProject(alias);
      expect(r.getEnabledProjects()).toEqual([normalizeProjectPath(repo)]);
      expect(r.getAllowedProjects()).toEqual([alias]);

      // A disable request using the real path must remove the alias-enabled
      // repository; otherwise a concurrent heartbeat can admit new work after
      // the UI reports the repository disabled.
      r.disableProject(repo);
      expect(r.getEnabledProjects()).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('decisionSelectionBudget', () => {
  it('oversamples candidates so post-selection skips do not leave slots idle', () => {
    expect(decisionSelectionBudget(3, 50)).toBe(9);
    expect(decisionSelectionBudget(6, 50)).toBe(18);
  });

  it('never exceeds available candidates and handles empty inputs', () => {
    expect(decisionSelectionBudget(6, 4)).toBe(4);
    expect(decisionSelectionBudget(0, 10)).toBe(0);
    expect(decisionSelectionBudget(3, 0)).toBe(0);
  });
});

describe('AutonomousRunner project-selection gating (INT-2207)', () => {
  // shouldFilterByEnabled is private; the gating behavior is what matters.
  type Internal = {
    shouldFilterByEnabled(): boolean;
    getBackgroundServiceProjects(): string[];
  };
  const filtersOn = (r: AutonomousRunner) => (r as unknown as Internal).shouldFilterByEnabled();
  const backgroundProjects = (r: AutonomousRunner) =>
    (r as unknown as Internal).getBackgroundServiceProjects();

  it('untouched + empty → filter OFF (legacy run-all fallback)', () => {
    const r = new AutonomousRunner(cfg());
    expect(r.getEnabledProjects()).toHaveLength(0);
    expect(filtersOn(r)).toBe(false); // no explicit selection yet → run all allowed
    expect(backgroundProjects(r)).toEqual(['/x/a']);
  });

  it('disabling every project → filter ON even though empty → nothing runs', () => {
    const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
    r.enableProject('/x/a');
    expect(filtersOn(r)).toBe(true);
    expect(backgroundProjects(r)).toEqual(['/x/a']);
    r.disableProject('/x/a');
    expect(r.getEnabledProjects()).toHaveLength(0);
    // The bug: empty used to mean "run all". Now touched → filter stays ON, so an
    // empty enabled-set means nothing runs.
    expect(filtersOn(r)).toBe(true);
    expect(backgroundProjects(r)).toEqual([]);
  });

  it('disabling alone (no prior enable) still touches the selection', () => {
    const r = new AutonomousRunner(cfg());
    r.disableProject('/x/a');
    expect(filtersOn(r)).toBe(true);
    expect(backgroundProjects(r)).toEqual([]);
  });
});

describe('AutonomousRunner per-project candidate cap', () => {
  const makeTask = (id: string, projectPath: string): TaskItem => ({
    id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 3,
    projectPath,
    issueId: id,
    issueIdentifier: id.toUpperCase(),
    linearState: 'Todo',
    createdAt: Date.now(),
  });

  it('does not enqueue same-project heartbeat candidates past maxConcurrentPerProject', async () => {
    const repo = '/x/a';
    const other = '/x/b';
    const tasks = [
      makeTask('repo-1', repo),
      makeTask('repo-2', repo),
      makeTask('repo-3', repo),
      makeTask('other-1', other),
    ];
    const r = new AutonomousRunner(cfg({
      allowedProjects: [repo, other],
      autoExecute: true,
      maxConcurrentTasks: 3,
      allowSameProjectConcurrent: true,
      worktreeMode: true,
      maxConcurrentPerProject: 2,
    }));
    const internal = r as unknown as {
      engine: {
        heartbeatMultiple: ReturnType<typeof vi.fn>;
      };
      heartbeatParallel(tasks: TaskItem[]): Promise<void>;
      resolveProjectPath(task: TaskItem): Promise<string | null>;
      detectSafeCandidateIds(candidates: Array<{ task: TaskItem }>): Promise<Set<string>>;
      runAvailableTasks(): Promise<void>;
    };
    internal.engine.heartbeatMultiple = vi.fn(async () => ({
      action: 'execute',
      tasks: tasks.map(task => ({ task, workflow: {} })),
      reason: 'test',
      skippedCount: 0,
    }));
    internal.resolveProjectPath = vi.fn(async task => task.projectPath ?? null);
    internal.detectSafeCandidateIds = vi.fn(async candidates => new Set(candidates.map(c => c.task.id)));
    internal.runAvailableTasks = vi.fn(async () => {});

    await internal.heartbeatParallel(tasks);

    expect(r.getQueuedTasks().map(q => q.task.id)).toEqual(['repo-1', 'repo-2', 'other-1']);
    expect(r.getQueuedTasks().filter(q => q.projectPath === repo)).toHaveLength(2);
  });
});

describe('AutonomousRunner heartbeat backfill (INT-2570 follow-up)', () => {
  const makeTask = (id: string, projectPath: string): TaskItem => ({
    id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 3,
    projectPath,
    issueId: id,
    issueIdentifier: id.toUpperCase(),
    linearState: 'Todo',
    createdAt: Date.now(),
  });

  // Live incident: a slow multi-heartbeat task (INT-2061) kept being the decision
  // engine's top pick every 5-minute cycle even while already running, and the
  // heartbeat gave up the instant that happened — 7 of 8 scheduler slots sat idle
  // for 4+ hours with 18 other executable tasks waiting, because the loop treated
  // "selectionBudget covered the whole candidate pool" as "nothing left to try",
  // even though the one thing it found was immediately discarded as a duplicate.
  it('backfills other candidates when the decision engine\'s pick is already running', async () => {
    const repo = '/x/a';
    const stuck = makeTask('stuck-1', repo);
    const fresh = makeTask('fresh-1', repo);

    const r = new AutonomousRunner(cfg({
      allowedProjects: [repo],
      autoExecute: true,
      maxConcurrentTasks: 3,
      worktreeMode: true,
    }));
    const internal = r as unknown as {
      engine: { heartbeatMultiple: ReturnType<typeof vi.fn> };
      scheduler: {
        getAvailableSlots: ReturnType<typeof vi.fn>;
        getStats: ReturnType<typeof vi.fn>;
        isTaskRunning: ReturnType<typeof vi.fn>;
        isTaskQueued: ReturnType<typeof vi.fn>;
        isProjectBusy: ReturnType<typeof vi.fn>;
      };
      heartbeatParallel(tasks: TaskItem[]): Promise<void>;
      resolveProjectPath(task: TaskItem): Promise<string | null>;
      detectSafeCandidateIds(candidates: Array<{ task: TaskItem }>): Promise<Set<string>>;
      runAvailableTasks(): Promise<void>;
    };

    // Pass 1 (top-of-heartbeat): the decision engine's only pick is already
    // running. Pass 2 (backfill): it should be asked again with the remaining
    // pool and surface the fresh candidate.
    internal.engine.heartbeatMultiple = vi.fn()
      .mockResolvedValueOnce({ action: 'execute', tasks: [{ task: stuck, workflow: {} }], reason: 'test', skippedCount: 0 })
      .mockResolvedValueOnce({ action: 'execute', tasks: [{ task: fresh, workflow: {} }], reason: 'test', skippedCount: 0 });

    internal.scheduler.getAvailableSlots = vi.fn(() => 3);
    internal.scheduler.getStats = vi.fn(() => ({ running: 1, queued: 0, completed: 0, failed: 0 }) as ReturnType<typeof internal.scheduler.getStats>);
    internal.scheduler.isTaskRunning = vi.fn((id: string) => id === 'stuck-1');
    internal.scheduler.isTaskQueued = vi.fn(() => false);
    internal.scheduler.isProjectBusy = vi.fn(() => false);
    internal.resolveProjectPath = vi.fn(async task => task.projectPath ?? null);
    internal.detectSafeCandidateIds = vi.fn(async candidates => new Set(candidates.map(c => c.task.id)));
    internal.runAvailableTasks = vi.fn(async () => {});

    await internal.heartbeatParallel([stuck, fresh]);

    expect(internal.engine.heartbeatMultiple).toHaveBeenCalledTimes(2);
    expect(r.getQueuedTasks().map(q => q.task.id)).toEqual(['fresh-1']);
  });
});

describe('AutonomousRunner backlog grooming mapping (INT-1609)', () => {
  type Internal = { groupTasksForGrooming(tasks: TaskItem[]): Promise<Map<string, TaskItem[]>> };

  it('does not map an unmapped Linear project to the only allowed repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-groom-'));
    try {
      const r = new AutonomousRunner(cfg({ allowedProjects: [dir] }));
      const groups = await (r as unknown as Internal).groupTasksForGrooming([{
        id: 'task-1',
        source: 'linear',
        title: 'other project',
        priority: 1,
        createdAt: 1,
        issueId: 'issue-1',
        linearProject: { id: '11111111-1111-4111-8111-111111111111', name: 'Other' },
      }]);
      expect(groups.size).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('groups tasks only through explicit openswarm.json Linear project mapping', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'openswarm-groom-'));
    try {
      const projectId = '22222222-2222-4222-8222-222222222222';
      writeFileSync(join(dir, 'openswarm.json'), JSON.stringify({
        schemaVersion: 1,
        linear: { projectId },
      }));
      const r = new AutonomousRunner(cfg({ allowedProjects: [dir] }));
      const groups = await (r as unknown as Internal).groupTasksForGrooming([{
        id: 'task-1',
        source: 'linear',
        title: 'mapped project',
        priority: 1,
        createdAt: 1,
        issueId: 'issue-1',
        linearProject: { id: projectId, name: 'Mapped' },
      }]);
      expect(groups.get(normalizeProjectPath(dir))?.map(t => t.id)).toEqual(['task-1']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

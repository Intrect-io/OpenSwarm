// Created: 2026-11-21
// Purpose: Whole-runner regression for the idle daemon: fetch backoff across cron ticks, bounded
//          missing-worktree origin probes, and serial-mode idle streaks (AGT-4607, round-1 redteam B-F3).
// Dependencies: vitest fake timers, better-sqlite3 (tmp automation.db), croner via idleBackoff.ts
// Test Status: passing

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import type { Cron } from 'croner';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { IdleBackoff } from './idleBackoff.js';

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({
  recordTaskOutcome: vi.fn(async () => {}),
  promoteStagedMemories: vi.fn(async () => 0),
}));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));
vi.mock('./definitionOfReady.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./definitionOfReady.js')>(),
  partitionByDefinitionOfReady: async (tasks: unknown[]) => ({ ready: tasks, held: [] }),
}));
vi.mock('../support/timeWindow.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../support/timeWindow.js')>(),
  checkWorkAllowed: () => ({ allowed: true }),
}));

const git = vi.hoisted(() => ({
  lsRemote: undefined as unknown as ReturnType<typeof vi.fn>,
  findPullRequestForBranch: undefined as unknown as ReturnType<typeof vi.fn>,
  pruneWorktrees: undefined as unknown as ReturnType<typeof vi.fn>,
}));
// No real git: pruning is a no-op and the PR lookup is observable.
vi.mock('../support/worktreeManager.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../support/worktreeManager.js')>(),
  pruneWorktrees: (...args: unknown[]) => git.pruneWorktrees(...args),
  findPullRequestForBranch: (...args: unknown[]) => git.findPullRequestForBranch(...args),
}));
// The real reconciler, with its origin lookup replaced.
vi.mock('./missingWorktreeReconciler.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./missingWorktreeReconciler.js')>();
  return {
    ...real,
    reconcileMissingWorktrees: (deps: Parameters<typeof real.reconcileMissingWorktrees>[0]) =>
      real.reconcileMissingWorktrees({ ...deps, lsRemote: (p: string, b: string) => git.lsRemote(p, b) }),
  };
});

type InternalRunner = {
  idle: IdleBackoff;
  cronJob: Cron | null;
  heartbeatCompletion: Promise<void> | null;
  refreshKnowledgeGraphs(): void;
  durableRuns: DurableRunCoordinator;
  unresolvableIssueIds: Set<string>;
  engine: { heartbeat: (tasks: TaskItem[]) => Promise<unknown> };
  resolveProjectPath: (task: TaskItem) => Promise<string | null>;
};

const TICK_MS = 5 * 60_000;

function lines(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((c) => c.map(String).join(' '));
}

describe('idle daemon, whole runner (AGT-4607, B-F3)', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST, on a 5-minute boundary
    root = mkdtempSync(join(tmpdir(), 'openswarm-runner-idle-'));
    dbPath = join(root, 'automation.db');
    vi.stubEnv('OPENSWARM_AUTOMATION_DB', dbPath);
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
    git.lsRemote = vi.fn(async () => '');
    git.findPullRequestForBranch = vi.fn(async () => null);
    git.pruneWorktrees = vi.fn(async () => {});
  });

  afterEach(async () => {
    const reconciler = await import('./missingWorktreeReconciler.js');
    reconciler.resetOriginLookupBackoffForTests();
    (await import('./idleBackoff.js')).clearProgressSource();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function setup(overrides: Record<string, unknown> = {}) {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const fetchTasks = vi.fn(async () => [] as TaskItem[]);
    const source = {
      kind: 'linear', fetchTasks,
      lookupIssueState: vi.fn(async () => ({ ok: true as const, issue: { state: 'Todo', stateType: 'unstarted' } })),
      updateState: vi.fn(async () => true), addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource;
    execution.setTaskSource(source);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: [root], heartbeatSchedule: '*/5 * * * *',
      autoExecute: true, dryRun: true, pairMode: true, maxConcurrentTasks: 4, worktreeMode: true,
      autonomousHeartbeat: false, automationLedgerMode: 'primary', automationDbPath: dbPath,
      minFreeDiskGiB: 0, ...overrides,
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    return { runner, internal, fetchTasks };
  }

  /** Let a pending re-fire start, then wait for whatever heartbeat is in flight. */
  async function settle(internal: InternalRunner): Promise<void> {
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(0);
      const running = internal.heartbeatCompletion;
      if (!running) return;
      await running;
    }
  }

  async function teardown(internal: InternalRunner): Promise<void> {
    internal.cronJob?.stop();
    await settle(internal);
    internal.durableRuns.close();
  }

  /** Expected fetch ticks from the module's own constants (threshold, multiplier cap, 1 h wall cap). */
  async function expectedFetchTicks(totalTicks: number): Promise<number[]> {
    const mod = await import('./idleBackoff.js');
    const cap = Math.max(1, Math.min(mod.DEFAULT_MAX_BACKOFF_MULTIPLIER, Math.floor(mod.DEFAULT_MAX_BACKOFF_INTERVAL_MS / TICK_MS)));
    const ticks: number[] = [];
    let tick = 1;
    let empties = 0;
    let multiplier = 1;
    while (tick <= totalTicks) {
      ticks.push(tick);
      empties++;
      if (empties >= mod.DEFAULT_EMPTY_SELECTION_THRESHOLD) multiplier = Math.min(cap, multiplier * 2);
      tick += multiplier;
    }
    return ticks;
  }

  async function driveIdleTicks(fetched: () => TaskItem[]) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup();
    let tick = 0;
    const fetchTicks: number[] = [];
    const fetchTimes: number[] = [];
    fetchTasks.mockImplementation(async () => { fetchTicks.push(tick); fetchTimes.push(Date.now()); return fetched(); });
    expect(runner.enableHeartbeat()).toBe(true);
    const M = 40;
    for (tick = 1; tick <= M; tick++) {
      await vi.advanceTimersByTimeAsync(TICK_MS);
      await settle(internal);
    }
    await teardown(internal);
    return { log, fetchTasks, fetchTicks, fetchTimes, M };
  }

  async function assertBackoff(run: Awaited<ReturnType<typeof driveIdleTicks>>) {
    const { log, fetchTasks, fetchTicks, fetchTimes, M } = run;
    const expected = await expectedFetchTicks(M);
    expect(fetchTicks).toEqual(expected);
    expect(fetchTasks.mock.calls.length).toBeLessThan(M / 3);
    const gaps = fetchTicks.slice(1).map((t, i) => t - fetchTicks[i]);
    expect(gaps.slice(0, 6)).toEqual([1, 1, 2, 4, 8, 8]); // '*/5' → cap min(8, floor(60/5)) = 8
    const { DEFAULT_MAX_BACKOFF_INTERVAL_MS } = await import('./idleBackoff.js');
    const wallGaps = fetchTimes.slice(1).map((t, i) => t - fetchTimes[i]);
    expect(Math.max(...wallGaps)).toBeLessThanOrEqual(DEFAULT_MAX_BACKOFF_INTERVAL_MS); // the idle ceiling is 1 h
    const streakLines = lines(log).filter((l) => l.includes('consecutive empty selections'));
    expect(streakLines).toHaveLength(1);
    expect(streakLines[0]).toMatch(/^\[HB\] \[IdleBackoff\] 3 consecutive empty selections/);
    expect(lines(log).some((l) => l.includes('back to the base interval'))).toBe(false);
  }

  it('fetch count backs off across M idle heartbeats with no selectable issue', async () => {
    const run = await driveIdleTicks(() => []);
    await assertBackoff(run);
  }, 60_000);

  it('fetch count backs off across M idle heartbeats with no selectable issue (project-less tasks)', async () => {
    const projectless: TaskItem = {
      id: 'AGT-1', issueId: 'AGT-1', issueIdentifier: 'AGT-1', source: 'linear', title: 'No project',
      priority: 2, createdAt: Date.now(), linearState: 'Todo',
    };
    const run = await driveIdleTicks(() => [{ ...projectless }, { ...projectless, id: 'AGT-2', issueId: 'AGT-2', issueIdentifier: 'AGT-2' }]);
    await assertBackoff(run);
    // Dropped in filterAlreadyProcessed, not at an earlier return.
    const skipped = lines(run.log).filter((l) => l.includes('Skipped 2 issue(s) with no Linear project'));
    expect(skipped).toHaveLength(run.fetchTicks.length);
  }, 60_000);

  function seedMissingWorktreeRow(internal: InternalRunner, n: number, retryAt: number) {
    const issueId = `AGT-${n}`;
    const branchName = `swarm/agt-${n}`;
    const res = internal.durableRuns.importLegacyRun({
      issueId, source: 'linear', identifier: issueId, title: `T${n}`, projectPath: root,
      state: 'RETRY_AT', retryAt, branchName, worktreePath: join(root, 'worktree', issueId),
    });
    expect(res?.imported).toBe(true);
    return { issueId, branchName, worktreePath: join(root, 'worktree', issueId) };
  }

  it('missing-worktree origin probes stay bounded across M idle heartbeats', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { MAX_TRANSIENT_FAILURES, originLookupBackoffMs } = await import('./missingWorktreeReconciler.js');
    const { runner, internal } = await setup();
    const STEP_MS = 60 * 60_000; // one heartbeat per simulated hour
    // Wall time to reach the cap, from the reconciler's own schedule.
    let toCap = 0;
    for (let f = 1; f < MAX_TRANSIENT_FAILURES; f++) toCap += Math.ceil(originLookupBackoffMs(f) / STEP_MS) * STEP_MS;
    const M = Math.ceil(toCap / STEP_MS) + 48; // two more days after the park
    expect(M * STEP_MS).toBeGreaterThan(2 * 24 * STEP_MS);
    const retryAt = Date.now() + (M + 24) * STEP_MS; // stays RETRY_AT for the whole span
    const rows = [seedMissingWorktreeRow(internal, 11, retryAt), seedMissingWorktreeRow(internal, 12, retryAt)];
    const probeTimes = new Map<string, number[]>();
    git.lsRemote.mockImplementation(async (_p: string, branch: string) => {
      probeTimes.set(branch, [...(probeTimes.get(branch) ?? []), Date.now()]);
      throw new Error('Could not resolve host: github.com');
    });

    const backoffDb = new Database(dbPath, { readonly: true });
    let sawBackoffRows = false;
    for (let i = 0; i < M; i++) {
      await runner.heartbeat();
      await settle(internal);
      for (const row of rows) {
        const run = internal.durableRuns.getRun(row.issueId)!;
        const probes = probeTimes.get(row.branchName)?.length ?? 0;
        expect(probes).toBeLessThanOrEqual(MAX_TRANSIENT_FAILURES);
        if (probes < MAX_TRANSIENT_FAILURES) {
          expect(run.state).toBe('RETRY_AT');
          expect(run.worktreePath).toBe(row.worktreePath);
        } else {
          expect(run.state).toBe('NEEDS_HUMAN');
          expect(run.worktreePath ?? null).toBeNull();
        }
      }
      if (i === 2) {
        // The backoff lives in the tmp automation DB, not the user's.
        const count = backoffDb.prepare('SELECT COUNT(*) AS n FROM automation_origin_lookup_backoff').get() as { n: number };
        sawBackoffRows = count.n === rows.length;
      }
      vi.setSystemTime(Date.now() + STEP_MS);
    }
    backoffDb.close();
    expect(sawBackoffRows).toBe(true);

    const warnLines = lines(warn);
    expect(warnLines.some((l) => l.includes('backoff store unavailable'))).toBe(false);
    for (const row of rows) {
      const times = probeTimes.get(row.branchName)!;
      expect(times).toHaveLength(MAX_TRANSIENT_FAILURES); // parked, never probed again
      const gaps = times.slice(1).map((t, i) => t - times[i]);
      expect(Math.max(...gaps)).toBeLessThanOrEqual(6 * 60 * 60_000 + STEP_MS); // the reconciler's 6 h ceiling
      // Lower bound too: without the backoff the probes would land on consecutive hourly heartbeats.
      gaps.forEach((gap, i) => expect(gap).toBeGreaterThanOrEqual(originLookupBackoffMs(i + 1)));
      expect(warnLines.filter((l) => l.includes(`Origin branch lookup failed for missing worktree ${row.issueId} `))).toHaveLength(1);
      expect(warnLines.filter((l) => l.includes(`${row.issueId}: parked for a person`))).toHaveLength(1);
      const run = internal.durableRuns.getRun(row.issueId)!;
      expect(run.state).toBe('NEEDS_HUMAN');
      expect(run.worktreePath ?? null).toBeNull();
    }
    expect(git.findPullRequestForBranch).not.toHaveBeenCalled();
    expect(git.pruneWorktrees).toHaveBeenCalled();
    await teardown(internal);
  }, 60_000);

  it('missing-worktree origin probes stay bounded across M idle heartbeats (permanent failure)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, internal } = await setup();
    const STEP_MS = 60 * 60_000;
    const M = 72;
    const row = seedMissingWorktreeRow(internal, 21, Date.now() + (M + 24) * STEP_MS);
    git.lsRemote.mockRejectedValue(new Error('Repository not found'));
    for (let i = 0; i < M; i++) {
      await runner.heartbeat();
      await settle(internal);
      expect(git.lsRemote).toHaveBeenCalledTimes(1);
      const run = internal.durableRuns.getRun(row.issueId)!;
      expect(run.state).toBe('NEEDS_HUMAN');
      expect(run.worktreePath ?? null).toBeNull();
      vi.setSystemTime(Date.now() + STEP_MS);
    }
    expect(lines(warn).filter((l) => l.includes(`${row.issueId}: parked for a person — origin lookup fails permanently`))).toHaveLength(1);
    expect(git.findPullRequestForBranch).not.toHaveBeenCalled();
    await teardown(internal);
  }, 60_000);

  it('serial mode: an unresolvable task does not reset the idle backoff', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup({ maxConcurrentTasks: 1 });
    expect(runner.enableHeartbeat()).toBe(true); // autonomousHeartbeat on: the unresolvable branch re-fires
    const resolve = vi.fn(async () => null);
    internal.resolveProjectPath = resolve;
    const engineHeartbeat = vi.fn(async (tasks: TaskItem[]) => ({ action: 'execute', task: tasks[0], reason: 'test' }));
    internal.engine.heartbeat = engineHeartbeat;

    // A logged idle streak first.
    for (let i = 0; i < 4; i++) {
      await runner.heartbeat();
      await settle(internal);
    }
    const before = { empty: internal.idle.getConsecutiveEmpty(), multiplier: internal.idle.getMultiplier() };
    expect(before.empty).toBe(4);
    expect(before.multiplier).toBeGreaterThan(1);
    expect(engineHeartbeat).not.toHaveBeenCalled();

    const task: TaskItem = {
      id: 'AGT-31', issueId: 'AGT-31', issueIdentifier: 'AGT-31', source: 'linear', title: 'Unmapped',
      priority: 2, createdAt: Date.now(), linearState: 'Todo',
      linearProject: { id: 'proj-unmapped', name: 'NoSuchRepo' },
    } as TaskItem;
    fetchTasks.mockResolvedValue([task]);
    const fetchesBefore = fetchTasks.mock.calls.length;
    await runner.heartbeat();
    await settle(internal); // includes the immediate scheduleNextHeartbeat re-fire

    // The task really reached the unresolvable branch.
    expect(engineHeartbeat).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalled();
    expect(internal.unresolvableIssueIds.has('AGT-31')).toBe(true);
    expect(lines(error).some((l) => l.includes('Failed to resolve project path for "NoSuchRepo"'))).toBe(true);
    // The re-fire ran and found nothing selectable: one more empty selection.
    const refires = fetchTasks.mock.calls.length - fetchesBefore - 1;
    expect(refires).toBe(1);

    expect(internal.idle.snapshot(true).lastProgressAt).toBeNull();
    expect(internal.idle.getConsecutiveEmpty()).toBe(before.empty + 1 + refires);
    expect(internal.idle.getMultiplier()).toBeGreaterThanOrEqual(before.multiplier);
    expect(lines(log).some((l) => l.includes('back to the base interval'))).toBe(false);
    expect(lines(log).filter((l) => l.includes('consecutive empty selections'))).toHaveLength(1);
    await teardown(internal);
  }, 60_000);

  /** Serial runner with a logged idle streak, then one task the engine picks for execution. */
  async function serialRunnerAfterIdleStreak(enabledPath: string) {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup({ maxConcurrentTasks: 1 });
    const selection = internal as unknown as { enabledProjects: Set<string>; projectSelectionTouched: boolean };
    selection.enabledProjects = new Set([enabledPath]);
    selection.projectSelectionTouched = true;
    // The project path resolves only after the clock moved, so a reset before resolution is visible.
    let resolvedAt = 0;
    const resolve = vi.fn(async () => {
      vi.setSystemTime(Date.now() + 60_000);
      resolvedAt = Date.now();
      return root;
    });
    internal.resolveProjectPath = resolve;
    const engineHeartbeat = vi.fn(async (tasks: TaskItem[]) => ({ action: 'execute', task: tasks[0], reason: 'test' }));
    internal.engine.heartbeat = engineHeartbeat;
    // The pipeline itself is replaced by a cheap failed result; it records the idle state it saw.
    const progressAtExecution: (string | null)[] = [];
    const executeDurably = vi.fn(async () => {
      progressAtExecution.push(internal.idle.snapshot(true).lastProgressAt);
      return { success: false, finalStatus: 'failed', iterations: 1, totalDuration: 0, stages: [] };
    });
    (internal as unknown as { executeDurably: typeof executeDurably }).executeDurably = executeDurably;

    for (let i = 0; i < 4; i++) {
      await runner.heartbeat();
      await settle(internal);
    }
    const before = { empty: internal.idle.getConsecutiveEmpty(), multiplier: internal.idle.getMultiplier() };
    expect(before.empty).toBe(4);
    expect(before.multiplier).toBeGreaterThan(1);
    expect(engineHeartbeat).not.toHaveBeenCalled();
    expect(internal.idle.snapshot(true).lastProgressAt).toBeNull();

    const task: TaskItem = {
      id: 'AGT-41', issueId: 'AGT-41', issueIdentifier: 'AGT-41', source: 'linear', title: 'Mapped',
      priority: 2, createdAt: Date.now(), linearState: 'Todo',
      linearProject: { id: 'proj-mapped', name: 'Mapped' },
    } as TaskItem;
    fetchTasks.mockResolvedValue([task]);
    await runner.heartbeat();
    await settle(internal);
    expect(engineHeartbeat).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalled();
    return { log, internal, before, executeDurably, progressAtExecution, resolvedAt: () => resolvedAt };
  }

  it('serial mode: a task that really starts resets the idle backoff', async () => {
    const run = await serialRunnerAfterIdleStreak(root);
    const { internal } = run;

    expect(run.executeDurably).toHaveBeenCalledTimes(1);
    const lastProgressAt = internal.idle.snapshot(true).lastProgressAt;
    expect(lastProgressAt).not.toBeNull();
    // Marked after the project path resolved, and before the pipeline ran.
    expect(Date.parse(lastProgressAt!)).toBeGreaterThanOrEqual(run.resolvedAt());
    expect(run.progressAtExecution).toEqual([lastProgressAt]);
    expect(internal.idle.getMultiplier()).toBe(1);
    expect(internal.idle.getConsecutiveEmpty()).toBe(0);
    expect(lines(run.log).filter((l) => l.includes('back to the base interval'))).toHaveLength(1);
    await teardown(internal);
  }, 60_000);

  it('serial mode: a disabled project does not reset the idle backoff', async () => {
    const run = await serialRunnerAfterIdleStreak(join(root, 'some-other-repo'));
    const { internal } = run;

    expect(lines(run.log).some((l) => l.includes(`Project not enabled, skipping: ${root}`))).toBe(true);
    expect(run.executeDurably).not.toHaveBeenCalled();
    expect(internal.idle.snapshot(true).lastProgressAt).toBeNull();
    expect(internal.idle.getConsecutiveEmpty()).toBe(run.before.empty + 1);
    expect(internal.idle.getMultiplier()).toBeGreaterThanOrEqual(run.before.multiplier);
    expect(lines(run.log).some((l) => l.includes('back to the base interval'))).toBe(false);
    await teardown(internal);
  }, 60_000);
});

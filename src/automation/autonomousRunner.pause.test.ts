import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import { FactoryPauseStore } from './factoryPause.js';

// AGT-4808: the heartbeat reads the durable pause table on every beat, so a
// pause written by the CLI or the dashboard takes effect with no restart, and
// a runner constructed after the pause (a restarted daemon) sees it too.

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({
  recordTaskOutcome: vi.fn(async () => {}),
  promoteStagedMemories: vi.fn(async () => 0),
}));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));
// Readiness is not under test here: every fetched task is ready.
vi.mock('./definitionOfReady.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./definitionOfReady.js')>(),
  partitionByDefinitionOfReady: async (tasks: unknown[]) => ({ ready: tasks, held: [] }),
}));
const timeWindow = vi.hoisted(() => ({ allowed: true }));
vi.mock('../support/timeWindow.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../support/timeWindow.js')>(),
  checkWorkAllowed: () => (timeWindow.allowed ? { allowed: true } : { allowed: false, reason: 'outside the work window (test)' }),
}));

type InternalRunner = {
  heartbeatParallel: ReturnType<typeof vi.fn>;
  refreshKnowledgeGraphs(): void;
  durableRuns: DurableRunCoordinator;
  executeDurably(task: TaskItem, projectPath: string): Promise<PipelineResult>;
  scheduler: { cancelProjectTasks(path: string): number; cancelTask(id: string): boolean; getRunningTasks(): Array<{ task: TaskItem; projectPath: string }> };
};

describe('heartbeat honours the factory pause (AGT-4808)', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST: work window allowed
    root = mkdtempSync(join(tmpdir(), 'openswarm-runner-pause-'));
    dbPath = join(root, 'automation.db');
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
  });

  afterEach(() => {
    timeWindow.allowed = true;
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
      linearTeamId: 'team', allowedProjects: [root], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true, pairMode: true, maxConcurrentTasks: 4,
      automationLedgerMode: 'primary', automationDbPath: dbPath, minFreeDiskGiB: 0, ...overrides,
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.heartbeatParallel = vi.fn(async () => {});
    return { runner, internal, fetchTasks, execution };
  }

  function heartbeatLines(log: ReturnType<typeof vi.spyOn>): string[] {
    return log.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[HB]'));
  }

  it('a global pause holds dispatch but keeps heartbeat maintenance running, and lifting it resumes (review E)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup();
    await runner.heartbeat();
    expect(fetchTasks).toHaveBeenCalledTimes(1);

    const store = new FactoryPauseStore(dbPath);
    store.set({ actor: 'cli:test', reason: 'incident' });
    await runner.heartbeat();
    await runner.heartbeat();
    // Maintenance (the fetch that feeds merge/tracker/artifact reconciliation) still ran.
    expect(fetchTasks).toHaveBeenCalledTimes(3);
    const pauseLines = heartbeatLines(log).filter((l) => l.includes('⏸ Paused (factory, drain)'));
    expect(pauseLines).toHaveLength(2); // once per heartbeat
    expect(runner.pauses.blocks(root)).toBe(true); // candidate dispatch reads this

    store.clear();
    await runner.heartbeat();
    expect(fetchTasks).toHaveBeenCalledTimes(4);
    expect(runner.pauses.blocks(root)).toBe(false);
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('the dispatch branch is skipped while globally paused, but runs once lifted (review E)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup();
    const runnable = { id: 'AGT-5', issueId: 'AGT-5', issueIdentifier: 'AGT-5', source: 'linear', title: 'T', priority: 2, createdAt: Date.now(), linearState: 'Todo' } as TaskItem;
    const inner = runner as unknown as Record<string, unknown>;
    inner.reconcileStalledInProgress = vi.fn(async (t: TaskItem[]) => t);
    inner.maybeRunBacklogGrooming = vi.fn(async (t: TaskItem[]) => t);
    inner.filterAlreadyProcessed = vi.fn((t: TaskItem[]) => t);
    inner.reconcileDurableArtifacts = vi.fn(async () => {});
    const retrospective = vi.fn(async () => {});
    inner.maybeRunLedgerRetrospective = retrospective;
    fetchTasks.mockResolvedValue([runnable]);
    const store = new FactoryPauseStore(dbPath);
    store.set({ actor: 'cli:test', reason: 'incident' });
    await runner.heartbeat();
    expect(internal.heartbeatParallel).not.toHaveBeenCalled();
    expect(retrospective).toHaveBeenCalledTimes(1);
    expect(heartbeatLines(log).some((l) => l.includes('Dispatch held'))).toBe(true);
    store.clear();
    await runner.heartbeat();
    expect(internal.heartbeatParallel).toHaveBeenCalledTimes(1);
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('a restarted daemon starts paused', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new FactoryPauseStore(dbPath);
    store.set({ actor: 'cli:test' });
    store.close();
    const { runner, internal } = await setup();
    await runner.heartbeat();
    expect(runner.pauses.blocks(root)).toBe(true);
    expect(internal.heartbeatParallel).not.toHaveBeenCalled();
    internal.durableRuns.close();
  }, 60_000);

  it('--now cancels and logs even while the time-window hold returns early (review B)', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup();
    const cancelProject = vi.spyOn(internal.scheduler, 'cancelProjectTasks').mockReturnValue(1);
    timeWindow.allowed = false;
    const store = new FactoryPauseStore(dbPath);
    store.set({ projectPath: root, actor: 'cli:test', mode: 'now', reason: 'stop' });
    await runner.heartbeat();
    expect(cancelProject).toHaveBeenCalledTimes(1);
    expect(heartbeatLines(log).some((l) => l.includes('⏸ Paused') && l.includes('now'))).toBe(true);
    expect(fetchTasks).not.toHaveBeenCalled(); // the hold itself still holds
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('low disk pauses the whole factory through the kill switch with exactly one alert (review 6)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.useRealTimers();
    const { runner, internal, execution } = await setup({ minFreeDiskGiB: 1e9 }); // no volume has a billion GiB free
    const notify = vi.fn(async () => {});
    execution.setNotifier({ notify } as never);
    await runner.heartbeat();
    await runner.heartbeat();
    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([expect.objectContaining({ scope: '*', actor: 'auto:disk', mode: 'drain' })]);
    store.close();
    expect(notify).toHaveBeenCalledTimes(1);
    expect(String((notify.mock.calls[0] as unknown[])[0])).toContain('Auto-paused the factory (disk)');
    internal.durableRuns.close();
  }, 60_000);

  it('a `now` pause aborts a serial-path run, which the scheduler cannot reach (review C)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal } = await setup({ maxConcurrentTasks: 1 });
    const inner = runner as unknown as Record<string, unknown>;
    inner.resolveProjectPath = vi.fn(async () => root);
    const task: TaskItem = {
      id: 'AGT-6', issueId: 'AGT-6', issueIdentifier: 'AGT-6', source: 'linear', title: 'T',
      priority: 2, createdAt: Date.now(), linearState: 'Todo',
    };
    let abortedWith: string | undefined;
    const store = new FactoryPauseStore(dbPath);
    vi.spyOn(internal as unknown as { executeDurably: (t: TaskItem, p: string, s?: AbortSignal) => Promise<PipelineResult> }, 'executeDurably')
      .mockImplementation(async (_t, _p, signal) => {
        store.set({ projectPath: root, actor: 'cli:test', mode: 'now', reason: 'incident' });
        await new Promise<void>((resolve) => signal?.addEventListener('abort', () => { abortedWith = String((signal.reason as Error).message); resolve(); }, { once: true }));
        return { success: false, sessionId: 's', stages: [], finalStatus: 'cancelled', totalDuration: 0, iterations: 0 };
      });
    const running = (inner.executeTaskPairMode as (t: TaskItem) => Promise<void>).call(runner, task).catch(() => {});
    await vi.advanceTimersByTimeAsync(16_000);
    await running;
    expect(abortedWith).toContain('factory paused (now): incident');
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('a run the kill switch cancelled is retried, not cancelled on the tracker (review A)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal } = await setup();
    const task: TaskItem = {
      id: 'AGT-8', issueId: 'AGT-8', issueIdentifier: 'AGT-8', source: 'linear', title: 'T',
      priority: 2, createdAt: Date.now(), linearState: 'Todo',
    };
    let retry: (() => boolean) | undefined;
    vi.spyOn(internal.durableRuns, 'execute').mockImplementation(async (_t, _p, _e, opts) => {
      retry = () => !!opts?.retryCancellation?.({} as never, {} as never);
      return { success: false, sessionId: 's', stages: [], finalStatus: 'cancelled', totalDuration: 0, iterations: 0 };
    });
    await internal.executeDurably(task, root);
    expect(retry!()).toBe(false); // an operator cancel stays a cancel
    vi.spyOn(internal.scheduler, 'getRunningTasks').mockReturnValue([{ task, projectPath: root }]);
    vi.spyOn(internal.scheduler, 'cancelProjectTasks').mockReturnValue(1);
    const store = new FactoryPauseStore(dbPath);
    store.set({ projectPath: root, actor: 'cli:test', mode: 'now' });
    await runner.heartbeat();
    expect(retry!()).toBe(true);
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('--now cancels in-flight runs of the paused project; --drain leaves them running', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal } = await setup();
    const cancelProject = vi.spyOn(internal.scheduler, 'cancelProjectTasks').mockReturnValue(1);
    const store = new FactoryPauseStore(dbPath);

    store.set({ projectPath: root, actor: 'cli:test', mode: 'drain' });
    await runner.heartbeat();
    expect(cancelProject).not.toHaveBeenCalled();

    store.set({ projectPath: root, actor: 'cli:test', mode: 'now' });
    await runner.heartbeat();
    expect(cancelProject).toHaveBeenCalledTimes(1);
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('the heartbeat runs the anomaly monitor and pauses a repository that crossed a threshold (AGT-4809)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useRealTimers();
    const { recordFactorySignal, armAnomalyMonitor } = await import('./anomalyPause.js');
    const { pauseScopeKey } = await import('./factoryPause.js');
    armAnomalyMonitor(dbPath, Date.now() - 60_000);
    recordFactorySignal({ projectPath: pauseScopeKey(root), kind: 'sandbox_network', detail: '1.2.3.4:443\ncurl http://1.2.3.4' }, dbPath);
    const { runner, internal } = await setup();
    await runner.heartbeat();
    const store = new FactoryPauseStore(dbPath);
    expect(store.list()).toEqual([expect.objectContaining({ scope: pauseScopeKey(root), actor: 'auto:sandbox_network' })]);
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('a queued task that starts after the pause is not executed', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { internal } = await setup();
    const store = new FactoryPauseStore(dbPath);
    store.set({ projectPath: root, actor: 'cli:test', reason: 'hold' });
    const execute = vi.spyOn(internal.durableRuns, 'execute');
    const task: TaskItem = {
      id: 'AGT-9', issueId: 'AGT-9', issueIdentifier: 'AGT-9', source: 'linear', title: 'T',
      priority: 2, createdAt: Date.now(), linearState: 'Todo',
    };
    const result = await internal.executeDurably(task, root);
    expect(result.finalStatus).toBe('superseded');
    expect(result.sessionId).toMatch(/^factory-paused-/);
    expect(execute).not.toHaveBeenCalled();
    store.close();
    internal.durableRuns.close();
  }, 60_000);
});

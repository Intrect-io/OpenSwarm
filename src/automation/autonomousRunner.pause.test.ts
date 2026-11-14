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

type InternalRunner = {
  heartbeatParallel: ReturnType<typeof vi.fn>;
  refreshKnowledgeGraphs(): void;
  durableRuns: DurableRunCoordinator;
  executeDurably(task: TaskItem, projectPath: string): Promise<PipelineResult>;
  scheduler: { cancelProjectTasks(path: string): number; cancelTask(id: string): boolean; getRunningTasks(): Array<{ task: TaskItem }> };
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
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function setup() {
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
      automationLedgerMode: 'primary', automationDbPath: dbPath, minFreeDiskGiB: 0,
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.heartbeatParallel = vi.fn(async () => {});
    return { runner, internal, fetchTasks };
  }

  function heartbeatLines(log: ReturnType<typeof vi.spyOn>): string[] {
    return log.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('[HB]'));
  }

  it('a global pause set after start stops the next heartbeat before fetch, and lifting it resumes', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { runner, internal, fetchTasks } = await setup();
    await runner.heartbeat();
    expect(fetchTasks).toHaveBeenCalledTimes(1);

    const store = new FactoryPauseStore(dbPath);
    store.set({ actor: 'cli:test', reason: 'incident' });
    await runner.heartbeat();
    await runner.heartbeat();
    expect(fetchTasks).toHaveBeenCalledTimes(1);
    const pauseLines = heartbeatLines(log).filter((l) => l.includes('⏸ Paused (factory, drain)'));
    expect(pauseLines).toHaveLength(2); // once per heartbeat

    store.clear();
    await runner.heartbeat();
    expect(fetchTasks).toHaveBeenCalledTimes(2);
    store.close();
    internal.durableRuns.close();
  }, 60_000);

  it('a restarted daemon starts paused', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = new FactoryPauseStore(dbPath);
    store.set({ actor: 'cli:test' });
    store.close();
    const { runner, internal, fetchTasks } = await setup();
    await runner.heartbeat();
    expect(fetchTasks).not.toHaveBeenCalled();
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
    const { recordFactorySignal } = await import('./anomalyPause.js');
    const { pauseScopeKey } = await import('./factoryPause.js');
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

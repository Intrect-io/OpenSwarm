import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource, PairCompleteStats } from './taskSource.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { ExecutionDurabilityHooks } from './durableRunCoordinator.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({ recordTaskOutcome: vi.fn(async () => {}) }));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));

type InternalRunner = {
  executePipeline(
    task: TaskItem,
    projectPath: string,
    signal?: AbortSignal,
    durability?: ExecutionDurabilityHooks,
  ): Promise<PipelineResult>;
  executeDurably(task: TaskItem, projectPath: string, signal?: AbortSignal): Promise<PipelineResult>;
  drainDurableOutbox(): Promise<void>;
  durableRuns: DurableRunCoordinator;
  completedTaskIds: Set<string>;
  engine: { heartbeat: ReturnType<typeof vi.fn> };
  refreshKnowledgeGraphs(): void;
  executeTaskPairMode(task: TaskItem): Promise<void>;
  durableRunsClosed: boolean;
  migrateLegacyRunState(tasks: TaskItem[]): Promise<void>;
  filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[];
  resolveProjectPath(task: TaskItem): Promise<string | null>;
  reconcileDurableArtifacts(tasks: TaskItem[]): Promise<void>;
  scheduler: TaskScheduler;
  deferredShutdownCleanup: Promise<void> | null;
};

describe('AutonomousRunner durable completion race', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-22T00:00:00Z'));
    root = mkdtempSync(join(tmpdir(), 'openswarm-runner-durable-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it('reopens the owning durable run with idempotent post-merge conflict evidence', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const updateState = vi.fn(async () => true);
    const addComment = vi.fn(async () => undefined);
    execution.setTaskSource({
      kind: 'linear', fetchTasks: vi.fn(async () => []), updateState, addComment,
      lookupIssueState: vi.fn(async () => ({
        ok: true as const,
        issue: { state: 'Done', stateType: 'completed' },
      })),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(),
      unstick: vi.fn(), logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'integration-conflict.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.durableRuns.importLegacyRun({
      issueId: 'issue-4078', source: 'linear', identifier: 'AGT-4078', title: 'sibling fix',
      projectPath: '/repo', state: 'DONE', branchName: 'swarm/agt-4078',
    });

    await runner.routeIntegrationConflict({
      repo: 'owner/repo', prNumber: 18, branch: 'swarm/agt-4078', issueIdentifier: 'AGT-4078',
      mergedPRNumber: 17, mergedBranch: 'swarm/merged', mergeCommitOid: 'merge-17',
      baseBranch: 'main', baseOid: 'base-new', expectedHeadOid: 'head-old',
      conflictFiles: ['src/shared.ts'],
    });

    expect(internal.durableRuns.getRun('issue-4078')?.state).toBe('READY');
    expect(updateState).toHaveBeenCalledWith('issue-4078', 'Todo');
    expect(addComment).toHaveBeenCalledWith(
      'issue-4078',
      expect.stringContaining('"conflictFiles": [\n    "src/shared.ts"'),
      'integration-conflict:owner/repo#18@merge-17',
    );

    // A tracker outage leaves one atomic local truth: SYNC_PENDING + pending
    // outbox effect. It must never expose READY while Todo/evidence failed.
    internal.durableRuns.importLegacyRun({
      issueId: 'delivery-failed', source: 'linear', identifier: 'AGT-DELIVERY', title: 'delivery failure',
      projectPath: '/repo', state: 'DONE', branchName: 'swarm/delivery-failed',
    });
    updateState.mockResolvedValueOnce(false);
    await runner.routeIntegrationConflict({
      repo: 'owner/repo', prNumber: 20, branch: 'swarm/delivery-failed', issueIdentifier: 'AGT-DELIVERY',
      mergedPRNumber: 17, mergedBranch: 'swarm/merged', mergeCommitOid: 'merge-17',
      baseBranch: 'main', baseOid: 'base-new', expectedHeadOid: 'head-old', conflictFiles: ['src/b.ts'],
    });
    expect(internal.durableRuns.getRun('delivery-failed')?.state).toBe('SYNC_PENDING');

    internal.durableRuns.importLegacyRun({
      issueId: 'cancelled-4078', source: 'linear', identifier: 'AGT-CANCELLED', title: 'cancelled sibling',
      projectPath: '/repo', state: 'CANCELLED', branchName: 'swarm/cancelled',
    });
    await expect(runner.routeIntegrationConflict({
      repo: 'owner/repo', prNumber: 19, branch: 'swarm/cancelled', issueIdentifier: 'AGT-CANCELLED',
      mergedPRNumber: 17, mergedBranch: 'swarm/merged', mergeCommitOid: 'merge-17',
      baseBranch: 'main', baseOid: 'base-new', expectedHeadOid: 'head-old', conflictFiles: ['src/a.ts'],
    })).rejects.toThrow('Refusing to reactivate AGT-CANCELLED from CANCELLED');
    expect(internal.durableRuns.getRun('cancelled-4078')?.state).toBe('CANCELLED');
    expect(updateState).toHaveBeenCalledTimes(2);
    internal.durableRuns.close();
  });

  it('recovers remote comment success before local ack without posting it twice', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const remoteComments: string[] = [];
    const updateState = vi.fn(async () => true);
    const logPairComplete = vi.fn(async (_issueId: string, _sessionId: string, stats: PairCompleteStats) => {
      remoteComments.push(`<!-- openswarm-effect:${stats.idempotencyMarker} -->`);
      throw new Error('process crashed after remote accepted comment');
    });
    const source = {
      kind: 'linear',
      getExecutionComments: vi.fn(async () => remoteComments.map((body) => ({ body, createdAt: new Date().toISOString() }))),
      updateState,
      logPairComplete,
      addComment: vi.fn(async () => {}),
      fetchTasks: vi.fn(async () => []),
      createTask: vi.fn(),
      createSubIssue: vi.fn(),
      logPairStart: vi.fn(),
      logBlocked: vi.fn(),
      logStuck: vi.fn(),
      unstick: vi.fn(),
      logHalt: vi.fn(),
      markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource;
    execution.setTaskSource(source);

    const runner = new AutonomousRunner({
      linearTeamId: 'team',
      allowedProjects: ['/repo'],
      heartbeatSchedule: '0 * * * *',
      autoExecute: true,
      maxConsecutiveTasks: 1,
      cooldownSeconds: 0,
      dryRun: true,
      pairMode: true,
      automationLedgerMode: 'primary',
      automationDbPath: join(root, 'automation.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.executePipeline = vi.fn(async () => ({
      success: true,
      sessionId: 'session-1',
      stages: [],
      finalStatus: 'approved',
      totalDuration: 1_000,
      iterations: 1,
    }));
    const task: TaskItem = {
      id: 'issue-1', issueId: 'issue-1', issueIdentifier: 'INT-1',
      source: 'linear', title: 'durable task', priority: 2, createdAt: Date.now(),
      linearState: 'Todo',
    };

    expect((await internal.executeDurably(task, '/repo')).success).toBe(true);
    expect(internal.durableRuns.getRun('issue-1')?.state).toBe('SYNC_PENDING');

    await internal.drainDurableOutbox();
    expect(logPairComplete).toHaveBeenCalledTimes(1);
    expect(internal.durableRuns.getRun('issue-1')?.state).toBe('SYNC_PENDING');

    // Retry backoff expires. Reconciler sees the marker, reapplies only the
    // idempotent Done state, and acknowledges the same outbox row.
    vi.advanceTimersByTime(11_000);
    await internal.drainDurableOutbox();
    expect(logPairComplete).toHaveBeenCalledTimes(1);
    expect(updateState).toHaveBeenCalledWith('issue-1', 'Done');
    expect(remoteComments).toHaveLength(1);
    expect(internal.durableRuns.getRun('issue-1')?.state).toBe('DONE');
    expect(internal.completedTaskIds.has('issue-1')).toBe(true);

    internal.durableRuns.close();
  });

  it('does not reinterpret a failed cancellation sync as an operator Todo reopen', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const updateState = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const addComment = vi.fn(async () => {});
    execution.setTaskSource({
      kind: 'linear',
      fetchTasks: vi.fn(async () => []),
      updateState,
      addComment,
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(),
      unstick: vi.fn(), logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);

    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'cancel-race.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.executePipeline = vi.fn(async () => ({
      success: false,
      sessionId: 'cancel-session',
      stages: [],
      finalStatus: 'cancelled',
      totalDuration: 100,
      iterations: 1,
    }));
    const cancelledTask: TaskItem = {
      id: 'cancel-issue', issueId: 'cancel-issue', issueIdentifier: 'INT-CANCEL',
      source: 'linear', title: 'cancel safely', priority: 2, createdAt: Date.now(),
      linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
    };

    expect((await internal.executeDurably(cancelledTask, '/repo')).finalStatus).toBe('cancelled');
    expect(internal.durableRuns.getRun('cancel-issue')?.state).toBe('SYNC_PENDING');

    await internal.drainDurableOutbox();
    expect(updateState).toHaveBeenCalledTimes(1);
    expect(addComment).not.toHaveBeenCalled();
    expect(internal.durableRuns.getRun('cancel-issue')?.state).toBe('SYNC_PENDING');
    expect(internal.filterAlreadyProcessed([cancelledTask])).toEqual([]);

    vi.advanceTimersByTime(11_000);
    await internal.drainDurableOutbox();
    expect(updateState).toHaveBeenCalledTimes(2);
    expect(addComment).toHaveBeenCalledTimes(1);
    expect(addComment).toHaveBeenCalledWith(
      'cancel-issue',
      expect.stringContaining('<!-- openswarm-effect:cancel:cancel-issue:attempt:1 -->'),
      'cancel:cancel-issue:attempt:1',
    );
    expect(internal.durableRuns.getRun('cancel-issue')?.state).toBe('CANCELLED');
    internal.durableRuns.close();
  });

  it('fences a heartbeat that finishes fetching while shutdown is in progress', async () => {
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST: work window allowed
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    let releaseFetch!: (tasks: TaskItem[]) => void;
    let signalFetchStarted!: () => void;
    const fetchStarted = new Promise<void>((resolve) => { signalFetchStarted = resolve; });
    const source = {
      kind: 'linear',
      fetchTasks: vi.fn(() => {
        signalFetchStarted();
        return new Promise<TaskItem[]>((resolve) => { releaseFetch = resolve; });
      }),
      updateState: vi.fn(async () => true),
      addComment: vi.fn(async () => {}),
      createTask: vi.fn(),
      createSubIssue: vi.fn(),
      logPairStart: vi.fn(),
      logPairComplete: vi.fn(),
      logBlocked: vi.fn(),
      logStuck: vi.fn(),
      unstick: vi.fn(),
      logHalt: vi.fn(),
      markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource;
    execution.setTaskSource(source);

    const runner = new AutonomousRunner({
      linearTeamId: 'team',
      allowedProjects: ['/repo'],
      heartbeatSchedule: '0 * * * *',
      autoExecute: true,
      maxConsecutiveTasks: 1,
      cooldownSeconds: 0,
      dryRun: true,
      pairMode: true,
      shutdownGraceMs: 1_000,
      automationLedgerMode: 'primary',
      automationDbPath: join(root, 'shutdown-race.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.engine.heartbeat = vi.fn(async () => ({ action: 'execute', reason: 'ready' }));
    internal.executeTaskPairMode = vi.fn(async () => {});

    const heartbeat = runner.heartbeat();
    await fetchStarted;
    const firstStop = runner.stop();
    const secondStop = runner.stop();
    expect(secondStop).toBe(firstStop);

    releaseFetch([{
      id: 'late-task', issueId: 'late-task', issueIdentifier: 'INT-LATE',
      source: 'linear', title: 'must not start after stop', priority: 2,
      createdAt: Date.now(), linearState: 'Todo',
    }]);

    await Promise.all([heartbeat, firstStop]);
    expect(internal.engine.heartbeat).not.toHaveBeenCalled();
    expect(internal.executeTaskPairMode).not.toHaveBeenCalled();
    expect(internal.durableRunsClosed).toBe(true);
  });

  it('lazily imports ambiguous legacy completion and then stops using JSON as authority', async () => {
    writeFileSync(join(root, 'runner-state.json'), JSON.stringify({
      completed: ['legacy-issue'], failed: {}, retryTimes: {}, lastFailures: {},
    }));
    const [{ AutonomousRunner }] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'legacy-import.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.resolveProjectPath = vi.fn(async () => '/repo');
    const legacyTask: TaskItem = {
      id: 'legacy-issue', issueId: 'legacy-issue', issueIdentifier: 'INT-LEGACY',
      source: 'linear', title: 'legacy completion', priority: 2, createdAt: Date.now(),
      linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
    };

    await internal.migrateLegacyRunState([legacyTask]);
    expect(internal.durableRuns.getRun('legacy-issue')).toMatchObject({ state: 'NEEDS_RECONCILE' });
    expect(internal.filterAlreadyProcessed([legacyTask])).toEqual([]);

    expect(internal.durableRuns.markReady('legacy-issue')).toBe(true);
    expect(internal.filterAlreadyProcessed([legacyTask])).toEqual([legacyTask]);
    internal.durableRuns.close();
  });

  it('resumes durable NEEDS_HUMAN when an operator moves a stuck issue to Todo', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const unstick = vi.fn(async () => {});
    execution.setTaskSource({
      kind: 'linear', fetchTasks: vi.fn(async () => []), getExecutionComments: vi.fn(async () => []),
      updateState: vi.fn(async () => true), addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(), unstick,
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'stuck-recovery.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.durableRuns.importLegacyRun({
      issueId: 'stuck-issue', source: 'linear', identifier: 'INT-STUCK', title: 'retry me',
      projectPath: '/repo', state: 'NEEDS_HUMAN',
    });
    const task: TaskItem = {
      id: 'stuck-issue', issueId: 'stuck-issue', issueIdentifier: 'INT-STUCK', source: 'linear',
      title: 'retry me', priority: 2, createdAt: Date.now(), linearState: 'Todo',
      labels: ['swarm:stuck'], linearProject: { id: 'project', name: 'Repo' },
    };

    expect(internal.filterAlreadyProcessed([task])).toEqual([task]);
    expect(internal.durableRuns.getRun('stuck-issue')).toMatchObject({ state: 'READY' });
    await Promise.resolve();
    expect(unstick).toHaveBeenCalledWith('stuck-issue');
    internal.durableRuns.close();
  });

  it('recovers a PR published before process death without rerunning the pipeline', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const bin = join(root, 'bin');
    const repo = join(root, 'repo');
    mkdirSync(bin, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --head"*) echo '[{"url":"https://github.com/acme/repo/pull/91","state":"OPEN","isDraft":false,"headRefOid":"abc91"}]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const logPairComplete = vi.fn(async () => {});
    execution.setTaskSource({
      kind: 'linear',
      fetchTasks: vi.fn(async () => []),
      getExecutionComments: vi.fn(async () => []),
      updateState: vi.fn(async () => true),
      addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete, logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'pr-recovery.db'),
    });
    const internal = runner as unknown as InternalRunner;
    const publishedTask: TaskItem = {
      id: 'published', issueId: 'published', issueIdentifier: 'INT-91', source: 'linear',
      title: 'published before crash', priority: 2, createdAt: Date.now(), linearState: 'In Progress',
      linearProject: { id: 'project', name: 'Repo' },
    };
    internal.durableRuns.importLegacyRun({
      issueId: 'published', source: 'linear', identifier: 'INT-91', title: publishedTask.title,
      projectPath: repo, state: 'NEEDS_RECONCILE', branchName: 'swarm/INT-91',
    });
    internal.executePipeline = vi.fn(async () => resultFixture());

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await internal.reconcileDurableArtifacts([publishedTask]);
    } finally {
      process.env.PATH = previousPath;
    }
    expect(internal.executePipeline).not.toHaveBeenCalled();
    expect(logPairComplete).toHaveBeenCalledTimes(1);
    expect(internal.durableRuns.getRun('published')).toMatchObject({
      state: 'DONE', prUrl: 'https://github.com/acme/repo/pull/91', headSha: 'abc91',
    });
    internal.durableRuns.close();
  });

  // AGT-4094: the heartbeat fetch asks Linear only for Todo / In Progress /
  // In Review / Backlog, so a run whose card reached Done is structurally
  // absent from `tasks`. Reconciliation used to skip such a row before it ever
  // reached the GitHub lookup, leaving it in NEEDS_RECONCILE forever — and
  // NEEDS_RECONCILE counts toward the per-project admission cap, so the slot
  // leaked permanently. Production case: AX-876, merged PR, 11.9h stuck.
  it('reconciles a published run whose tracker card already went terminal, so its admission slot is returned', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const { updateProjectAfterTask } = await import('../linear/projectUpdater.js');
    const bin = join(root, 'terminal-bin');
    const repo = join(root, 'terminal-repo');
    mkdirSync(bin, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --head"*) echo '[{"url":"https://github.com/acme/repo/pull/171","state":"MERGED","isDraft":false,"headRefOid":"abc171"}]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const logPairComplete = vi.fn(async () => {});
    execution.setTaskSource({
      kind: 'linear',
      fetchTasks: vi.fn(async () => []),
      getExecutionComments: vi.fn(async () => []),
      updateState: vi.fn(async () => true),
      addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete, logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'terminal-card.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.durableRuns.importLegacyRun({
      issueId: 'terminal', source: 'linear', identifier: 'AX-876', title: 'account master',
      projectPath: repo, state: 'NEEDS_RECONCILE', branchName: 'swarm/AX-876-a2-3',
      metadata: { projectId: 'cgf', projectName: 'CGF-Portal' },
    });
    internal.executePipeline = vi.fn(async () => resultFixture());

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      // The decisive argument: an empty task list, exactly what a Done card
      // produces. Before the fix this left the row untouched and unlogged.
      await internal.reconcileDurableArtifacts([]);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(internal.executePipeline).not.toHaveBeenCalled();
    expect(internal.durableRuns.getRun('terminal')).toMatchObject({
      state: 'DONE', prUrl: 'https://github.com/acme/repo/pull/171', headSha: 'abc171',
    });
    // The completion effect carried a task rebuilt from the durable row, not a
    // live one — identifier, title and project all came back off the record.
    expect(logPairComplete).toHaveBeenCalledTimes(1);
    expect(updateProjectAfterTask).toHaveBeenCalledWith('cgf', 'CGF-Portal', expect.objectContaining({
      title: 'account master',
      issueIdentifier: 'AX-876',
      success: true,
    }));
    internal.durableRuns.close();
  });

  // The other half of AGT-4094: absence stays ambiguous wherever it still
  // matters. With no PR the only exit is to re-run the work, and re-running a
  // task whose card cannot be seen is exactly what the original guard existed
  // to prevent — AGT-4056 narrowed its own fix on this assumption, so it has
  // to keep holding.
  it('leaves an unpublished run parked when its task is absent, rather than reopening work it cannot see', async () => {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const bin = join(root, 'unpublished-bin');
    const repo = join(root, 'unpublished-repo');
    mkdirSync(bin, { recursive: true });
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(bin, 'gh'), `#!/bin/sh
case "$*" in
  *"pr list --head"*) echo '[]';;
esac
`);
    chmodSync(join(bin, 'gh'), 0o755);
    const logPairComplete = vi.fn(async () => {});
    execution.setTaskSource({
      kind: 'linear',
      fetchTasks: vi.fn(async () => []),
      getExecutionComments: vi.fn(async () => []),
      updateState: vi.fn(async () => true),
      addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete, logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'unpublished.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.durableRuns.importLegacyRun({
      issueId: 'unpublished', source: 'linear', identifier: 'AX-999', title: 'never pushed',
      projectPath: repo, state: 'NEEDS_RECONCILE', branchName: 'swarm/AX-999',
    });

    const previousPath = process.env.PATH;
    process.env.PATH = `${bin}:${previousPath}`;
    try {
      await internal.reconcileDurableArtifacts([]);
    } finally {
      process.env.PATH = previousPath;
    }

    expect(internal.durableRuns.getRun('unpublished')).toMatchObject({ state: 'NEEDS_RECONCILE' });
    expect(logPairComplete).not.toHaveBeenCalled();
    internal.durableRuns.close();
  });

  it('reconciles a stale Done tracker row even when the slim heartbeat fetch is empty', async () => {
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST: work window allowed
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const source = {
      kind: 'linear',
      fetchTasks: vi.fn(async () => []),
      lookupIssueState: vi.fn(async () => ({
        ok: true as const,
        issue: { state: 'Done', stateType: 'completed' },
      })),
      updateState: vi.fn(async () => true), addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource;
    execution.setTaskSource(source);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'terminal-lookup.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    const now = Date.now();
    internal.durableRuns.importLegacyRun({
      issueId: 'stale-done', source: 'linear', identifier: 'AX-856', title: 'done upstream',
      projectPath: '/repo', state: 'RETRY_AT', retryAt: now - 2 * 60 * 60_000,
    }, now - 2 * 60 * 60_000);

    await runner.heartbeat();

    expect(source.fetchTasks).toHaveBeenCalledTimes(1);
    expect(source.lookupIssueState).toHaveBeenCalledWith('AX-856');
    expect(internal.durableRuns.listRuns()).toHaveLength(1);
    expect(internal.durableRuns.getRun('stale-done')).toMatchObject({
      state: 'DONE', trackerState: 'Done', trackerStateType: 'completed',
    });
    internal.durableRuns.close();
  });

  it('returns at the shutdown deadline but defers ledger close until an abort-ignoring executor exits', async () => {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      shutdownGraceMs: 0, automationLedgerMode: 'primary',
      automationDbPath: join(root, 'hung-shutdown.db'),
    });
    const internal = runner as unknown as InternalRunner;
    let release!: (result: PipelineResult) => void;
    const held = new Promise<PipelineResult>((resolve) => { release = resolve; });
    const hungTask: TaskItem = {
      id: 'hung', issueId: 'hung', source: 'linear', title: 'hung executor',
      priority: 2, createdAt: Date.now(),
    };
    expect(internal.scheduler.startTask(hungTask, '/repo', async () => held)).toBe(true);

    await runner.stop();
    expect(internal.scheduler.getUnsettledExecutorCount()).toBe(1);
    expect(internal.durableRunsClosed).toBe(false);
    const deferredCleanup = internal.deferredShutdownCleanup;
    expect(deferredCleanup).not.toBeNull();

    release({
      success: false, sessionId: 'hung', stages: [], finalStatus: 'cancelled',
      totalDuration: 1, iterations: 0,
    });
    await internal.scheduler.waitForExecutorExit();
    await deferredCleanup;
    expect(internal.durableRunsClosed).toBe(true);
  });
});

function resultFixture(): PipelineResult {
  return {
    success: true, sessionId: 'unused', stages: [], finalStatus: 'approved',
    totalDuration: 0, iterations: 1,
  };
}

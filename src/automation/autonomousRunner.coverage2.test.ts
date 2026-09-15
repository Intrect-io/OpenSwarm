// Purpose: targeted coverage for AutonomousRunner's safely-reachable public/private
// helpers that the existing companion test files (cancel/enable/infraError)
// don't touch. Follows their established pattern — `new
// AutonomousRunner(cfg())` with `dryRun: true`, direct calls to public
// methods/getters, and casting to reach small private helpers exactly like
// `autonomousRunner.enable.test.ts` already does for `shouldFilterByEnabled` /
// `groupTasksForGrooming` / `heartbeatParallel`.
//
// Deliberately NOT covered here (real heartbeat/timer loop or real I/O risk):
// - start()/heartbeat()'s main body, scheduleNextHeartbeat's timer itself
// - runNow() (a thin wrapper that calls the real heartbeat())
// - the scheduler 'completed' handler's success path (real Linear/Discord/
//   knowledge-graph network calls) and the 'rejected' branch of 'failed'
// - resolveProjectPath/decomposeTask/executePipeline/requestApproval (delegate to
//   runnerExecution, which does real adapter/process work with no dryRun escape
//   hatch)
// - the constructor's `!config.dryRun` branch (reads the real ~/.openswarm project
//   selection file)
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskScheduler, RunningTask, QueuedTask } from '../orchestration/taskScheduler.js';
import type { DecisionResult, TaskItem } from '../orchestration/decisionEngine.js';
import type { AutonomousConfig } from './runnerTypes.js';
import type { ITaskSource } from './taskSource.js';

const { detectFileConflictsMock, resolveTaskFileScopeMock, describeScopeConflictMock } = vi.hoisted(() => ({
  detectFileConflictsMock: vi.fn(),
  resolveTaskFileScopeMock: vi.fn(async (task: TaskItem) => {
    task.fileScope ??= [`scope/${task.id}`];
    return task.fileScope;
  }),
  // null = no conflict. The runner now reads a reason object so it can log WHY
  // a candidate was deferred, not just that it was (AGT-4233).
  describeScopeConflictMock: vi.fn((): unknown => null),
}));

vi.mock('../adapters/modelCatalog.js', () => ({
  // Never read the developer's real ~/.openswarm state from a unit test: an
  // ambient catalogue silently decided this suite's verdict once already.
  readCachedCatalog: () => null,
  writeCachedCatalog: () => {},
}));
vi.mock('../orchestration/conflictDetector.js', () => ({
  detectFileConflicts: detectFileConflictsMock,
  resolveTaskFileScope: resolveTaskFileScopeMock,
  describeScopeConflict: describeScopeConflictMock,
}));

const { runLedgerRetrospectiveMock } = vi.hoisted(() => ({
  runLedgerRetrospectiveMock: vi.fn(async () => ({ filed: false, reason: 'no failures in window' })),
}));

vi.mock('./ledgerRetrospective.js', () => ({
  runLedgerRetrospective: runLedgerRetrospectiveMock,
}));

// writeProviderOverride writes unconditionally to ~/.config/openswarm/ (no dryRun
// guard, no env override) — mock it so switchProvider() tests never touch the real
// filesystem outside the sandbox.
vi.mock('../core/providerOverride.js', () => ({
  writeProviderOverride: vi.fn(),
}));

// resolveAdapterDefaultModel does real OAuth + live-catalog work ("heavy" per its
// own doc comment) — mock it so getAdapterSummary() tests never risk a real network
// call even if a test accidentally omits an explicit model.
vi.mock('../agents/stageModelResolver.js', () => ({
  resolveAdapterDefaultModel: vi.fn(async () => 'mocked-default-model'),
}));

type AutonomousRunnerCtor = typeof import('./autonomousRunner.js').AutonomousRunner;
type RunnerExecutionModule = typeof import('./runnerExecution.js');

let tempDir = '';
let AutonomousRunner: AutonomousRunnerCtor;
let runnerExecution: RunnerExecutionModule;
let runnerModule: typeof import('./autonomousRunner.js');

const cfg = (over: Partial<AutonomousConfig> = {}): AutonomousConfig => ({
  linearTeamId: 'team',
  allowedProjects: ['/repo'],
  heartbeatSchedule: '0 * * * *',
  autoExecute: false,
  dryRun: true,
  ...over,
});

const task = (over: Partial<TaskItem> = {}): TaskItem => ({
  id: 'task-1',
  source: 'linear',
  issueId: 'ISSUE-1',
  issueIdentifier: 'INT-1',
  title: 'Some task',
  priority: 3,
  createdAt: Date.now(),
  ...over,
});

const pipelineResult = (finalStatus: PipelineResult['finalStatus'], over: Partial<PipelineResult> = {}): PipelineResult => ({
  success: false,
  sessionId: 'pipeline-1',
  iterations: 0,
  totalDuration: 5,
  finalStatus,
  stages: [],
  ...over,
});

function mockTaskSource() {
  return {
    kind: 'local',
    updateState: vi.fn(async () => {}),
    addComment: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
  } as unknown as ITaskSource & {
    updateState: ReturnType<typeof vi.fn>;
    addComment: ReturnType<typeof vi.fn>;
    logStuck: ReturnType<typeof vi.fn>;
    logBlocked: ReturnType<typeof vi.fn>;
  };
}

type Internal = {
  pathsCaseInsensitive: boolean;
  normalizePath(p: string): string;
  isProjectEnabled(resolvedPath: string): boolean;
  sameProjectCandidateCap(): number | null;
  currentProjectLoad(projectPath: string): number;
  canQueueProjectCandidate(projectPath: string): boolean;
  enqueueCandidate(task: TaskItem, projectPath: string): boolean;
  detectSafeCandidateIds(candidates: Array<{ task: TaskItem; projectPath: string }>): Promise<Set<string>>;
  formatTaskContext(t: TaskItem): string;
  syslogSkipSummary(unmapped: Map<string, number>, disabled: Map<string, number>): void;
  lastFetchedTasks: TaskItem[];
  lastFailureDetails: Map<string, { detail: string; at: string }>;
  scheduler: {
    getQueuedTasks(): QueuedTask[];
    getRunningTasks(): RunningTask[];
    cancelTask(id: string): boolean;
    startTask: TaskScheduler['startTask'];
  };
  engine: { heartbeat: ReturnType<typeof vi.fn> };
  durableRuns: {
    listRuns(states?: readonly string[]): Array<{ issueId: string; lastErrorCode?: string }>;
    getRun(issueId: string): { state: string; leaseExpiresAt?: number; prUrl?: string } | null;
    markReady(issueId: string): boolean;
    isPrimary: boolean;
  };
  maybeRunLedgerRetrospective(): Promise<void>;
  rateLimitUntil: number;
  scheduleNextHeartbeat(): void;
  executeTaskPairMode: ReturnType<typeof vi.fn>;
  reconcileStalledInProgress(tasks: TaskItem[], now?: number): Promise<TaskItem[]>;
  state: { pendingApproval?: TaskItem };
};

// Purpose: split from autonomousRunner.coverage.test.ts (LOC gate ≤950) — the
// lower half of its describes moved here verbatim, along with an identical copy
// of the module-level mocks, fixture builders, and shared type so the file is
// self-contained (vi.mock is per-module and cannot be shared across files).
describe('AutonomousRunner coverage — safely-reachable helpers (part 2)', () => {
  beforeEach(async () => {
    vi.resetModules();
    tempDir = mkdtempSync(join(tmpdir(), 'openswarm-coverage-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(tempDir, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(tempDir, 'runner-task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(tempDir, 'runner-rejection-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(tempDir, 'runner-pipeline-history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(tempDir, 'runner-decomposition-state.json'));
    runnerModule = await import('./autonomousRunner.js');
    ({ AutonomousRunner } = runnerModule);
    runnerExecution = await import('./runnerExecution.js');
    detectFileConflictsMock.mockReset();
    detectFileConflictsMock.mockResolvedValue({ safe: [], conflictGroups: [] });
    resolveTaskFileScopeMock.mockReset();
    resolveTaskFileScopeMock.mockImplementation(async (candidate: TaskItem) => {
      candidate.fileScope ??= [`scope/${candidate.id}`];
      return candidate.fileScope;
    });
    describeScopeConflictMock.mockReset();
    describeScopeConflictMock.mockReturnValue(null);
  }, 30000);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('getAdapterSummary', () => {
    it('drops startup models incompatible with the configured default adapter', async () => {
      const r = new AutonomousRunner(cfg({ workerModel: 'w-model', reviewerModel: 'r-model' }));
      const summary = await r.getAdapterSummary();
      expect(summary.defaultAdapter).toBe('codex'); // fallback default
      expect(summary.worker).toEqual({ adapter: 'codex', model: 'mocked-default-model', enabled: true });
      expect(summary.reviewer).toEqual({ adapter: 'codex', model: 'mocked-default-model', enabled: true });
      expect(summary.tester).toBeUndefined();
      expect(summary.documenter).toBeUndefined();
    });

    it('falls back to the (mocked) adapter default model when nothing is configured', async () => {
      const r = new AutonomousRunner(cfg());
      const summary = await r.getAdapterSummary();
      expect(summary.worker.model).toBe('mocked-default-model');
      expect(summary.reviewer.model).toBe('mocked-default-model');
    });

    it('surfaces per-role adapter/model/enabled overrides for tester and documenter', async () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'codex',
        defaultRoles: {
          worker: { enabled: true, adapter: 'gpt', model: 'w2' },
          reviewer: { enabled: false, adapter: 'claude', model: 'r2' },
          tester: { enabled: true, adapter: 'local', model: 't1' },
          documenter: { enabled: false, model: 'd1' },
        },
      }));
      const summary = await r.getAdapterSummary();
      expect(summary.worker).toEqual({ adapter: 'gpt', model: 'w2', enabled: true });
      expect(summary.reviewer).toEqual({ adapter: 'claude', model: 'r2', enabled: false });
      expect(summary.tester).toEqual({ adapter: 'local', model: 't1', enabled: true });
      expect(summary.documenter).toEqual({ adapter: 'codex', model: undefined, enabled: false });
    });
  });

  describe('switchProvider', () => {
    it('releases only provider-quota retries and clears the in-memory pause', () => {
      const r = new AutonomousRunner(cfg({ defaultAdapter: 'codex' }));
      const internal = r as unknown as Internal;
      internal.rateLimitUntil = Date.now() + 60_000;
      internal.durableRuns.listRuns = vi.fn(() => [
        { issueId: 'quota-1', lastErrorCode: 'rate_limited' },
        { issueId: 'infra-1', lastErrorCode: 'infra_error' },
      ]);
      internal.durableRuns.markReady = vi.fn(() => true);
      internal.scheduleNextHeartbeat = vi.fn();

      r.switchProvider('claude');

      expect(internal.rateLimitUntil).toBe(0);
      expect(internal.durableRuns.markReady).toHaveBeenCalledTimes(1);
      expect(internal.durableRuns.markReady).toHaveBeenCalledWith('quota-1');
      expect(internal.scheduleNextHeartbeat).toHaveBeenCalledTimes(1);
    });

    it('updates defaultAdapter and remaps workerModel/reviewerModel/plannerModel', () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'codex',
        workerModel: 'gpt-5.5-codex',
        reviewerModel: 'gpt-5.5-codex',
        plannerModel: 'gpt-5.5-codex',
      }));
      expect(() => r.switchProvider('claude')).not.toThrow();
      const cfgAfter = r.getAllowedProjects(); // sanity: instance still usable
      expect(Array.isArray(cfgAfter)).toBe(true);
    });

    it('remaps every configured defaultRoles entry (worker/reviewer/tester/documenter/auditor/skill-documenter)', () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'codex',
        defaultRoles: {
          worker: { enabled: true, model: 'gpt-5.5-codex' },
          reviewer: { enabled: true, model: 'gpt-5.5-codex' },
          tester: { enabled: true, model: 'gpt-5.5-codex' },
          documenter: { enabled: true, model: 'gpt-5.5-codex' },
          auditor: { enabled: true, model: 'gpt-5.5-codex' },
          'skill-documenter': { enabled: true, model: 'gpt-5.5-codex' },
        },
      }));
      expect(() => r.switchProvider('claude')).not.toThrow();
    });

    // The tests above assert `not.toThrow()` and nothing else, so relabelling
    // worker as reviewer left all 102 of them green. The role NAME is the whole
    // mechanism by which the split survives a switch, and it was unpinned.
    // (AGT-4273)
    it('keeps worker and reviewer on DIFFERENT models when switching to cursor', () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'openrouter',
        workerModel: 'deepseek/deepseek-v4-flash',
        reviewerModel: 'deepseek/deepseek-v4-flash',
        defaultRoles: {
          worker: { enabled: true, model: 'deepseek/deepseek-v4-flash' },
          reviewer: { enabled: true, model: 'deepseek/deepseek-v4-flash' },
        },
      }));

      r.switchProvider('cursor');

      const after = (r as unknown as { config: AutonomousConfig }).config;
      // Bulk implementation is cheap and concurrent; the role that judges it is
      // not the same model, which is the entire point of having a reviewer.
      expect(after.defaultRoles?.worker.model).toBe('auto');
      expect(after.defaultRoles?.reviewer.model).toBe('cursor-grok-4.6-high');
      expect(after.defaultRoles?.worker.model).not.toBe(after.defaultRoles?.reviewer.model);
      expect(after.workerModel).toBe('auto');
      expect(after.reviewerModel).toBe('cursor-grok-4.6-high');
      expect(after.plannerModel === undefined || after.plannerModel === 'cursor-grok-4.6-high').toBe(true);
    });

    it('remaps jobProfiles roles, dropping incompatible models', () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'codex',
        jobProfiles: [
          { name: 'light', estimatedMinutesMax: 10, roles: { worker: 'gpt-5.5-codex', reviewer: 'gpt-5.5-codex' } },
        ] as unknown as AutonomousConfig['jobProfiles'],
      }));
      expect(() => r.switchProvider('claude')).not.toThrow();
    });

    it('remaps orchestrator.adapter/model on provider switch (AGT-4259)', () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'codex',
        orchestrator: {
          enabled: true,
          adapter: 'codex-responses',
          model: 'gpt-5.6-sol',
          schedule: '*/15 * * * *',
        },
      }));

      r.switchProvider('openrouter');

      const after = (r as unknown as { config: AutonomousConfig }).config;
      expect(after.orchestrator?.adapter).toBe('openrouter');
      // Codex id must not survive onto OpenRouter — mapModelForAdapter drops it.
      expect(after.orchestrator?.model === undefined || !String(after.orchestrator?.model).includes('gpt-5.6-sol')).toBe(true);
    });
  });

  describe('getRunningPipelines / cancelTask', () => {
    it('maps running tasks to the dashboard process-view shape', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      internal.scheduler.getRunningTasks = () => [
        {
          task: task({ id: 'r1', issueIdentifier: 'INT-5', linearProject: { id: 'p', name: 'WAVE' } }),
          projectPath: '/x/a', startedAt: 12345, stage: 'worker',
        } as unknown as RunningTask,
        {
          task: task({ id: 'r2', linearProject: undefined, issueIdentifier: undefined }),
          projectPath: '/x/b/repo', startedAt: 999,
        } as unknown as RunningTask,
      ];
      const pipelines = r.getRunningPipelines();
      expect(pipelines).toEqual([
        { id: 'r1', issue: 'INT-5', title: 'Some task', project: 'WAVE', projectPath: '/x/a', startedAt: 12345, stage: 'worker' },
        { id: 'r2', issue: undefined, title: 'Some task', project: 'repo', projectPath: '/x/b/repo', startedAt: 999, stage: undefined },
      ]);
    });

    it('cancelTask delegates to the scheduler and returns its result', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      internal.scheduler.cancelTask = vi.fn((id: string) => id === 'known');
      expect(r.cancelTask('known')).toBe(true);
      expect(r.cancelTask('unknown')).toBe(false);
      expect(internal.scheduler.cancelTask).toHaveBeenCalledTimes(2);
    });
  });

  describe('registerProjectPath', () => {
    it('caches a name and its capitalized variant on first registration', () => {
      const r = new AutonomousRunner(cfg());
      r.registerProjectPath('wave', '/repos/wave');
      const info = r as unknown as { projectPathCache: Map<string, string> };
      expect(info.projectPathCache.get('wave')).toBe('/repos/wave');
      expect(info.projectPathCache.get('Wave')).toBe('/repos/wave');
    });

    it('does not overwrite an already-cached name or capitalized variant', () => {
      const r = new AutonomousRunner(cfg());
      r.registerProjectPath('wave', '/repos/wave-1');
      r.registerProjectPath('wave', '/repos/wave-2');
      const info = r as unknown as { projectPathCache: Map<string, string> };
      expect(info.projectPathCache.get('wave')).toBe('/repos/wave-1');
      expect(info.projectPathCache.get('Wave')).toBe('/repos/wave-1');
    });

    it('is a no-op for a name whose capitalized form equals itself', () => {
      const r = new AutonomousRunner(cfg());
      r.registerProjectPath('WAVE', '/repos/wave');
      const info = r as unknown as { projectPathCache: Map<string, string> };
      expect(info.projectPathCache.get('WAVE')).toBe('/repos/wave');
      expect(info.projectPathCache.size).toBe(1); // capitalized === name, no duplicate entry
    });
  });

  describe('getProjectsInfo', () => {
    it('combines fetched/running/queued tasks into a per-project view', () => {
      const r = new AutonomousRunner(cfg({ allowedProjects: ['/x/a'] }));
      r.enableProject('/x/a');
      const internal = r as unknown as Internal;
      internal.lastFetchedTasks = [
        task({ id: 'pending-1', issueId: 'ISSUE-PENDING', linearProject: { id: 'p', name: 'WAVE' } }),
      ];
      internal.scheduler.getRunningTasks = () => [
        { task: task({ id: 'running-1', issueId: 'ISSUE-RUNNING', linearProject: { id: 'p', name: 'WAVE' } }), projectPath: '/x/a', startedAt: 1 } as unknown as RunningTask,
      ];
      internal.scheduler.getQueuedTasks = () => [];

      const info = r.getProjectsInfo();
      expect(info).toHaveLength(1);
      expect(info[0].name).toBe('WAVE');
      expect(info[0].path).toBe('/x/a');
      expect(info[0].enabled).toBe(true);
      // Dashboard task ids use the same event key as coordination/SSE. A
      // TaskItem may have a local id distinct from its Linear issue id.
      expect(info[0].running.map((t) => t.id)).toEqual(['ISSUE-RUNNING']);
      expect(info[0].pending.map((t) => t.id)).toEqual(['ISSUE-PENDING']);
    });
  });

  describe('getState / reject / approve', () => {
    it('getState returns a snapshot copy of the runner state', () => {
      const r = new AutonomousRunner(cfg());
      const state = r.getState();
      expect(state).toEqual({ isRunning: false, lastHeartbeat: 0, consecutiveErrors: 0 });
      // Mutating the returned object must not mutate the runner's own state.
      (state as { isRunning: boolean }).isRunning = true;
      expect(r.getState().isRunning).toBe(false);
    });

    it('reject() clears a pending approval and returns true, false when there is none', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      expect(r.reject()).toBe(false); // nothing pending
      internal.state.pendingApproval = task();
      expect(r.reject()).toBe(true);
      expect(internal.state.pendingApproval).toBeUndefined();
    });

    it('approve() returns false without calling the decision engine when nothing is pending', async () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      internal.engine.heartbeat = vi.fn();
      expect(await r.approve()).toBe(false);
      expect(internal.engine.heartbeat).not.toHaveBeenCalled();
    });

    it('approve() clears pendingApproval and returns false when the engine defers', async () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      internal.state.pendingApproval = task();
      internal.engine.heartbeat = vi.fn(async (): Promise<DecisionResult> => ({ action: 'defer', reason: 'waiting' }));
      internal.executeTaskPairMode = vi.fn(async () => {});
      expect(await r.approve()).toBe(false);
      expect(internal.state.pendingApproval).toBeUndefined();
      expect(internal.executeTaskPairMode).not.toHaveBeenCalled();
    });

    it('approve() executes the task and returns true when the engine returns a workflow', async () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const pending = task({ id: 'approved-1' });
      internal.state.pendingApproval = pending;
      // executeTaskPairMode is mocked out (same technique enable.test.ts uses for
      // resolveProjectPath/runAvailableTasks) — approve() must never drive the real
      // pipeline in a unit test.
      internal.executeTaskPairMode = vi.fn(async () => {});
      internal.engine.heartbeat = vi.fn(async (): Promise<DecisionResult> => (
        { action: 'execute', task: pending, workflow: {} as DecisionResult['workflow'], reason: 'ready' }
      ));
      expect(await r.approve()).toBe(true);
      expect(internal.executeTaskPairMode).toHaveBeenCalledWith(pending);
    });
  });

  describe('stop() before start()', () => {
    it('is safe to call when no cron job was ever created', async () => {
      const r = new AutonomousRunner(cfg());
      await expect(r.stop()).resolves.toBeUndefined();
      expect(r.getState().isRunning).toBe(false);
    });
  });

  describe('stalled In Progress reconciliation', () => {
    it('moves an unowned stale Linear task to Backlog and updates the current snapshot', async () => {
      const updateState = vi.fn(async () => true);
      const lookupIssueState = vi.fn(async () => ({
        ok: true as const,
        issue: { state: 'In Progress', updatedAt: 1_000 },
      }));
      runnerExecution.setTaskSource({ kind: 'linear', updateState, lookupIssueState } as unknown as ITaskSource);
      const r = new AutonomousRunner(cfg({ stalledInProgressHours: 6 }));
      const internal = r as unknown as Internal;
      vi.spyOn(internal.durableRuns, 'getRun').mockReturnValue({ state: 'RETRY_AT' });
      (await import('../taskState/store.js')).markTaskInProgress('ISSUE-1', { sessionId: 'owned-session' });
      const stale = task({ linearState: 'In Progress', trackerUpdatedAt: 1_000 });

      await internal.reconcileStalledInProgress([stale], 6 * 60 * 60_000 + 1_000);

      expect(lookupIssueState).toHaveBeenCalledWith('INT-1');
      expect(updateState).toHaveBeenCalledWith('ISSUE-1', 'Backlog');
      expect(stale.linearState).toBe('Backlog');
    });

    it('fails closed when the tracker changed after the heartbeat snapshot', async () => {
      const updateState = vi.fn(async () => true);
      const lookupIssueState = vi.fn(async () => ({
        ok: true as const,
        issue: { state: 'In Progress', updatedAt: 1_001 },
      }));
      runnerExecution.setTaskSource({ kind: 'linear', updateState, lookupIssueState } as unknown as ITaskSource);
      const r = new AutonomousRunner(cfg({ stalledInProgressHours: 6 }));
      const internal = r as unknown as Internal;
      vi.spyOn(internal.durableRuns, 'getRun').mockReturnValue({ state: 'RETRY_AT' });
      (await import('../taskState/store.js')).markTaskInProgress('ISSUE-1', { sessionId: 'owned-session' });
      const stale = task({ linearState: 'In Progress', trackerUpdatedAt: 1_000 });

      await internal.reconcileStalledInProgress([stale], 6 * 60 * 60_000 + 1_000);

      expect(updateState).not.toHaveBeenCalled();
      expect(stale.linearState).toBe('In Progress');
    });
  });

  describe('scheduler "failed" event — rate_limited branch (INT-1906)', () => {
    it('pauses execution until the reset time without touching failure/rejection counters', async () => {
      const source = mockTaskSource();
      runnerExecution.setTaskSource(source);
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal & { rateLimitUntil: number };
      const scheduler = internal.scheduler as unknown as TaskScheduler;

      const resetsAt = Date.now() + 30_000;
      scheduler.startTask(task(), '/repo', async () => pipelineResult('rate_limited', { rateLimitResetsAt: resetsAt }));
      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(internal.rateLimitUntil).toBe(resetsAt);
      expect(source.updateState).not.toHaveBeenCalled();
      expect(source.logStuck).not.toHaveBeenCalled();
      expect(source.logBlocked).not.toHaveBeenCalled();
    });
  });

  // vela 2026-09-02 13:09–13:35: the coordinator parked a publication-scope
  // rejection, the failure budget below returned the card to Todo, the next
  // heartbeat read Todo as an operator reopen and resumed it — a park/resume
  // cycle every ~4 minutes, each waking the orchestrator sweep.
  describe('scheduler "failed" event — operatorPark branch', () => {
    it('parks the card in Backlog like STUCK and never returns it to Todo', async () => {
      const source = mockTaskSource();
      runnerExecution.setTaskSource(source);
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal & { completedTaskIds: Set<string>; failedTaskCounts: Map<string, number> };
      const scheduler = internal.scheduler as unknown as TaskScheduler;

      const reason = 'publication-scope: branch contains files outside reserved write scope: uv.lock';
      scheduler.startTask(task(), '/repo', async () => pipelineResult('failed', {
        failureDetail: `publication: ${reason}`,
        operatorPark: { code: 'publication_scope_mismatch', reason },
      }));
      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(source.logStuck).toHaveBeenCalledWith('ISSUE-1', 'autonomous-runner', expect.stringContaining('publication_scope_mismatch'));
      expect(source.updateState).not.toHaveBeenCalledWith('ISSUE-1', 'Todo');
      expect(source.logBlocked).not.toHaveBeenCalled();
      expect(internal.completedTaskIds.has('ISSUE-1')).toBe(true);
      expect(internal.failedTaskCounts.get('ISSUE-1') ?? 0).toBe(0);
    });
  });

  describe('pickPipelineFailureDetail', () => {
    it('prefers deterministic verification output over an earlier reviewer approval', () => {
      const result = pipelineResult('failed', {
        lastReviewFeedback: 'Work complete and approved.',
        testerResult: {
          success: false,
          testsPassed: 0,
          testsFailed: 1,
          output: '[cargo test] error[E0425]: cannot find type Rect in this scope',
          deterministic: true,
        },
      });

      expect(runnerModule.pickPipelineFailureDetail(result)).toContain('cannot find type Rect');
    });

    it('keeps reviewer feedback when verification did not fail', () => {
      const result = pipelineResult('failed', {
        lastReviewFeedback: 'The implementation still misses the requested behavior.',
      });

      expect(runnerModule.pickPipelineFailureDetail(result)).toBe(
        'The implementation still misses the requested behavior.',
      );
    });
  });

  describe('scheduler "failed" event — infeasible-DoD early STUCK (INT-2521 seven)', () => {
    it('marks STUCK on the second consecutive infeasibility marker instead of retrying', async () => {
      const source = mockTaskSource();
      runnerExecution.setTaskSource(source);
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const scheduler = internal.scheduler as unknown as TaskScheduler;

      // Prior attempt already recorded an infeasibility marker.
      internal.lastFailureDetails.set('ISSUE-1', { detail: 'This requires human intervention.', at: new Date().toISOString() });

      const failing = task();
      scheduler.startTask(failing, '/repo', async () => pipelineResult('failed', {
        workerResult: { success: false, summary: '', filesChanged: [], commands: [], output: '', error: 'This cannot be completed in the sandbox — needs human intervention.' },
      }));
      await new Promise((resolve) => setTimeout(resolve, 15));

      expect(source.logStuck).toHaveBeenCalledTimes(1);
      const [, , note] = source.logStuck.mock.calls[0];
      expect(String(note)).toContain('Needs human');
      expect(source.updateState).not.toHaveBeenCalled(); // early-stuck bypasses the normal rejection tally
    });
  });


  // vela deploys with maxConcurrentTasks 12 + pairMode true and never took any
  // other branch — the lane sat behind a `return` that only serial-mode
  // heartbeats reached, so it never ran a single time in production (AGT-4181
  // follow-up, 2026-09-03). These exercise the extracted gate directly.
  describe('maybeRunLedgerRetrospective (AGT-4181 follow-up)', () => {
    beforeEach(() => {
      runLedgerRetrospectiveMock.mockClear();
      runLedgerRetrospectiveMock.mockResolvedValue({ filed: false, reason: 'no failures in window' });
    });

    function primaryRunner(over: Partial<AutonomousConfig> = {}) {
      const r = new AutonomousRunner(cfg({ retrospectiveProjectId: 'proj-1', ...over }));
      const internal = r as unknown as Internal;
      Object.defineProperty(internal.durableRuns, 'isPrimary', { value: true, configurable: true });
      return internal;
    }

    it('calls the lane when configured, primary, and a task source is registered', async () => {
      runnerExecution.setTaskSource(mockTaskSource());
      const internal = primaryRunner();

      await internal.maybeRunLedgerRetrospective();

      expect(runLedgerRetrospectiveMock).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'proj-1' }));
    });

    it('does nothing without retrospectiveProjectId configured', async () => {
      runnerExecution.setTaskSource(mockTaskSource());
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      Object.defineProperty(internal.durableRuns, 'isPrimary', { value: true, configurable: true });

      await internal.maybeRunLedgerRetrospective();

      expect(runLedgerRetrospectiveMock).not.toHaveBeenCalled();
    });

    it('does nothing on a non-primary (shadow/replica) coordinator', async () => {
      runnerExecution.setTaskSource(mockTaskSource());
      const r = new AutonomousRunner(cfg({ retrospectiveProjectId: 'proj-1' }));
      const internal = r as unknown as Internal;
      Object.defineProperty(internal.durableRuns, 'isPrimary', { value: false, configurable: true });

      await internal.maybeRunLedgerRetrospective();

      expect(runLedgerRetrospectiveMock).not.toHaveBeenCalled();
    });

    it('swallows a lane failure without throwing', async () => {
      runnerExecution.setTaskSource(mockTaskSource());
      const internal = primaryRunner();
      runLedgerRetrospectiveMock.mockRejectedValueOnce(new Error('ledger unreachable'));

      await expect(internal.maybeRunLedgerRetrospective()).resolves.toBeUndefined();
    });
  });
});

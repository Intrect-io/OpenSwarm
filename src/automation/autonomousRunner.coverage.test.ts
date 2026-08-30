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

const { detectFileConflictsMock, resolveTaskFileScopeMock, fileScopesConflictMock } = vi.hoisted(() => ({
  detectFileConflictsMock: vi.fn(),
  resolveTaskFileScopeMock: vi.fn(async (task: TaskItem) => {
    task.fileScope ??= [`scope/${task.id}`];
    return task.fileScope;
  }),
  fileScopesConflictMock: vi.fn(() => false),
}));

vi.mock('../orchestration/conflictDetector.js', () => ({
  detectFileConflicts: detectFileConflictsMock,
  resolveTaskFileScope: resolveTaskFileScopeMock,
  fileScopesConflict: fileScopesConflictMock,
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

// Mirrors the pathsCaseInsensitive/isProjectEnabled getter formula — used to make
// case-folding assertions portable across the darwin dev machine and the linux CI
// runner (ci.yml runs ubuntu-latest) instead of hardcoding one platform's answer.
const isCaseInsensitivePlatform = process.platform === 'darwin' || process.platform === 'win32';

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
  };
  rateLimitUntil: number;
  scheduleNextHeartbeat(): void;
  executeTaskPairMode: ReturnType<typeof vi.fn>;
  reconcileStalledInProgress(tasks: TaskItem[], now?: number): Promise<TaskItem[]>;
  state: { pendingApproval?: TaskItem };
};

describe('AutonomousRunner coverage — safely-reachable helpers', () => {
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
    fileScopesConflictMock.mockReset();
    fileScopesConflictMock.mockReturnValue(false);
  }, 30000);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe('path/case helpers', () => {
    it('pathsCaseInsensitive reflects the current platform', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      expect(internal.pathsCaseInsensitive).toBe(isCaseInsensitivePlatform);
    });

    it('normalizePath lowercases only on case-insensitive platforms', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      expect(internal.normalizePath('/X/Y')).toBe(isCaseInsensitivePlatform ? '/x/y' : '/X/Y');
    });

    it('keeps descendants in the ledger scope when the allowed-project root is /', () => {
      const r = new AutonomousRunner(cfg({ allowedProjects: ['/'] }));
      const inScope = r.getDispatchScopePredicate();

      expect(inScope).toBeDefined();
      expect(inScope!('/work/agent-repo')).toBe(true);
    });

    it('isProjectEnabled: empty set never matches', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      expect(internal.isProjectEnabled('/x/a')).toBe(false);
    });

    it('isProjectEnabled: exact match and subdirectory match', () => {
      const r = new AutonomousRunner(cfg());
      r.enableProject('/x/a');
      const internal = r as unknown as Internal;
      expect(internal.isProjectEnabled('/x/a')).toBe(true);
      expect(internal.isProjectEnabled('/x/a/sub/dir')).toBe(true);
      expect(internal.isProjectEnabled('/x/ab')).toBe(false); // prefix but not a path segment
      expect(internal.isProjectEnabled('/x/b')).toBe(false);
    });

    it('isProjectEnabled: casing only matches on case-insensitive platforms', () => {
      const r = new AutonomousRunner(cfg());
      r.enableProject('/x/A');
      const internal = r as unknown as Internal;
      expect(internal.isProjectEnabled('/x/a')).toBe(isCaseInsensitivePlatform);
    });
  });

  describe('formatTaskContext', () => {
    it('prefers linearProject name + issueIdentifier', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const t = task({ linearProject: { id: 'p1', name: 'WAVE' }, issueIdentifier: 'INT-9' });
      expect(internal.formatTaskContext(t)).toBe('[WAVE] INT-9');
    });

    it('falls back to a truncated issueId when issueIdentifier is absent', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const t = task({ issueIdentifier: undefined, issueId: 'abcdefghij' });
      expect(internal.formatTaskContext(t)).toBe(t.issueId!.slice(0, 8));
    });

    it('returns empty string when neither project, identifier, nor id are present', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const t = task({ issueIdentifier: undefined, issueId: undefined });
      expect(internal.formatTaskContext(t)).toBe('');
    });
  });

  describe('per-project candidate cap helpers', () => {
    it('returns the scheduler enqueue result so a duplicate race does not consume a heartbeat slot', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const candidate = task({ id: 'enqueue-race' });

      expect(internal.enqueueCandidate(candidate, '/repo')).toBe(true);
      expect(internal.enqueueCandidate(candidate, '/repo')).toBe(false);
      expect(internal.scheduler.getQueuedTasks()).toHaveLength(1);
    });

    it('groups syntactic aliases of one repository into one conflict analysis', async () => {
      const r = new AutonomousRunner(cfg({ allowSameProjectConcurrent: false }));
      const internal = r as unknown as Internal;
      const first = task({ id: 'alias-first' });
      const second = task({ id: 'alias-second' });
      detectFileConflictsMock.mockResolvedValue({ safe: [first, second], conflictGroups: [] });

      const safe = await internal.detectSafeCandidateIds([
        { task: first, projectPath: '/repo' },
        { task: second, projectPath: '/tmp/../repo' },
      ]);

      expect(safe).toEqual(new Set(['alias-first', 'alias-second']));
      expect(detectFileConflictsMock).toHaveBeenCalledTimes(1);
      expect(detectFileConflictsMock).toHaveBeenCalledWith([first, second], '/repo');
    });

    it('defers overlapping scopes even when each issue runs in its own worktree', async () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentTasks: 3,
      }));
      const internal = r as unknown as Internal;
      const candidate = task({ id: 'candidate', fileScope: ['src/shared.ts'] });
      const activeTask = task({ id: 'active', fileScope: ['src/shared.ts'] });
      fileScopesConflictMock.mockReturnValueOnce(true);
      internal.scheduler.getRunningTasks = () => [{
        runId: 'active-run',
        task: activeTask,
        projectPath: '/repo',
        startedAt: Date.now(),
        promise: Promise.resolve(pipelineResult('approved', { success: true })),
        executorSettled: Promise.resolve(),
        abortController: new AbortController(),
      }];

      const safe = await internal.detectSafeCandidateIds([{ task: candidate, projectPath: '/repo' }]);

      expect(safe).toEqual(new Set());
      expect(fileScopesConflictMock).toHaveBeenCalledWith(candidate.fileScope, activeTask.fileScope);
      expect(detectFileConflictsMock).not.toHaveBeenCalled();
    });

    it('still fans out disjoint scopes across isolated worktrees', async () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentTasks: 3,
      }));
      const internal = r as unknown as Internal;
      const first = task({ id: 'first', fileScope: ['src/a.ts'] });
      const second = task({ id: 'second', fileScope: ['src/b.ts'] });
      detectFileConflictsMock.mockResolvedValue({ safe: [first, second], conflictGroups: [] });

      const safe = await internal.detectSafeCandidateIds([
        { task: first, projectPath: '/repo' },
        { task: second, projectPath: '/repo' },
      ]);

      expect(safe).toEqual(new Set(['first', 'second']));
      expect(detectFileConflictsMock).toHaveBeenCalledWith([first, second], '/repo');
    });

    it('repays a known-first deferred unknown as the next exclusive idle wave', async () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentTasks: 3,
      }));
      const internal = r as unknown as Internal;
      const known = task({ id: 'known', fileScope: ['src/known.ts'] });
      const unknown = task({ id: 'unknown', fileScope: undefined });
      resolveTaskFileScopeMock.mockImplementation(async (candidate: TaskItem) => candidate.fileScope ?? []);
      detectFileConflictsMock
        .mockResolvedValueOnce({ safe: [known], conflictGroups: [{ tasks: [known, unknown], sharedModules: ['unknown-file-scope'] }] })
        .mockResolvedValueOnce({ safe: [unknown], conflictGroups: [{ tasks: [known, unknown], sharedModules: ['unknown-file-scope'] }] });

      const firstWave = await internal.detectSafeCandidateIds([
        { task: known, projectPath: '/repo' }, { task: unknown, projectPath: '/repo' },
      ]);
      const secondWave = await internal.detectSafeCandidateIds([
        { task: known, projectPath: '/repo' }, { task: unknown, projectPath: '/repo' },
      ]);

      expect(firstWave).toEqual(new Set(['known']));
      expect(secondWave).toEqual(new Set(['unknown']));
      expect(detectFileConflictsMock).toHaveBeenLastCalledWith([known, unknown], '/repo', {
        preferUnknownExclusive: true,
        preferredUnknownTaskId: 'unknown',
      });
    });

    it('reuses a sufficient drafted scope across heartbeat task refetches', async () => {
      const r = new AutonomousRunner(cfg({ worktreeMode: true, maxConcurrentTasks: 2 }));
      const internal = r as unknown as Internal;
      resolveTaskFileScopeMock.mockImplementation(async (candidate: TaskItem) => {
        candidate.fileScope = ['src/drafted.ts'];
        candidate.fileScopeSource = 'drafted';
        candidate.preAdmissionDraft = {
          taskType: 'bugfix', intentSummary: 'repair the drafted implementation',
          relevantFiles: ['src/drafted.ts'],
          suggestedApproach: 'change the existing implementation carefully',
          completionCriteria: ['focused test passes'], sufficient: true,
          registrySnapshot: [], durationMs: 1,
        };
        return candidate.fileScope;
      });
      detectFileConflictsMock.mockImplementation(async (tasks: TaskItem[]) => ({
        safe: tasks, conflictGroups: [],
      }));
      const first = task({ id: 'cached-draft', description: 'stable description', trackerUpdatedAt: 10 });
      const refetched = task({ id: 'cached-draft', description: 'stable description', trackerUpdatedAt: 10 });

      await internal.detectSafeCandidateIds([{ task: first, projectPath: '/repo' }]);
      await internal.detectSafeCandidateIds([{ task: refetched, projectPath: '/repo' }]);

      expect(resolveTaskFileScopeMock).toHaveBeenCalledTimes(1);
      expect(refetched.fileScopeSource).toBe('drafted');
      expect(refetched.preAdmissionDraft?.relevantFiles).toEqual(['src/drafted.ts']);
    });

    it('still defers overlapping scopes when worktree fan-out is disabled', async () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: false, worktreeMode: true, maxConcurrentTasks: 3,
      }));
      const internal = r as unknown as Internal;
      const candidate = task({ id: 'candidate', fileScope: ['src/shared.ts'] });
      const activeTask = task({ id: 'active', fileScope: ['src/shared.ts'] });
      fileScopesConflictMock.mockReturnValueOnce(true);
      internal.scheduler.getRunningTasks = () => [{
        runId: 'active-run',
        task: activeTask,
        projectPath: '/repo',
        startedAt: Date.now(),
        promise: Promise.resolve(pipelineResult('approved', { success: true })),
        executorSettled: Promise.resolve(),
        abortController: new AbortController(),
      }];

      const safe = await internal.detectSafeCandidateIds([{ task: candidate, projectPath: '/repo' }]);

      expect(safe).toEqual(new Set());
      expect(fileScopesConflictMock).toHaveBeenCalledWith(candidate.fileScope, activeTask.fileScope);
      expect(detectFileConflictsMock).not.toHaveBeenCalled();
    });

    it('serializes a repository when conflict analysis cannot prove tasks disjoint', () => {
      const candidates = [
        { task: task({ id: 'first' }), projectPath: '/repo' },
        { task: task({ id: 'second' }), projectPath: '/repo' },
        { task: task({ id: 'third' }), projectPath: '/repo' },
      ];
      expect(runnerModule.failClosedConflictFallback(candidates)).toEqual(new Set(['first']));
      expect(runnerModule.failClosedConflictFallback([])).toEqual(new Set());
    });

    it('sameProjectCandidateCap is null when same-project parallel is disabled', () => {
      const r = new AutonomousRunner(cfg({ allowSameProjectConcurrent: false, worktreeMode: true, maxConcurrentPerProject: 2 }));
      const internal = r as unknown as Internal;
      expect(internal.sameProjectCandidateCap()).toBeNull();
    });

    it('sameProjectCandidateCap fills the global pool when the setting is omitted', () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentTasks: 4,
      }));
      const internal = r as unknown as Internal;
      expect(internal.sameProjectCandidateCap()).toBe(4);
      expect((internal.scheduler as unknown as {
        config: { maxConcurrentPerProject?: number };
      }).config.maxConcurrentPerProject).toBeUndefined();
    });

    it('sameProjectCandidateCap clamps between 1 and maxConcurrentTasks', () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: true, worktreeMode: true,
        maxConcurrentPerProject: 5, maxConcurrentTasks: 2,
      }));
      const internal = r as unknown as Internal;
      expect(internal.sameProjectCandidateCap()).toBe(2); // capped by maxConcurrentTasks
    });

    it('currentProjectLoad counts both queued and running tasks for the same normalized project path', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      // Replace the scheduler's getters directly (same technique enable.test.ts uses
      // for engine.heartbeatMultiple) so this stays a pure unit test with no real
      // TaskScheduler event emission, watchdog timer, or heartbeat trigger involved.
      internal.scheduler.getQueuedTasks = () => [
        { task: task({ id: 'q1' }), projectPath: '/x/a', queuedAt: 0, priority: 3 },
        { task: task({ id: 'q2' }), projectPath: '/x/b', queuedAt: 0, priority: 3 },
      ] as unknown as QueuedTask[];
      internal.scheduler.getRunningTasks = () => [
        { task: task({ id: 'r1' }), projectPath: '/x/a', startedAt: 0 } as unknown as RunningTask,
      ];
      expect(internal.currentProjectLoad('/x/a')).toBe(2); // 1 queued + 1 running
      expect(internal.currentProjectLoad('/x/b')).toBe(1);
      expect(internal.currentProjectLoad('/x/c')).toBe(0);
    });

    it('canQueueProjectCandidate is always true when there is no cap', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      internal.scheduler.getQueuedTasks = () => Array.from({ length: 50 }, (_, i) => (
        { task: task({ id: `q${i}` }), projectPath: '/x/a', queuedAt: 0, priority: 3 } as unknown as QueuedTask
      ));
      internal.scheduler.getRunningTasks = () => [];
      expect(internal.canQueueProjectCandidate('/x/a')).toBe(true);
    });

    it('canQueueProjectCandidate rejects once the project load reaches the cap', () => {
      const r = new AutonomousRunner(cfg({ allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentPerProject: 2, maxConcurrentTasks: 5 }));
      const internal = r as unknown as Internal;
      internal.scheduler.getQueuedTasks = () => [];
      internal.scheduler.getRunningTasks = () => [
        { task: task({ id: 'r1' }), projectPath: '/x/a', startedAt: 0 } as unknown as RunningTask,
        { task: task({ id: 'r2' }), projectPath: '/x/a', startedAt: 0 } as unknown as RunningTask,
      ];
      expect(internal.canQueueProjectCandidate('/x/a')).toBe(false); // load(2) >= cap(2)
      expect(internal.canQueueProjectCandidate('/x/b')).toBe(true); // different project, load 0
    });
  });

  describe('syslogSkipSummary', () => {
    it('logs an aggregate line per category and suppresses an identical repeat', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        internal.syslogSkipSummary(new Map([['ProjA', 3]]), new Map([['ProjB', 1]]));
        const firstCallLines = logSpy.mock.calls.map((c) => String(c[0]));
        expect(firstCallLines.some((l) => l.includes('unmapped project'))).toBe(true);
        expect(firstCallLines.some((l) => l.includes('disabled project'))).toBe(true);

        logSpy.mockClear();
        internal.syslogSkipSummary(new Map([['ProjA', 3]]), new Map([['ProjB', 1]]));
        expect(logSpy).not.toHaveBeenCalled(); // identical summary → stays silent
      } finally {
        logSpy.mockRestore();
      }
    });

    it('logs nothing when both maps are empty', () => {
      const r = new AutonomousRunner(cfg());
      const internal = r as unknown as Internal;
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        internal.syslogSkipSummary(new Map(), new Map());
        expect(logSpy).not.toHaveBeenCalled();
      } finally {
        logSpy.mockRestore();
      }
    });
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

    it('remaps jobProfiles roles, dropping incompatible models', () => {
      const r = new AutonomousRunner(cfg({
        defaultAdapter: 'codex',
        jobProfiles: [
          { name: 'light', estimatedMinutesMax: 10, roles: { worker: 'gpt-5.5-codex', reviewer: 'gpt-5.5-codex' } },
        ] as unknown as AutonomousConfig['jobProfiles'],
      }));
      expect(() => r.switchProvider('claude')).not.toThrow();
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
});

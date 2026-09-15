// Purpose: targeted coverage for AutonomousRunner's safely-reachable public/private
// helpers that the existing companion test files (cancel/enable/infraError)
// don't touch. Follows their established pattern — `new
// AutonomousRunner(cfg())` with `dryRun: true`, direct calls to public
// methods/getters, and casting to reach small private helpers exactly like
// `autonomousRunner.enable.test.ts` already does for `shouldFilterByEnabled` /
// `groupTasksForGrooming` / `heartbeatParallel`.
//
// Split for the ≤950-line LOC gate: the describes from getAdapterSummary onward
// live in autonomousRunner.coverage2.test.ts (with a verbatim copy of the
// module-level mocks/fixtures this file shares).
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
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { AutonomousConfig } from './runnerTypes.js';

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

let tempDir = '';
let AutonomousRunner: AutonomousRunnerCtor;
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
    isPrimary: boolean;
  };
  maybeRunLedgerRetrospective(): Promise<void>;
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
      expect(detectFileConflictsMock).toHaveBeenCalledWith([first, second], '/repo', {
        unknownScopeAdmission: 'admit',
      });
    });

    it('defers overlapping scopes even when each issue runs in its own worktree', async () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentTasks: 3,
      }));
      const internal = r as unknown as Internal;
      const candidate = task({ id: 'candidate', fileScope: ['src/shared.ts'] });
      const activeTask = task({ id: 'active', fileScope: ['src/shared.ts'] });
      describeScopeConflictMock.mockReturnValueOnce({ kind: 'overlap', shared: ['src/shared.ts'] });
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
      // Third argument is the admission policy the durable gate also reads;
      // passing it is the fix for AGT-4233.
      expect(describeScopeConflictMock)
        .toHaveBeenCalledWith(candidate.fileScope, activeTask.fileScope, 'admit');
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
      expect(detectFileConflictsMock).toHaveBeenCalledWith([first, second], '/repo', {
        unknownScopeAdmission: 'admit',
      });
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
        unknownScopeAdmission: 'admit',
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

    it('reuses a sufficient drafted scope even after a state-transition timestamp bump (AGT-4300)', async () => {
      // trackerUpdatedAt bumps on every tracker mutation, including the
      // daemon's OWN progress comments and state transitions — neither
      // changes anything the draft prompt reads. Measured on vela
      // (AUD-1070, 2026-09-10): 7 same-day state transitions with an
      // unchanged description, attempt_no reached 40, and a correct durable
      // cache entry (AGT-4286) sat unused because trackerUpdatedAt used to
      // ride along in the fingerprint. Title and description are the only
      // draft-relevant fields, and both are already separate elements of the
      // fingerprint array, so this only removes a self-inflicted miss — it
      // does not remove real invalidation coverage (see the next test).
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
      const first = task({ id: 'timestamp-churn', description: 'stable description', trackerUpdatedAt: 10 });
      // Same title+description, later trackerUpdatedAt — a daemon-authored
      // comment or a Backlog<->Todo<->In Progress bounce, not an operator edit.
      const bumped = task({ id: 'timestamp-churn', description: 'stable description', trackerUpdatedAt: 99_999 });

      await internal.detectSafeCandidateIds([{ task: first, projectPath: '/repo' }]);
      await internal.detectSafeCandidateIds([{ task: bumped, projectPath: '/repo' }]);

      expect(resolveTaskFileScopeMock).toHaveBeenCalledTimes(1);
      expect(bumped.fileScopeSource).toBe('drafted');
      expect(bumped.preAdmissionDraft?.relevantFiles).toEqual(['src/drafted.ts']);
    });

    it('still recomputes the draft when the description actually changed', async () => {
      // The invalidation guarantee this cache exists to preserve: an operator
      // rewriting the issue body must not reuse a draft written against the
      // old text. Title and description alone carry this — trackerUpdatedAt
      // was never load-bearing for it.
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
      const first = task({ id: 'text-edit', description: 'original description', trackerUpdatedAt: 10 });
      const edited = task({ id: 'text-edit', description: 'operator rewrote this entirely', trackerUpdatedAt: 10 });

      await internal.detectSafeCandidateIds([{ task: first, projectPath: '/repo' }]);
      await internal.detectSafeCandidateIds([{ task: edited, projectPath: '/repo' }]);

      expect(resolveTaskFileScopeMock).toHaveBeenCalledTimes(2);
    });

    it('still defers overlapping scopes when worktree fan-out is disabled', async () => {
      const r = new AutonomousRunner(cfg({
        allowSameProjectConcurrent: false, worktreeMode: true, maxConcurrentTasks: 3,
      }));
      const internal = r as unknown as Internal;
      const candidate = task({ id: 'candidate', fileScope: ['src/shared.ts'] });
      const activeTask = task({ id: 'active', fileScope: ['src/shared.ts'] });
      describeScopeConflictMock.mockReturnValueOnce({ kind: 'overlap', shared: ['src/shared.ts'] });
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
      // Third argument is the admission policy the durable gate also reads;
      // passing it is the fix for AGT-4233.
      expect(describeScopeConflictMock)
        .toHaveBeenCalledWith(candidate.fileScope, activeTask.fileScope, 'admit');
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

});

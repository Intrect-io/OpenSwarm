// Purpose: the runner wiring around the pre-claim draft call (AGT-4784): a failed
// draft holds the candidate, and a held issue is re-drafted once a person comments.
// Uses the same harness as autonomousRunner.coverage.test.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskScheduler, RunningTask, QueuedTask } from '../orchestration/taskScheduler.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
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
// The pre-claim draft (AGT-4784): pass through to the real drafter unless a test scripts it.
const { runDraftAnalysisMock } = vi.hoisted(() => ({ runDraftAnalysisMock: vi.fn() }));
vi.mock('../agents/draftAnalyzer.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agents/draftAnalyzer.js')>();
  runDraftAnalysisMock.mockImplementation(original.runDraftAnalysis);
  return { ...original, runDraftAnalysis: runDraftAnalysisMock };
});
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



// Mirrors the pathsCaseInsensitive/isProjectEnabled getter formula — used to make
// case-folding assertions portable across the darwin dev machine and the linux CI
// runner (ci.yml runs ubuntu-latest) instead of hardcoding one platform's answer.

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

describe('AutonomousRunner pre-claim draft hold (AGT-4784)', () => {
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
    runDraftAnalysisMock.mockClear();
  }, 30000);

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(tempDir, { recursive: true, force: true });
  });


    describe('readiness verdict before the claim (AGT-4784)', () => {
      const declined = {
        applicable: false as const, kind: 'decision_pending' as const, confidence: 0.95,
        reason: 'the title waits on a person to choose', evidence: ['title says pending', 'no code deliverable'],
      };
      const goalCfg = (goal?: string) => cfg({
        allowSameProjectConcurrent: true, worktreeMode: true, maxConcurrentTasks: 3,
        projectAgents: [{ projectPath: '/repo', ...(goal ? { goal } : {}) }],
      });

      // The wiring around the draft call: the runner's draftTask wraps the real pre-admission draft.
      const drafting = (draft: () => Promise<unknown>) => {
        runDraftAnalysisMock.mockImplementation(draft);
        resolveTaskFileScopeMock.mockImplementation(async (candidate: TaskItem, _path: string, opts?: { draftTask?: () => Promise<unknown> }) => {
          try {
            const result = await opts?.draftTask?.() as TaskItem['preAdmissionDraft'];
            if (result?.scope) candidate.preAdmissionDraft = result;
          } catch { /* resolveTaskFileScope swallows a failed draft */ }
          return [];
        });
      };

      it('holds a candidate whose pre-claim draft threw or got no answer, with no comment, and asks every project for a verdict', async () => {
        const addComment = vi.fn(async () => {});
        runnerExecution.setTaskSource({ kind: 'linear', addComment } as unknown as ITaskSource);
        const internal = new AutonomousRunner(goalCfg()) as unknown as Internal;
        drafting(async () => { throw new Error('provider down'); });
        const threw = task({ id: 'threw', issueId: 'ISSUE-threw', description: 'x' });
        expect(await internal.detectSafeCandidateIds([{ task: threw, projectPath: '/repo' }])).toEqual(new Set());
        expect(runDraftAnalysisMock).toHaveBeenCalledWith(expect.objectContaining({ askScopeVerdict: true }));

        drafting(async () => ({ relevantFiles: [], sufficient: false, failed: true }));
        const empty = task({ id: 'empty', issueId: 'ISSUE-empty', description: 'y' });
        expect(await internal.detectSafeCandidateIds([{ task: empty, projectPath: '/repo' }])).toEqual(new Set());
        expect(addComment).not.toHaveBeenCalled();
        expect(detectFileConflictsMock).not.toHaveBeenCalled();
      });

      it('re-drafts a held issue once a person comments, not after its own decline comment (AGT-4784)', async () => {
        const comments: Array<{ body: string; createdAt: string }> = [];
        const addComment = vi.fn(async (_id: string, body: string) => {
          comments.push({ body: `🧭 **[OpenSwarm]** ${body}`, createdAt: new Date(Date.now() + 1_000).toISOString() });
        });
        runnerExecution.setTaskSource({ kind: 'linear', addComment, getExecutionComments: async () => comments } as unknown as ITaskSource);
        const internal = new AutonomousRunner(goalCfg()) as unknown as Internal;
        drafting(async () => ({ relevantFiles: [], sufficient: false, scope: declined }));
        const make = (updatedAt: number) => task({ id: 'answer', issueId: 'ISSUE-answer', description: 'pick one', trackerUpdatedAt: updatedAt });
        const t0 = Date.now() - 60_000;

        expect(await internal.detectSafeCandidateIds([{ task: make(t0), projectPath: '/repo' }])).toEqual(new Set());
        expect(addComment).toHaveBeenCalledTimes(1);
        // The decline comment moved updatedAt: absorbed, no second draft.
        expect(await internal.detectSafeCandidateIds([{ task: make(Date.now() + 1_000), projectPath: '/repo' }])).toEqual(new Set());
        expect(runDraftAnalysisMock).toHaveBeenCalledTimes(1);
        // A person answers: the cached decline is judged again.
        comments.push({ body: 'Decided: keep the key.', createdAt: new Date(Date.now() + 2_000).toISOString() });
        await internal.detectSafeCandidateIds([{ task: make(Date.now() + 2_000), projectPath: '/repo' }]);
        expect(runDraftAnalysisMock).toHaveBeenCalledTimes(2);
        expect(addComment).toHaveBeenCalledTimes(1); // same marker for this issue: no second comment
      });
    });
});

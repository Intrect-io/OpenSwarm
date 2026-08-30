// ============================================
// OpenSwarm - runnerExecution.ts coverage extension
// ============================================
//
// Targets `executePipeline` (the daemon's pipeline-execution orchestrator) plus
// the smaller exported reporting/state-sync helpers. Strategy mirrors
// `pairPipeline.coverage.test.ts`: mock every external stage/side-effect
// dependency as `vi.fn()` and drive the function through its branches.
//
// executePipeline itself never calls the real worker/reviewer/tester stages —
// it delegates to a `PairPipeline` instance built by `createPipelineFromConfig`
// and only *listens* to that instance's events (stage:start/stage:complete/
// halt/revision:start). So the key seam here is `createPipelineFromConfig`:
// we replace it with a factory that returns a plain `EventEmitter` whose `run()`
// is a controllable `vi.fn()`. Emitting synthetic events from that fake lets us
// exercise executePipeline's own listener bodies without touching the real
// (heavy) PairPipeline class or its own dependency tree.
//
// All disk/state-touching singletons (taskState/store.ts → ~/.openswarm,
// runnerState.ts → ~/.claude + ~/.openswarm, memory persistence) are mocked so
// no test touches real user state.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { EmbedBuilder } from 'discord.js';
import type { TaskItem, DecisionResult } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { DraftAnalysis } from '../agents/draftAnalyzer.js';
import type { WorktreeInfo } from '../support/worktreeManager.js';
import type { ITaskSource } from './taskSource.js';
import type { ExecutionContext } from './runnerExecution.js';
import type { ExecutorResult } from '../orchestration/workflow.js';
import { RateLimitError } from '../adapters/rateLimitError.js';

// ---- mock fns (hoisted alongside the vi.mock() calls below) ----

const createPipelineFromConfig = vi.fn();
const runDraftAnalysis = vi.fn();
const plannerNeedsDecomposition = vi.fn();
const plannerEstimateTaskDuration = vi.fn();
const plannerRunPlanner = vi.fn();
const plannerFormatPlannerResult = vi.fn();
const createWorktree = vi.fn();
// Stand-in for the real class — the instanceof check under test resolves
// through this same mock, so identity (not origin) is what matters (AGT-4038).
const WorktreeCoordinationError = class extends Error {};
const commitAndCreatePR = vi.fn();
const findOpenPRFileOverlaps = vi.fn();
const hasRecoverableWorktree = vi.fn();
const preserveWorktree = vi.fn();
const removeWorktree = vi.fn();
const broadcastEvent = vi.fn();
const analyzeIssue = vi.fn();
const formatWorkReport = vi.fn();
const formatReviewFeedback = vi.fn();
const formatTestReport = vi.fn();
const formatDocReport = vi.fn();
const saveCognitiveMemory = vi.fn();
const loadParsedTask = vi.fn();
const formatParsedTaskSummary = vi.fn();

const markTaskInProgress = vi.fn();
const buildTaskStateSyncComment = vi.fn();
const completeParentIfChildrenDone = vi.fn();
const markTaskBlocked = vi.fn();
const markTaskBacklog = vi.fn();
const markTaskDecomposed = vi.fn();
const markTaskDone = vi.fn();
const releaseDependentTasks = vi.fn();
const upsertTaskState = vi.fn();

const getDecompositionDepth = vi.fn();
const getChildrenCount = vi.fn();
const getDailyCreationCount = vi.fn();
const canCreateMoreIssues = vi.fn();
const registerDecomposition = vi.fn();
const reserveDailyCreations = vi.fn();
const releaseDailyReservation = vi.fn();

const loadRepoMetadata = vi.fn();
const mapLinearProject = vi.fn();
const fsStat = vi.fn();

// Only `createPipelineFromConfig` is faked; `buildTaskPrefix` is a small pure
// helper re-exported by pairPipeline.js — pull it straight from its own
// (dependency-free) source file so we never load the real (heavy) PairPipeline
// class or its transitive stage/registry/knowledge dependency tree.
vi.mock('../agents/pairPipeline.js', async () => {
  const { buildTaskPrefix } = await import('../agents/pipelineTaskPrefix.js');
  return { createPipelineFromConfig, buildTaskPrefix };
});

vi.mock('../agents/draftAnalyzer.js', () => ({ runDraftAnalysis }));

vi.mock('../support/planner.js', () => ({
  needsDecomposition: plannerNeedsDecomposition,
  estimateTaskDuration: plannerEstimateTaskDuration,
  runPlanner: plannerRunPlanner,
  formatPlannerResult: plannerFormatPlannerResult,
}));

vi.mock('../support/worktreeManager.js', () => ({
  createWorktree,
  commitAndCreatePR,
  findOpenPRFileOverlaps,
  hasRecoverableWorktree,
  preserveWorktree,
  removeWorktree,
  WorktreeCoordinationError,
}));

vi.mock('../core/eventHub.js', () => ({ broadcastEvent }));

vi.mock('../knowledge/index.js', () => ({ analyzeIssue }));

vi.mock('../agents/worker.js', () => ({ formatWorkReport }));
vi.mock('../agents/reviewer.js', () => ({ formatReviewFeedback }));
vi.mock('../agents/tester.js', () => ({ formatTestReport }));
vi.mock('../agents/documenter.js', () => ({ formatDocReport }));

vi.mock('../memory/index.js', () => ({ saveCognitiveMemory }));
vi.mock('../orchestration/taskParser.js', () => ({ loadParsedTask, formatParsedTaskSummary }));

vi.mock('../taskState/store.js', () => ({
  markTaskInProgress,
  buildTaskStateSyncComment,
  completeParentIfChildrenDone,
  markTaskBlocked,
  markTaskBacklog,
  markTaskDecomposed,
  markTaskDone,
  releaseDependentTasks,
  upsertTaskState,
}));

vi.mock('./runnerState.js', () => ({
  getDecompositionDepth,
  getChildrenCount,
  getDailyCreationCount,
  canCreateMoreIssues,
  registerDecomposition,
  reserveDailyCreations,
  releaseDailyReservation,
}));

// resolveProjectPath / isValidProjectPath dependencies (real versions all read
// the real filesystem — openswarm.json lookups, directory scans).
vi.mock('../support/repoMetadata.js', () => ({ loadRepoMetadata }));
vi.mock('../support/projectMapper.js', () => ({ mapLinearProject }));
vi.mock('fs/promises', () => ({ stat: fsStat }));

// `./runnerExecution.js` (the module under test) must NOT be statically
// imported at the top of this file: static imports are evaluated before any
// local top-level statement, including the `const x = vi.fn()` declarations
// above — so the vi.mock() factories above would run while those consts are
// still in their temporal dead zone. Loading it lazily in `beforeAll` (which
// only runs once all top-level file code, including the consts, has executed)
// avoids that ordering trap. Mirrors the dynamic-import convention already
// used by `pairPipeline.coverage.test.ts` for the same reason.
let executePipeline: typeof import('./runnerExecution.js')['executePipeline'];
let boundPipelineEffect: typeof import('./runnerExecution.js')['boundPipelineEffect'];
let setTaskSource: typeof import('./runnerExecution.js')['setTaskSource'];
let reportExecutionResult: typeof import('./runnerExecution.js')['reportExecutionResult'];
let reconcileCompletionState: typeof import('./runnerExecution.js')['reconcileCompletionState'];
let requestApproval: typeof import('./runnerExecution.js')['requestApproval'];

beforeAll(async () => {
  const mod = await import('./runnerExecution.js');
  executePipeline = mod.executePipeline;
  boundPipelineEffect = mod.boundPipelineEffect;
  setTaskSource = mod.setTaskSource;
  reportExecutionResult = mod.reportExecutionResult;
  reconcileCompletionState = mod.reconcileCompletionState;
  requestApproval = mod.requestApproval;
});

// ---- fixtures & helpers ----

/** Drains the microtask queue. The pipeline event listeners registered inside
 *  executePipeline are `async` functions invoked synchronously by
 *  `EventEmitter.emit()` (which does not await them) — exactly the same
 *  fire-and-forget shape the real PairPipeline uses. To assert on a listener's
 *  side effects deterministically (instead of racing its internal awaits
 *  against our fake `run()`'s own resolution), the fake pipeline flushes with
 *  this helper right after emitting, before returning its result. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    source: 'linear',
    title: 'Fix the flaky retry logic',
    description: 'The retry logic drops cursor state between pages.',
    priority: 2,
    createdAt: Date.now(),
    issueId: 'issue-1',
    issueIdentifier: 'INT-100',
    linearProject: { id: 'proj-1', name: 'OpenSwarm' },
    ...overrides,
  };
}

function draftAnalysisFixture(overrides: Partial<DraftAnalysis> = {}): DraftAnalysis {
  return {
    taskType: 'bugfix',
    intentSummary: 'Fix the cursor-state bug.',
    relevantFiles: ['src/a.ts'],
    suggestedApproach: 'Scope the cursor per page.',
    completionCriteria: ['Cursor state survives pagination'],
    sufficient: true,
    registrySnapshot: [],
    durationMs: 1200,
    ...overrides,
  };
}

function pipelineResult(overrides: Partial<PipelineResult> = {}): PipelineResult {
  return {
    success: true,
    sessionId: 'sess-1',
    stages: [],
    finalStatus: 'approved',
    totalDuration: 1000,
    iterations: 1,
    ...overrides,
  };
}

function worktreeInfoFixture(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    worktreePath: '/repo/worktree/issue-1',
    branchName: 'swarm/INT-100-fix-the-flaky-retry-logic',
    originalPath: '/repo',
    issueId: 'issue-1',
    ...overrides,
  };
}

/** A minimal EventEmitter standing in for `PairPipeline`. `run()` emits the
 *  requested events (flushing microtasks after so listener side effects are
 *  observable deterministically), then resolves with `result`. */
function makeFakePipeline(result: PipelineResult, emits: Array<[string, unknown]> = []) {
  const fp = new EventEmitter() as EventEmitter & { run: ReturnType<typeof vi.fn> };
  fp.run = vi.fn(async () => {
    for (const [event, payload] of emits) fp.emit(event, payload);
    await flush();
    return result;
  });
  return fp;
}

function makeTaskSource(overrides: Partial<ITaskSource> = {}): ITaskSource {
  return {
    kind: 'local',
    fetchTasks: vi.fn(async () => []),
    createTask: vi.fn(async () => ({ id: 'top-1', identifier: 'INT-200', title: 'top' })),
    updateState: vi.fn(async () => true),
    addComment: vi.fn(async () => {}),
    createSubIssue: vi.fn(async () => ({ id: 'sub-1', identifier: 'INT-101', title: 'sub-task' })),
    logPairStart: vi.fn(async () => {}),
    logPairComplete: vi.fn(async () => {}),
    logBlocked: vi.fn(async () => {}),
    logStuck: vi.fn(async () => {}),
    unstick: vi.fn(async () => {}),
    logHalt: vi.fn(async () => {}),
    markAsDecomposed: vi.fn(async () => {}),
    ...overrides,
  } as ITaskSource;
}

function makeCtx(overrides: Partial<ExecutionContext> = {}): ExecutionContext {
  return {
    allowedProjects: [],
    getRolesForProject: vi.fn(() => undefined),
    reportToDiscord: vi.fn(async () => {}),
    ...overrides,
  };
}

describe('runnerExecution.ts coverage extension', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    getDecompositionDepth.mockReturnValue(0);
    getChildrenCount.mockReturnValue(0);
    getDailyCreationCount.mockReturnValue(0);
    canCreateMoreIssues.mockReturnValue(true);
    registerDecomposition.mockReturnValue(undefined);
    // Admission runs through the atomic reserve in production. (AGT-4122)
    reserveDailyCreations.mockReturnValue(true);
    releaseDailyReservation.mockReturnValue(undefined);

    markTaskInProgress.mockReturnValue({ issueId: 'issue-1' });
    buildTaskStateSyncComment.mockReturnValue('sync comment');
    completeParentIfChildrenDone.mockReturnValue(null);
    markTaskBlocked.mockReturnValue({ issueId: 'issue-1' });
    markTaskBacklog.mockReturnValue({ issueId: 'issue-1' });
    markTaskDecomposed.mockReturnValue({ issueId: 'issue-1' });
    markTaskDone.mockReturnValue({ issueId: 'issue-1' });
    releaseDependentTasks.mockReturnValue([]);
    upsertTaskState.mockReturnValue({ issueId: 'sub-1' });

    runDraftAnalysis.mockResolvedValue(draftAnalysisFixture());
    plannerNeedsDecomposition.mockReturnValue(false);
    plannerEstimateTaskDuration.mockReturnValue(45);
    plannerFormatPlannerResult.mockReturnValue('planner result summary');

    commitAndCreatePR.mockResolvedValue('https://github.com/org/repo/pull/1');
    findOpenPRFileOverlaps.mockResolvedValue([]);
    hasRecoverableWorktree.mockResolvedValue(false);
    removeWorktree.mockResolvedValue(undefined);
    preserveWorktree.mockResolvedValue(true);
    analyzeIssue.mockResolvedValue(null);
    saveCognitiveMemory.mockResolvedValue(undefined);
    loadParsedTask.mockResolvedValue(null);
    formatParsedTaskSummary.mockReturnValue('parsed summary');

    formatWorkReport.mockReturnValue('work report');
    formatReviewFeedback.mockReturnValue('review feedback');
    formatTestReport.mockReturnValue('test report');
    formatDocReport.mockReturnValue('doc report');

    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  // ============================================
  // Draft analysis
  // ============================================

  describe('draft analysis', () => {
    it('marks a high-confidence older peer as the canonical duplicate and skips the worker', async () => {
      const markDuplicate = vi.fn(async () => true);
      taskSourceMock = makeTaskSource({ markDuplicate });
      setTaskSource(taskSourceMock);
      runDraftAnalysis.mockResolvedValueOnce(draftAnalysisFixture({
        duplicateOfIssueId: 'issue-older',
        duplicateConfidence: 0.97,
        duplicateReason: 'Same endpoint and observable behavior.',
        duplicateEvidence: ['same POST /cards/status endpoint', 'same dashboard write-back criterion'],
      }));
      const current = task({ createdAt: 200 });
      const older = task({ id: 'peer', issueId: 'issue-older', issueIdentifier: 'INT-90', createdAt: 100 });

      const result = await executePipeline(makeCtx({ peerIssues: [current, older] }), current, '/repo');

      expect(result.finalStatus).toBe('superseded');
      expect(markDuplicate).toHaveBeenCalledWith('issue-1', 'issue-older');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.stringContaining('INT-90'));
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
      expect(runDraftAnalysis).toHaveBeenCalledWith(expect.objectContaining({
        peerIssues: [expect.objectContaining({ issueId: 'issue-older' })],
      }));
    });

    it('does not create a duplicate relation when the proposed canonical issue is newer', async () => {
      const markDuplicate = vi.fn(async () => true);
      taskSourceMock = makeTaskSource({ markDuplicate });
      setTaskSource(taskSourceMock);
      runDraftAnalysis.mockResolvedValueOnce(draftAnalysisFixture({
        duplicateOfIssueId: 'issue-newer',
        duplicateConfidence: 0.99,
        duplicateEvidence: ['same endpoint', 'same acceptance criterion'],
      }));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
      const current = task({ createdAt: 100 });
      const newer = task({ id: 'peer', issueId: 'issue-newer', createdAt: 200 });

      const result = await executePipeline(makeCtx({ peerIssues: [newer] }), current, '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(markDuplicate).not.toHaveBeenCalled();
    });

    it('does not create a duplicate relation when issue timestamps are equal', async () => {
      const markDuplicate = vi.fn(async () => true);
      taskSourceMock = makeTaskSource({ markDuplicate });
      setTaskSource(taskSourceMock);
      runDraftAnalysis.mockResolvedValueOnce(draftAnalysisFixture({
        duplicateOfIssueId: 'issue-peer',
        duplicateConfidence: 0.99,
        duplicateEvidence: ['same endpoint', 'same acceptance criterion'],
      }));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
      const current = task({ createdAt: 100 });
      const peer = task({ id: 'peer', issueId: 'issue-peer', createdAt: 100 });
      const result = await executePipeline(makeCtx({ peerIssues: [peer] }), current, '/repo');
      expect(result.finalStatus).toBe('approved');
      expect(markDuplicate).not.toHaveBeenCalled();
    });
    it('runs draft analysis by default, then proceeds to the pipeline (happy path)', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx(), task(), '/repo');

      expect(runDraftAnalysis).toHaveBeenCalledTimes(1);
      expect(result.success).toBe(true);
      expect(result.finalStatus).toBe('approved');
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('skips draft analysis when enableDraftAnalysis is false', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx({ enableDraftAnalysis: false }), task(), '/repo');

      expect(runDraftAnalysis).not.toHaveBeenCalled();
    });

    it('returns a rate_limited result immediately when draft analysis hits a rate limit', async () => {
      runDraftAnalysis.mockRejectedValueOnce(new RateLimitError(1782824950, 'Codex usage limit reached'));

      const result = await executePipeline(makeCtx(), task(), '/repo');

      expect(result.finalStatus).toBe('rate_limited');
      expect(result.success).toBe(false);
      expect(result.rateLimitResetsAt).toBe(1782824950 * 1000);
      // The pipeline must never be constructed for a pre-pipeline rate limit.
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });

    it('treats a non-rate-limit draft analysis failure as non-blocking and continues', async () => {
      runDraftAnalysis.mockRejectedValueOnce(new Error('draft analyzer crashed'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx(), task(), '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Draft analysis failed'), 'Error: draft analyzer crashed');
    });

    it('mirrors draft analysis onLog lines to stdout and the event hub', async () => {
      runDraftAnalysis.mockImplementationOnce(async (opts: { onLog: (line: string) => void }) => {
        opts.onLog('scanning repository...');
        return draftAnalysisFixture();
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('scanning repository...'));
      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        data: expect.objectContaining({ stage: 'draft', line: 'scanning repository...' }),
      }));
    });

    it('propagates a non-rate-limit error thrown by the decomposition heuristic instead of swallowing it', async () => {
      // planner.needsDecomposition() runs synchronously inside the same
      // try/catch that classifies RateLimitError vs everything else — a plain
      // Error here must be rethrown to the caller (line ~747), not converted
      // into a rate_limited result.
      plannerNeedsDecomposition.mockImplementationOnce(() => {
        throw new Error('heuristic crashed');
      });

      await expect(executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      )).rejects.toThrow('heuristic crashed');
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });
  });

  // ============================================
  // Decomposition
  // ============================================

  describe('decomposition', () => {
    it('skips decomposition entirely when the heuristic says it is not needed', async () => {
      plannerNeedsDecomposition.mockReturnValue(false);
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      expect(plannerRunPlanner).not.toHaveBeenCalled();
    });

    it('falls through to direct execution when the daily creation limit is reached', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      canCreateMoreIssues.mockReturnValue(false);
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      // Daily-limit short-circuit happens before the planner is ever invoked.
      expect(plannerRunPlanner).not.toHaveBeenCalled();
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('falls through to direct execution when the planner says the task fits the threshold', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true, originalIssue: 'issue-1', needsDecomposition: false, subTasks: [], totalEstimatedMinutes: 0,
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('falls through to direct execution when the planner itself fails', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: false, originalIssue: 'issue-1', needsDecomposition: false, subTasks: [],
        totalEstimatedMinutes: 0, error: 'planner adapter exploded',
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    it('returns a decomposed result and creates sub-issues when the planner recommends decomposition', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'do the first part', estimatedMinutes: 20, priority: 2, fileScope: ['src/a.ts', '  ', 42 as unknown as string] },
          { title: 'Sub 2', description: 'do the second part', estimatedMinutes: 15, priority: 3, dependencies: ['Sub 1'] },
        ],
        totalEstimatedMinutes: 35,
      });
      // Echo back a per-call unique id/title (matching the real ITaskSource
      // contract) so the dependency-resolution map (childIdByPlanTitle) actually
      // resolves Sub 2's dependency on "Sub 1" — the shared taskSourceMock
      // default (a single fixed return value for every call) would otherwise
      // make every sub-issue resolve to the same title/id, masking the
      // blocked-dependency branch entirely.
      let subCounter = 0;
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => ({ id: `sub-${++subCounter}`, identifier: `INT-10${subCounter}`, title }),
      );
      const scheduleNextHeartbeat = vi.fn();

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true, scheduleNextHeartbeat }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('decomposed');
      expect(result.success).toBe(true);
      // The real pipeline must never run for a successfully decomposed task.
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
      const decompositionCalls = (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mock.calls;
      const firstId = decompositionCalls[0][3]?.idempotencyId;
      const secondId = decompositionCalls[1][3]?.idempotencyId;
      expect(firstId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(secondId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(firstId).not.toBe(secondId);
      expect(registerDecomposition).toHaveBeenCalledWith('issue-1', undefined, ['sub-1', 'sub-2']);
      expect(markTaskDecomposed).toHaveBeenCalled();
      expect(scheduleNextHeartbeat).toHaveBeenCalledTimes(1);
      // Sub 1 has no dependencies → moved straight to Todo; Sub 2 depends on
      // Sub 1 (now resolvable via the per-call id) → kept in Backlog.
      expect(taskSourceMock.updateState).toHaveBeenCalledWith('sub-1', 'Todo');
      expect(taskSourceMock.updateState).toHaveBeenCalledWith('sub-2', 'Backlog');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Keeping INT-102 in Backlog until dependencies resolve'));
    });

    it('resolves a dependency against this retry\'s own plan title, not a recovered child\'s stale title (AGT-4048)', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true, originalIssue: 'issue-1', needsDecomposition: true, totalEstimatedMinutes: 35,
        subTasks: [
          { title: 'Sub 1', description: 'first', estimatedMinutes: 20, priority: 2 },
          { title: 'Sub 2', description: 'second', estimatedMinutes: 15, priority: 3, dependencies: ['Sub 1'] },
        ],
      });
      // Retry converges on Sub 1's stale first-attempt title; Sub 2 depends on
      // "Sub 1" by THIS retry's title, which must still resolve (AGT-4048).
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => title === 'Sub 1'
          ? { id: 'sub-1', identifier: 'INT-101', title: 'Sub 1 (stale wording)' }
          : { id: 'sub-2', identifier: 'INT-102', title },
      );

      await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(taskSourceMock.updateState).toHaveBeenCalledWith('sub-1', 'Todo');
      expect(taskSourceMock.updateState).toHaveBeenCalledWith('sub-2', 'Backlog');
    });

    it('fails closed when one sub-issue state cannot be initialized', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'first', estimatedMinutes: 10, priority: 2 },
          { title: 'Sub 2', description: 'second', estimatedMinutes: 10, priority: 2 },
        ],
        totalEstimatedMinutes: 20,
      });
      let subCounter = 0;
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => ({ id: `sub-${++subCounter}`, identifier: `INT-10${subCounter}`, title }),
      );
      (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

      await expect(executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo'))
        .rejects.toThrow('linear down');
      // Both deterministic children exist, so the next attempt can recover them
      // and retry state initialization without creating duplicates.
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
      expect(taskSourceMock.markAsDecomposed).not.toHaveBeenCalled();
      expect(registerDecomposition).not.toHaveBeenCalled();
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });

    it('auto-moves the task to Backlog and skips decomposition once the depth limit is reached', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getDecompositionDepth.mockReturnValue(2); // == default maxDepth
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved'); // falls through to direct execution
      expect(taskSourceMock.updateState).toHaveBeenCalledWith('issue-1', 'Backlog');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.stringContaining('depth limit'));
      expect(plannerRunPlanner).not.toHaveBeenCalled();
    });

    it('tolerates a failure while auto-backlogging on depth-limit', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getDecompositionDepth.mockReturnValue(5);
      (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await expect(executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo')).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to move to backlog'), expect.any(Error));
    });

    it('auto-moves the task to Backlog and skips decomposition once the children-count limit is reached', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getChildrenCount.mockReturnValue(5); // == default maxChildren
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(result.finalStatus).toBe('approved');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.stringContaining('too many sub-issues'));
    });

    it('reconciles an interrupted In Progress decomposition despite child and daily gates', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getChildrenCount.mockReturnValue(5);
      canCreateMoreIssues.mockReturnValue(false);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [{ title: 'Existing child', description: 'resume', estimatedMinutes: 10, priority: 2 }],
        totalEstimatedMinutes: 10,
      });

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task({ linearState: 'In Progress' }),
        '/repo',
      );

      expect(result.finalStatus).toBe('decomposed');
      expect(plannerRunPlanner).toHaveBeenCalledTimes(1);
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(1);
      expect(taskSourceMock.updateState).not.toHaveBeenCalledWith('issue-1', 'Backlog');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Reconciling 5 existing child'));
    });

    it('does not auto-backlog on limit breach when decompositionAutoBacklog is disabled', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getDecompositionDepth.mockReturnValue(9);
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(
        makeCtx({ enableDecomposition: true, decompositionAutoBacklog: false }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.updateState).not.toHaveBeenCalledWith('issue-1', 'Backlog');
    });

    it('falls through to direct execution when the task has no issueId to attach sub-issues to', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true, originalIssue: '', needsDecomposition: true,
        subTasks: [{ title: 'Sub 1', description: 'd', estimatedMinutes: 10, priority: 2 }],
        totalEstimatedMinutes: 10,
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true }),
        task({ issueId: undefined, issueIdentifier: undefined }),
        '/repo',
      );

      expect(result.finalStatus).toBe('approved');
      expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
    });

    it('fails closed when no sub-issue can be created instead of executing the parent directly', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true, originalIssue: 'issue-1', needsDecomposition: true,
        subTasks: [{ title: 'Sub 1', description: 'd', estimatedMinutes: 10, priority: 2 }],
        totalEstimatedMinutes: 10,
      });
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ error: 'Linear rejected the sub-issue' });
      await expect(executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo'))
        .rejects.toThrow(/Incomplete decomposition/);
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Incomplete sub-issue creation'));
    });

    it('surfaces the planner onLog stream and tolerates a KG impact-analysis failure', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      analyzeIssue.mockRejectedValueOnce(new Error('graph unavailable'));
      plannerRunPlanner.mockImplementationOnce(async (opts: { onLog: (line: string) => void }) => {
        opts.onLog('planner iterating...');
        return {
          success: true, originalIssue: 'issue-1', needsDecomposition: false, subTasks: [], totalEstimatedMinutes: 0,
        };
      });
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx({ enableDecomposition: true }), task(), '/repo');

      expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
        type: 'log',
        data: expect.objectContaining({ stage: 'decompose', line: 'planner iterating...' }),
      }));
    });
  });

  // ============================================
  // Worktree mode
  // ============================================

  describe('worktree mode', () => {
    it('creates a worktree, runs the pipeline, and opens a PR on approval', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      commitAndCreatePR.mockResolvedValue('https://github.com/org/repo/pull/1');
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult({ finalStatus: 'approved', success: true })));

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(createWorktree).toHaveBeenCalledWith('/repo', 'issue-1', 'swarm/INT-100-fix-the-flaky-retry-logic');
      expect(commitAndCreatePR).toHaveBeenCalledTimes(1);
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
      expect(removeWorktree).toHaveBeenCalledTimes(1);
      expect(preserveWorktree).not.toHaveBeenCalled();
    });

    it('returns a repository-scoped infra_error without ever constructing the pipeline when worktree creation fails (AGT-4038)', async () => {
      createWorktree.mockRejectedValue(new Error('git worktree add: disk full'));
      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');
      expect(result).toMatchObject({ finalStatus: 'infra_error', success: false });
      expect(result.repositoryInfra).toBe(true); // disk full is the repo's own fault
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
    });

    it.each([
      ['a preserved worktree just needs reconciliation', 'Preserved worktree requires reconciliation (valid=false, branch=main): /wt'],
      ['the worktree lifecycle lock is busy', 'Worktree lifecycle is busy for issue-1'],
    ])('does not blame the repository when %s (AGT-4038)', async (_label, message) => {
      createWorktree.mockRejectedValue(new WorktreeCoordinationError(message));
      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');
      expect(result).toMatchObject({ finalStatus: 'infra_error', success: false });
      expect(result.repositoryInfra).toBeFalsy(); // coordination, not disk/git health
    });

    it('preserves an acquired worktree when durable attachment throws during setup, without blaming the repository (AGT-4038)', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      const durability = {
        onWorktree: vi.fn(async () => { throw new Error('sqlite busy'); }),
        onStage: vi.fn(async () => true),
        beforePublish: vi.fn(async () => true),
        onPublication: vi.fn(async () => true),
      };
      const result = await executePipeline(makeCtx({ worktreeMode: true, durability }), task(), '/repo');
      expect(result).toMatchObject({ success: false, finalStatus: 'infra_error' });
      expect(result.repositoryInfra).toBeFalsy(); // ledger contention, not the repo's git state
      expect(createPipelineFromConfig).not.toHaveBeenCalled();
      expect(preserveWorktree).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'issue-1' }), 'worktree setup or durable attachment failed');
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('preserves the worktree when the pipeline result is not successful', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      createPipelineFromConfig.mockReturnValue(
        makeFakePipeline(pipelineResult({ success: false, finalStatus: 'rejected' })),
      );

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.success).toBe(false);
      expect(preserveWorktree).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'issue-1' }), 'session did not succeed');
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('preserves the worktree when success is true but finalStatus is not approved', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      createPipelineFromConfig.mockReturnValue(
        makeFakePipeline(pipelineResult({ success: true, finalStatus: 'cancelled' })),
      );

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.success).toBe(true);
      expect(commitAndCreatePR).not.toHaveBeenCalled();
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Unexpected state'));
      expect(preserveWorktree).toHaveBeenCalledTimes(1);
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('keeps a PR-creation failure retryable instead of reporting false success', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      commitAndCreatePR.mockRejectedValue(new Error('gh pr create failed'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo');

      expect(result.success).toBe(false);
      expect(result.finalStatus).toBe('infra_error');
      expect(result.prUrl).toBeUndefined();
      expect(console.error).toHaveBeenCalledWith('[Worktree] PR creation failed:', expect.any(Error));
      expect(preserveWorktree).toHaveBeenCalledTimes(1);
    });

    it('treats a rejected publication attachment as fenced and preserves the published worktree', async () => {
      const durability = {
        onWorktree: vi.fn(async () => true),
        onStage: vi.fn(async () => true),
        beforePublish: vi.fn(async () => true),
        onPublication: vi.fn(async () => false),
      };
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      const result = await executePipeline(makeCtx({ worktreeMode: true, durability }), task(), '/repo');

      expect(result).toMatchObject({ success: false, finalStatus: 'infra_error' });
      expect(result.prUrl).toBe('https://github.com/org/repo/pull/1');
      expect(preserveWorktree).toHaveBeenCalledTimes(1);
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('preserves partial work when the pipeline throws unexpectedly', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      const fp = new EventEmitter() as EventEmitter & { run: ReturnType<typeof vi.fn> };
      fp.run = vi.fn(async () => { throw new Error('adapter process crashed'); });
      createPipelineFromConfig.mockReturnValue(fp);

      await expect(executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo'))
        .rejects.toThrow('adapter process crashed');

      expect(preserveWorktree).toHaveBeenCalledWith(expect.objectContaining({ issueId: 'issue-1' }), 'session did not succeed');
      expect(removeWorktree).not.toHaveBeenCalled();
    });

    it('tolerates a worktree cleanup failure without throwing', async () => {
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      removeWorktree.mockRejectedValueOnce(new Error('rm -rf failed: EBUSY'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await expect(executePipeline(makeCtx({ worktreeMode: true }), task(), '/repo')).resolves.toBeDefined();
      expect(console.warn).toHaveBeenCalledWith('[Worktree] Cleanup failed:', expect.any(Error));
    });
  });

  // ============================================
  // Pipeline event handlers
  // ============================================

  describe('pipeline event handlers', () => {
    it('does not resolve until async event side effects have settled', async () => {
      let releaseComment!: () => void;
      const pendingComment = new Promise<void>((resolve) => { releaseComment = resolve; });
      (taskSourceMock.addComment as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockReturnValueOnce(pendingComment);

      const fp = new EventEmitter() as EventEmitter & { run: ReturnType<typeof vi.fn> };
      fp.run = vi.fn(async () => {
        fp.emit('stage:complete', {
          stage: 'worker',
          result: {
            success: true,
            duration: 1000,
            result: { success: true, summary: 'done', filesChanged: [], commands: [], output: '', confidencePercent: 90 },
          },
          context: { currentIteration: 1 },
        });
        // Deliberately return without a microtask flush. EventEmitter itself
        // never awaits the async listener work.
        return pipelineResult();
      });
      createPipelineFromConfig.mockReturnValue(fp);

      let settled = false;
      const execution = executePipeline(makeCtx(), task(), '/repo').then((result) => {
        settled = true;
        return result;
      });
      await flush();

      expect(taskSourceMock.addComment).toHaveBeenCalledTimes(2);
      expect(settled).toBe(false);

      releaseComment();
      const result = await execution;
      expect(result.finalStatus).toBe('approved');
      expect(settled).toBe(true);
    });

    it('bounds a non-critical event effect that never settles', async () => {
      vi.useFakeTimers();
      try {
        const never = new Promise<void>(() => {});
        const bounded = boundPipelineEffect(never, 'Worker complete audit comment', 10);
        const rejection = expect(bounded).rejects.toThrow('Worker complete audit comment timed out after 10ms');
        await vi.advanceTimersByTimeAsync(10);
        await rejection;
      } finally {
        vi.useRealTimers();
      }
    });

    it('aborts publication and preserves the worktree when a durable stage fence rejects', async () => {
      let rejectFence!: (allowed: boolean) => void;
      const stageFence = new Promise<boolean>((resolve) => { rejectFence = resolve; });
      const durability = {
        onWorktree: vi.fn(async () => true),
        onStage: vi.fn(() => stageFence),
        beforePublish: vi.fn(async () => true),
        onPublication: vi.fn(async () => true),
      };
      createWorktree.mockResolvedValue(worktreeInfoFixture());
      const fp = makeFakePipeline(pipelineResult(), [
        ['stage:start', { stage: 'worker', context: { currentIteration: 1 }, model: 'worker-model' }],
      ]);
      createPipelineFromConfig.mockReturnValue(fp);

      const execution = executePipeline(makeCtx({ worktreeMode: true, durability }), task(), '/repo');
      await flush();
      expect(durability.onStage).toHaveBeenCalledWith('worker');
      expect(commitAndCreatePR).not.toHaveBeenCalled();

      rejectFence(false);
      const result = await execution;

      expect(result).toMatchObject({ success: false, finalStatus: 'infra_error' });
      expect(commitAndCreatePR).not.toHaveBeenCalled();
      expect(preserveWorktree).toHaveBeenCalledTimes(1);
      expect(removeWorktree).not.toHaveBeenCalled();
      const runOptions = fp.run.mock.calls[0][2] as { signal: AbortSignal };
      expect(runOptions.signal.aborted).toBe(true);
      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Durable stage transition failed'), expect.any(Error));
    });

    it('posts a worker-start audit comment only for the worker stage on a task with an issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:start', {
          stage: 'worker',
          context: { currentIteration: 1, config: { roles: { worker: { model: 'worker-model', maxTurns: 8 } } } },
          model: 'worker-model',
        }],
      ]));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.any(String));
    });

    it('does not post a worker-start audit comment when the task has no issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:start', { stage: 'worker', context: { currentIteration: 1 }, model: undefined }],
      ]));

      await executePipeline(makeCtx(), task({ issueId: undefined, issueIdentifier: undefined }), '/repo');

      expect(taskSourceMock.addComment).not.toHaveBeenCalled();
    });

    it('tolerates a worker-start audit comment failure', async () => {
      // First addComment() call is the "Task execution started" sync comment
      // posted before the pipeline runs; the SECOND call is the worker-start
      // audit comment fired (fire-and-forget) from the stage:start listener.
      (taskSourceMock.addComment as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('linear API down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:start', {
          stage: 'worker',
          context: { currentIteration: 1, config: { roles: { worker: { model: 'worker-model' } } } },
          model: 'worker-model',
        }],
      ]));

      await expect(executePipeline(makeCtx(), task(), '/repo')).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Worker start audit comment failed'), expect.any(Error));
    });

    it('includes tester and documenter in the Stages field when those roles are enabled', async () => {
      const getRolesForProject = vi.fn(() => ({
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
        tester: { enabled: true, timeoutMs: 0 },
        documenter: { enabled: true, timeoutMs: 0 },
      }));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ getRolesForProject, reportToDiscord }), task(), '/repo');

      const startEmbed = reportToDiscord.mock.calls
        .map((c) => c[0])
        .find((m): m is EmbedBuilder => m instanceof EmbedBuilder);
      const stagesField = (startEmbed as EmbedBuilder).data.fields?.find((f) => f.name === 'Stages');
      expect(stagesField?.value).toBe('worker → reviewer → tester → documenter');
    });

    it('includes the deterministic tester stage when verify is enabled independently of the tester role', async () => {
      const getRolesForProject = vi.fn(() => ({
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
        tester: { enabled: false, timeoutMs: 0 },
      }));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({
        getRolesForProject,
        reportToDiscord,
        verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
      }), task(), '/repo');

      expect(createPipelineFromConfig.mock.calls[0][7]).toMatchObject({ enabled: true });
      const startEmbed = reportToDiscord.mock.calls
        .map((c) => c[0])
        .find((m): m is EmbedBuilder => m instanceof EmbedBuilder);
      const stagesField = (startEmbed as EmbedBuilder).data.fields?.find((f) => f.name === 'Stages');
      expect(stagesField?.value).toBe('worker → reviewer → tester');
    });

    it('falls back to the directory basename for the pipeline metadata repository name when the task has no Linear project', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task({ linearProject: undefined }), '/repo/OpenSwarm');

      // createPipelineFromConfig's 7th argument is the PipelineRunMetadata built
      // by the (unexported) pipelineMetadata() helper — its `repository` field
      // falls back to repoNameFromPath(projectPath) when there is no Linear
      // project name to use.
      const runMetadata = createPipelineFromConfig.mock.calls[0][6];
      expect(runMetadata).toEqual(expect.objectContaining({ repository: 'OpenSwarm' }));
    });

    it('reports the worker stage result and posts a worker-complete audit comment', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'worker',
          result: {
            success: true,
            duration: 4000,
            result: {
              success: true, summary: 'done', filesChanged: ['a.ts'], commands: [], output: '', confidencePercent: 90,
            },
          },
          context: { currentIteration: 1 },
        }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ reportToDiscord }), task(), '/repo');

      expect(formatWorkReport).toHaveBeenCalled();
      expect(reportToDiscord).toHaveBeenCalledWith('work report');
      expect(taskSourceMock.addComment).toHaveBeenCalledWith('issue-1', expect.any(String));
    });

    it('tolerates a worker-complete audit comment failure', async () => {
      // The first addComment() call is the "Task execution started" sync
      // comment posted before the pipeline runs; only the second call (the
      // worker-complete audit comment, posted from the stage:complete
      // listener under test) should fail.
      (taskSourceMock.addComment as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('linear API down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'worker',
          result: {
            success: true,
            duration: 1000,
            result: { success: true, summary: 'done', filesChanged: [], commands: [], output: '', confidencePercent: 80 },
          },
          context: { currentIteration: 1 },
        }],
      ]));

      await expect(executePipeline(makeCtx(), task(), '/repo')).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Worker complete audit comment failed'), expect.any(Error));
    });

    it('files reviewer follow-ups when autoFileFollowups is enabled and the reviewer approved', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'reviewer',
          result: {
            success: true,
            result: {
              decision: 'approve',
              feedback: 'lgtm',
              recommendedActions: [{ type: 'test', title: 'add edge-case coverage' }],
            },
          },
          context: {},
        }],
      ]));

      await executePipeline(
        makeCtx({ guards: { autoFileFollowups: true } }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.createSubIssue).toHaveBeenCalledWith('issue-1', '[test] add edge-case coverage', expect.any(String), expect.objectContaining({ priority: 3 }));
    });

    it('does not file follow-ups when autoFileFollowups is disabled', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', {
          stage: 'reviewer',
          result: { success: true, result: { decision: 'approve', feedback: 'lgtm', recommendedActions: [{ type: 'test', title: 'x' }] } },
          context: {},
        }],
      ]));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
    });

    it('reports tester and documenter stage results via their dynamic-import branches', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['stage:complete', { stage: 'tester', result: { success: true, result: { success: true, testsPassed: 1, testsFailed: 0, output: 'PASS' } }, context: {} }],
        ['stage:complete', { stage: 'documenter', result: { success: true, result: { success: true, updatedFiles: [], apiDocsUpdated: false, summary: 'ok' } }, context: {} }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ reportToDiscord }), task(), '/repo');

      expect(formatTestReport).toHaveBeenCalled();
      expect(formatDocReport).toHaveBeenCalled();
      expect(reportToDiscord).toHaveBeenCalledWith('test report');
      expect(reportToDiscord).toHaveBeenCalledWith('doc report');
    });

    it('reports a revision:start event to Discord', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['revision:start', { stage: 'worker' }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(makeCtx({ reportToDiscord }), task(), '/repo');

      expect(reportToDiscord).toHaveBeenCalledWith(expect.stringContaining('Revision needed'));
    });

    it('logs a halt to Linear and reports an embed when haltToLinear is enabled', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['halt', { confidence: 35, haltReason: 'uncertain about the edge case', sessionId: 'sess-9', iteration: 2 }],
      ]));
      const reportToDiscord = vi.fn(async () => {});

      await executePipeline(
        makeCtx({ guards: { haltToLinear: true }, reportToDiscord }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.logHalt).toHaveBeenCalledWith('issue-1', 'sess-9', 35, 2, 'uncertain about the edge case');
      const embedCall = reportToDiscord.mock.calls.find((c) => c[0] instanceof EmbedBuilder);
      expect(embedCall).toBeDefined();
    });

    it('does not log halt to Linear when haltToLinear is disabled', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['halt', { confidence: 35, haltReason: 'uncertain', sessionId: 'sess-9', iteration: 2 }],
      ]));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.logHalt).not.toHaveBeenCalled();
    });

    it('tolerates a logHalt failure', async () => {
      (taskSourceMock.logHalt as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult(), [
        ['halt', { confidence: 20, haltReason: 'very uncertain', sessionId: 'sess-1', iteration: 1 }],
      ]));

      await expect(executePipeline(
        makeCtx({ guards: { haltToLinear: true } }),
        task(),
        '/repo',
      )).resolves.toBeDefined();
      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Linear logHalt failed'), expect.any(Error));
    });
  });

  // ============================================
  // Task-state bookkeeping at pipeline start
  // ============================================

  describe('task state bookkeeping at start', () => {
    it('marks the task in-progress and logs pair-start when the task has an issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(markTaskInProgress).toHaveBeenCalled();
      expect(taskSourceMock.logPairStart).toHaveBeenCalledWith('issue-1', expect.any(String), '/repo');
    });

    it('falls back to updateState when logPairStart throws', async () => {
      (taskSourceMock.logPairStart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task(), '/repo');

      expect(taskSourceMock.updateState).toHaveBeenCalledWith('issue-1', 'In Progress');
    });

    it('skips the in-progress bookkeeping entirely when the task has no issueId', async () => {
      createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));

      await executePipeline(makeCtx(), task({ issueId: undefined, issueIdentifier: undefined }), '/repo');

      expect(markTaskInProgress).not.toHaveBeenCalled();
      expect(taskSourceMock.logPairStart).not.toHaveBeenCalled();
    });
  });
});

// ============================================
// Other exported helpers (reporting / state sync)
// ============================================

describe('reportExecutionResult', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    saveCognitiveMemory.mockResolvedValue(undefined);
    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function executorResult(overrides: Partial<ExecutorResult> = {}): ExecutorResult {
    return {
      success: true,
      duration: 5000,
      execution: {
        workflowId: 'wf-1',
        executionId: 'exec-1',
        status: 'completed',
        startedAt: Date.now(),
        stepResults: {
          step1: { stepId: 'step1', status: 'completed', startedAt: Date.now() },
        },
      },
      ...overrides,
    };
  }

  it('reports success and saves a cognitive-memory strategy entry', async () => {
    const reportFn = vi.fn(async () => {});

    await reportExecutionResult(task(), executorResult(), reportFn);

    expect(reportFn).toHaveBeenCalledTimes(1);
    expect(saveCognitiveMemory).toHaveBeenCalledWith('strategy', expect.stringContaining('succeeded'), expect.objectContaining({ derivedFrom: 'issue-1' }));
  });

  it('tolerates a memory-save failure on success', async () => {
    saveCognitiveMemory.mockRejectedValueOnce(new Error('memory store full'));
    const reportFn = vi.fn(async () => {});

    await expect(reportExecutionResult(task(), executorResult(), reportFn)).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Memory save failed'), expect.any(Error));
  });

  it('reports failure with the failed step error as a follow-up message', async () => {
    const reportFn = vi.fn(async () => {});
    const result = executorResult({
      success: false,
      failedStep: 'step1',
      rollbackPerformed: true,
      execution: {
        workflowId: 'wf-1',
        executionId: 'exec-1',
        status: 'failed',
        startedAt: Date.now(),
        stepResults: {
          step1: { stepId: 'step1', status: 'failed', startedAt: Date.now(), error: 'boom: assertion failed' },
        },
      },
    });

    await reportExecutionResult(task(), result, reportFn);

    expect(reportFn).toHaveBeenCalledTimes(2);
    expect(reportFn.mock.calls[1][0]).toEqual(expect.stringContaining('boom: assertion failed'));
    expect(saveCognitiveMemory).not.toHaveBeenCalled();
  });

  it('reports failure without a second message when there is no captured error', async () => {
    const reportFn = vi.fn(async () => {});
    const result = executorResult({
      success: false,
      failedStep: 'step1',
      execution: {
        workflowId: 'wf-1',
        executionId: 'exec-1',
        status: 'failed',
        startedAt: Date.now(),
        stepResults: {
          step1: { stepId: 'step1', status: 'failed', startedAt: Date.now() },
        },
      },
    });

    await reportExecutionResult(task(), result, reportFn);

    expect(reportFn).toHaveBeenCalledTimes(1);
  });
});

describe('requestApproval', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    loadParsedTask.mockResolvedValue(null);
    formatParsedTaskSummary.mockReturnValue('parsed summary');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function decision(overrides: Partial<DecisionResult> = {}): DecisionResult {
    return {
      action: 'execute',
      reason: 'High priority and unblocked.',
      task: task(),
      ...overrides,
    };
  }

  it('does nothing when the decision has no task', async () => {
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision({ task: undefined }), reportFn);

    expect(reportFn).not.toHaveBeenCalled();
  });

  it('reports only the embed when the task has no parsed-task summary on disk', async () => {
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision(), reportFn);

    expect(reportFn).toHaveBeenCalledTimes(1);
    expect(reportFn.mock.calls[0][0]).toBeInstanceOf(EmbedBuilder);
  });

  it('reports the embed plus a parsed-task summary block when one exists', async () => {
    loadParsedTask.mockResolvedValueOnce({
      analysis: { type: 'bugfix', complexity: 'low', estimatedSteps: 2, risks: [] },
    });
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision(), reportFn);

    expect(reportFn).toHaveBeenCalledTimes(2);
    expect(reportFn.mock.calls[1][0]).toEqual(expect.stringContaining('parsed summary'));
  });

  it('skips the parsed-task lookup when the task has no issueId', async () => {
    const reportFn = vi.fn(async () => {});

    await requestApproval(decision({ task: task({ issueId: undefined }) }), reportFn);

    expect(loadParsedTask).not.toHaveBeenCalled();
    expect(reportFn).toHaveBeenCalledTimes(1);
  });
});

describe('reconcileCompletionState', () => {
  let taskSourceMock: ITaskSource;

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    buildTaskStateSyncComment.mockReturnValue('sync comment');
    releaseDependentTasks.mockReturnValue([]);
    completeParentIfChildrenDone.mockReturnValue(null);
    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('does nothing when the task has no issueId', async () => {
    await reconcileCompletionState(task({ issueId: undefined }));

    expect(releaseDependentTasks).not.toHaveBeenCalled();
  });

  it('releases dependent tasks back to Todo', async () => {
    releaseDependentTasks.mockReturnValueOnce([{ issueId: 'child-1' }, { issueId: 'child-2' }]);

    await reconcileCompletionState(task());

    expect(taskSourceMock.updateState).toHaveBeenCalledWith('child-1', 'Todo');
    expect(taskSourceMock.updateState).toHaveBeenCalledWith('child-2', 'Todo');
    expect(taskSourceMock.addComment).toHaveBeenCalledTimes(2);
  });

  it('tolerates a release failure for one child without stopping the others', async () => {
    releaseDependentTasks.mockReturnValueOnce([{ issueId: 'child-1' }, { issueId: 'child-2' }]);
    (taskSourceMock.updateState as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('linear down'))
      .mockResolvedValueOnce(true);

    await reconcileCompletionState(task());

    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release dependent task'), expect.any(Error));
    expect(taskSourceMock.updateState).toHaveBeenCalledTimes(2);
  });

  it('marks the parent Done when all children have completed', async () => {
    completeParentIfChildrenDone.mockReturnValueOnce({ issueId: 'parent-1' });

    await reconcileCompletionState(task());

    expect(taskSourceMock.updateState).toHaveBeenCalledWith('parent-1', 'Done');
    expect(taskSourceMock.addComment).toHaveBeenCalledWith('parent-1', 'sync comment');
  });

  it('tolerates a parent-completion update failure', async () => {
    completeParentIfChildrenDone.mockReturnValueOnce({ issueId: 'parent-1' });
    (taskSourceMock.updateState as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('linear down'));

    await expect(reconcileCompletionState(task())).resolves.toBeUndefined();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to complete parent task'), expect.any(Error));
  });
});

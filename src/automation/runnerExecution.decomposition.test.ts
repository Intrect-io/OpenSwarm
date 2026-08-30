// ============================================
// OpenSwarm - decomposition limit enforcement
// ============================================
//
// Split out of runnerExecution.coverage.test.ts, which sits 7 lines under the
// 1500-line pre-commit cap and could not take these. The mock harness below is
// copied rather than imported because `vi.mock()` calls are hoisted per file and
// cannot be shared through one — the same reason runnerExecution.overlap.test.ts
// and runnerExecution.integration.coverage.test.ts each carry their own.
//
// Subject: the two caps an operator sets on the planner — how many sub-issues a
// single task may end up with, and how many issues may be created in a day.
// (AGT-4122)

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { DraftAnalysis } from '../agents/draftAnalyzer.js';
import type { ITaskSource } from './taskSource.js';
import type { ExecutionContext } from './runnerExecution.js';

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
  commitAndCreatePRWithHead: commitAndCreatePR,
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
let setTaskSource: typeof import('./runnerExecution.js')['setTaskSource'];

beforeAll(async () => {
  const mod = await import('./runnerExecution.js');
  executePipeline = mod.executePipeline;
  setTaskSource = mod.setTaskSource;
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

describe('decomposition limits', () => {
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
    // The budget is a shared counter: the production reserve is atomic, so tests
    // drive admission through it rather than through the pre-planner read.
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

    commitAndCreatePR.mockResolvedValue({
      prUrl: 'https://github.com/org/repo/pull/1',
      headSha: 'published-head',
    });
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

  beforeEach(() => {
    // Every case here either refuses the decomposition and falls through to the
    // real pipeline, or decomposes and never reaches it. Both need the factory to
    // hand back a usable fake, since executePipeline attaches listeners to it
    // unconditionally.
    createPipelineFromConfig.mockReturnValue(makeFakePipeline(pipelineResult()));
    taskSourceMock = makeTaskSource();
    setTaskSource(taskSourceMock);
  });

  // AGT-4122: maxChildrenPerTask used to gate only a task that already had
    // children, so a planner returning more than the cap created all of them —
    // measured at 9 against a configured 3. Refusing rather than truncating is
    // what keeps the parent honest: a truncated plan would look decomposed with
    // part of its scope silently dropped.
    it('refuses a plan over the children cap and executes directly instead of truncating it', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'first', estimatedMinutes: 20, priority: 2 },
          { title: 'Sub 2', description: 'second', estimatedMinutes: 20, priority: 2 },
          { title: 'Sub 3', description: 'third', estimatedMinutes: 20, priority: 2 },
        ],
        totalEstimatedMinutes: 60,
      });

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true, decompositionMaxChildren: 2 }),
        task(),
        '/repo',
      );

      // Not one sub-issue: refusing is all-or-nothing, so no partial tree is left
      // behind for a later run to mistake for a completed decomposition.
      expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
      expect(registerDecomposition).not.toHaveBeenCalled();
      expect(result.finalStatus).not.toBe('decomposed');
      // Falling through to direct execution is the documented behaviour of the
      // daily-limit branch, and this matches it rather than failing the task.
      expect(createPipelineFromConfig).toHaveBeenCalledTimes(1);
    });

    // Caught by the commit-gate review: comparing only the plan let a parent that
    // already had children below the cap sail past it — 2 existing + 2 planned
    // reaches 4 under a cap of 3, because the earlier gate only refuses a parent
    // that has ALREADY hit the cap.
    it('counts existing children toward the cap, not just the new plan', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getChildrenCount.mockReturnValue(2);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 3', description: 'third', estimatedMinutes: 20, priority: 2 },
          { title: 'Sub 4', description: 'fourth', estimatedMinutes: 20, priority: 2 },
        ],
        totalEstimatedMinutes: 40,
      });

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true, decompositionMaxChildren: 3 }),
        task(),
        '/repo',
      );

      expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
      expect(result.finalStatus).not.toBe('decomposed');
      getChildrenCount.mockReturnValue(0);
    });

    // Caught by the PR review: the pre-check before planning only asks whether ONE
  // slot is free, so a cap of 5 with 4 already spent still admitted a plan of 3.
  it('refuses a plan that would overrun the remaining daily budget', async () => {
    plannerNeedsDecomposition.mockReturnValue(true);
    getDailyCreationCount.mockReturnValue(4);
    canCreateMoreIssues.mockReturnValue(true); // one slot free — the old check passed here
    // Stand in for the real counter so the assertion below proves the runner
    // asks for the number of slots it will actually spend.
    reserveDailyCreations.mockImplementation((count: number, limit: number) => 4 + count <= limit);
    plannerRunPlanner.mockResolvedValue({
      success: true,
      originalIssue: 'issue-1',
      needsDecomposition: true,
      subTasks: [
        { title: 'Sub 1', description: 'first', estimatedMinutes: 20, priority: 2 },
        { title: 'Sub 2', description: 'second', estimatedMinutes: 20, priority: 2 },
        { title: 'Sub 3', description: 'third', estimatedMinutes: 20, priority: 2 },
      ],
      totalEstimatedMinutes: 60,
    });

    const result = await executePipeline(
      makeCtx({ enableDecomposition: true, decompositionMaxChildren: 5, decompositionDailyLimit: 5 }),
      task(),
      '/repo',
    );

    expect(reserveDailyCreations).toHaveBeenCalledWith(3, 5);
    expect(taskSourceMock.createSubIssue).not.toHaveBeenCalled();
    expect(result.finalStatus).not.toBe('decomposed');
    // A refused plan must not leave a hold on the shared budget.
    expect(releaseDailyReservation).not.toHaveBeenCalled();
    getDailyCreationCount.mockReturnValue(0);
  });

  it('admits a plan that exactly fills the remaining daily budget', async () => {
    plannerNeedsDecomposition.mockReturnValue(true);
    getDailyCreationCount.mockReturnValue(3);
    reserveDailyCreations.mockImplementation((count: number, limit: number) => 3 + count <= limit);
    plannerRunPlanner.mockResolvedValue({
      success: true,
      originalIssue: 'issue-1',
      needsDecomposition: true,
      subTasks: [
        { title: 'Sub 1', description: 'first', estimatedMinutes: 20, priority: 2 },
        { title: 'Sub 2', description: 'second', estimatedMinutes: 20, priority: 2 },
      ],
      totalEstimatedMinutes: 40,
    });
    let n = 0;
    (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
      async (_p: string, title: string) => ({ id: `day-${++n}`, identifier: `INT-40${n}`, title }),
    );

    const result = await executePipeline(
      makeCtx({ enableDecomposition: true, decompositionMaxChildren: 5, decompositionDailyLimit: 5 }),
      task(),
      '/repo',
    );

    expect(result.finalStatus).toBe('decomposed');
    expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
    // The hold is settled once the real count has been recorded, so a later
    // decomposition sees the truth rather than the reservation.
    expect(releaseDailyReservation).toHaveBeenCalledWith(2);
    getDailyCreationCount.mockReturnValue(0);
  });

  // The recovery path is the one case where the two must NOT be added: the
    // plan re-proposes the children that already exist, and they are deduped by
    // idempotencyId, so summing them would refuse a resume that adds nothing.
    it('does not double-count when resuming an interrupted decomposition', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      getChildrenCount.mockReturnValue(2);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'first', estimatedMinutes: 20, priority: 2 },
          { title: 'Sub 2', description: 'second', estimatedMinutes: 20, priority: 2 },
        ],
        totalEstimatedMinutes: 40,
      });
      let resumed = 0;
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => ({ id: `res-${++resumed}`, identifier: `INT-30${resumed}`, title }),
      );

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true, decompositionMaxChildren: 3 }),
        { ...task(), linearState: 'In Progress' },
        '/repo',
      );

      expect(result.finalStatus).toBe('decomposed');
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
      getChildrenCount.mockReturnValue(0);
    });

    it('still decomposes a plan that sits exactly on the cap', async () => {
      plannerNeedsDecomposition.mockReturnValue(true);
      plannerRunPlanner.mockResolvedValue({
        success: true,
        originalIssue: 'issue-1',
        needsDecomposition: true,
        subTasks: [
          { title: 'Sub 1', description: 'first', estimatedMinutes: 20, priority: 2 },
          { title: 'Sub 2', description: 'second', estimatedMinutes: 20, priority: 2 },
        ],
        totalEstimatedMinutes: 40,
      });
      let onCap = 0;
      (taskSourceMock.createSubIssue as ReturnType<typeof vi.fn>).mockImplementation(
        async (_parentId: string, title: string) => ({ id: `cap-${++onCap}`, identifier: `INT-20${onCap}`, title }),
      );

      const result = await executePipeline(
        makeCtx({ enableDecomposition: true, decompositionMaxChildren: 2 }),
        task(),
        '/repo',
      );

      expect(result.finalStatus).toBe('decomposed');
      expect(taskSourceMock.createSubIssue).toHaveBeenCalledTimes(2);
    });

});

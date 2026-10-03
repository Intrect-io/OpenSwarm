import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';

const {
  runDraftAnalysis,
  findOpenPRFileOverlaps,
  createWorktree,
  loadAuthoritativeOperatorFeedback,
} = vi.hoisted(() => ({
  runDraftAnalysis: vi.fn(),
  findOpenPRFileOverlaps: vi.fn(),
  createWorktree: vi.fn(),
  loadAuthoritativeOperatorFeedback: vi.fn(),
}));

vi.mock('../agents/draftAnalyzer.js', () => ({ runDraftAnalysis }));
vi.mock('../coordination/operatorGuidance.js', () => ({ loadAuthoritativeOperatorFeedback }));
vi.mock('../support/worktreeManager.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../support/worktreeManager.js')>()),
  findOpenPRFileOverlaps,
  createWorktree,
}));

import {
  executePipeline,
  runPreAdmissionDraft,
  setTaskSource,
  type ExecutionContext,
} from './runnerExecution.js';

describe('executePipeline open-PR preflight (INT-2568)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadAuthoritativeOperatorFeedback.mockReturnValue(undefined);
    runDraftAnalysis.mockResolvedValue({
      taskType: 'bugfix', relevantFiles: ['src/subtraction.rs'], durationMs: 7,
      intentSummary: 'fix subtraction', completionCriteria: [], sufficient: true,
    });
    findOpenPRFileOverlaps.mockResolvedValue([
      { number: 16, url: 'https://example.test/16', label: 'PR #16', files: ['src/subtraction.rs'] },
    ]);
  });

  it('returns before worktree creation without posting repeat-prone tracker comments', async () => {
    const addComment = vi.fn(async () => {});
    const getExecutionComments = vi.fn(async () => [
      { createdAt: '2026-07-07T12:47:00Z', body: 'human root cause: wrapper null-mData' },
    ]);
    setTaskSource({ kind: 'local', addComment, getExecutionComments } as unknown as ITaskSource);
    const task: TaskItem = {
      id: 'task-overlap', source: 'linear', issueId: 'issue-overlap', issueIdentifier: 'INT-overlap',
      title: 'Fix subtraction', priority: 3, createdAt: Date.now(),
    };
    const ctx = {
      allowedProjects: ['/repo'], enableDraftAnalysis: true, enableDecomposition: false, worktreeMode: true,
    } as ExecutionContext;

    const first = await executePipeline(ctx, task, '/repo');
    const second = await executePipeline(ctx, task, '/repo');

    expect(first).toMatchObject({ success: true, finalStatus: 'superseded', iterations: 0 });
    expect(second.finalStatus).toBe('superseded');
    expect(createWorktree).not.toHaveBeenCalled();
    expect(addComment).not.toHaveBeenCalled();
    expect(createWorktree).not.toHaveBeenCalled();
    expect(runDraftAnalysis.mock.calls[0][0].taskDescription).toContain('wrapper null-mData');
  });

  it('continues with the original description when fresh comment lookup fails', async () => {
    setTaskSource({
      kind: 'local', addComment: vi.fn(),
      getExecutionComments: vi.fn(async () => { throw new Error('Linear unavailable'); }),
    } as unknown as ITaskSource);
    const task: TaskItem = {
      id: 'task-comment-fallback', source: 'linear', issueId: 'issue-comment-fallback', issueIdentifier: 'INT-comment-fallback',
      title: 'Fallback task', description: 'original diagnosis', priority: 3, createdAt: Date.now(),
    };
    const ctx = { allowedProjects: ['/repo'], enableDraftAnalysis: true, enableDecomposition: false, worktreeMode: true } as ExecutionContext;

    await executePipeline(ctx, task, '/repo');

    expect(runDraftAnalysis.mock.calls[0][0].taskDescription).toBe('original diagnosis');
  });

  it('injects durable operator feedback into a pre-admission draft', async () => {
    const guidance = 'Operator answer: monthly_cutoff is canonical.';
    loadAuthoritativeOperatorFeedback.mockReturnValue(guidance);
    setTaskSource({
      kind: 'local',
      getExecutionComments: vi.fn(async () => []),
    } as unknown as ITaskSource);
    const candidate: TaskItem = {
      id: 'task-guidance', source: 'linear', issueId: 'issue-guidance',
      issueIdentifier: 'AX-guidance', title: 'Use the current decision',
      description: 'Stale issue: add due_date.', priority: 2, createdAt: Date.now(),
    };

    await runPreAdmissionDraft({
      allowedProjects: ['/repo'], enableDraftAnalysis: true,
    } as ExecutionContext, candidate, '/repo');

    expect(loadAuthoritativeOperatorFeedback).toHaveBeenCalledWith('issue-guidance');
    expect(runDraftAnalysis).toHaveBeenCalledWith(expect.objectContaining({
      taskDescription: 'Stale issue: add due_date.',
      authoritativeOperatorFeedback: guidance,
    }));
    expect(candidate.authoritativeOperatorFeedback).toBe(guidance);
  });

  it('reuses a sufficient pre-admission draft in the pipeline', async () => {
    const task: TaskItem = {
      id: 'cached', issueId: 'cached', issueIdentifier: 'INT-cached',
      source: 'linear', title: 'Cached draft', priority: 2, createdAt: 1,
      fileScope: ['src/subtraction.rs'], fileScopeSource: 'drafted',
      preAdmissionDraft: await runDraftAnalysis(),
    };
    runDraftAnalysis.mockClear();

    const result = await executePipeline({
      allowedProjects: ['/repo'], worktreeMode: true, enableDecomposition: false,
    } as ExecutionContext, task, '/repo');

    expect(result.finalStatus).toBe('superseded');
    expect(runDraftAnalysis).not.toHaveBeenCalled();
  });
});

describe('executePipeline project goal (AGT-4662)', () => {
  const goal = 'Reconcile ledgers in dependency order, to a usable level.';
  const decline = {
    taskType: 'feature', relevantFiles: [], durationMs: 7, intentSummary: '', completionCriteria: [], sufficient: false,
    scope: {
      applicable: false, kind: 'wrong_repository', confidence: 0.95,
      reason: 'The runtime this task names lives in kyte-portal.',
      evidence: ['no bin/kyte-chat-daemon here', 'no KYTE_PYTHON reference here'],
    },
  };
  const task: TaskItem = {
    id: 'task-goal', source: 'linear', issueId: 'issue-goal', issueIdentifier: 'AX-goal',
    title: 'Fix kyte interpreter paths', priority: 2, createdAt: Date.now(),
  };
  const baseCtx = { allowedProjects: ['/repo'], enableDraftAnalysis: true, enableDecomposition: false, worktreeMode: true };

  beforeEach(() => {
    vi.clearAllMocks();
    loadAuthoritativeOperatorFeedback.mockReturnValue(undefined);
    findOpenPRFileOverlaps.mockResolvedValue([]);
    createWorktree.mockRejectedValue(new Error('worktree reached'));
  });

  it('gives the project goal to both the pre-admission draft and the in-pipeline draft', async () => {
    runDraftAnalysis.mockResolvedValue({ ...decline, scope: undefined });
    const ctx = { ...baseCtx, getProjectGoal: vi.fn(() => goal) } as unknown as ExecutionContext;

    await runPreAdmissionDraft(ctx, task, '/repo');
    await executePipeline(ctx, task, '/repo');

    expect(runDraftAnalysis).toHaveBeenCalledTimes(2);
    for (const [options] of runDraftAnalysis.mock.calls) expect(options.projectGoal).toBe(goal);
    expect(ctx.getProjectGoal).toHaveBeenCalledWith('/repo');
  });

  it('stops a declined task before any worktree is created when the project has a goal', async () => {
    runDraftAnalysis.mockResolvedValue(decline);
    const result = await executePipeline({ ...baseCtx, getProjectGoal: () => goal } as unknown as ExecutionContext, task, '/repo');
    expect(result).toMatchObject({ success: true, finalStatus: 'superseded', iterations: 0 });
    expect(result.failureDetail).toContain('wrong_repository');
    expect(createWorktree).not.toHaveBeenCalled();
  });

  it('does not stop the same task in a project with no goal', async () => {
    runDraftAnalysis.mockResolvedValue(decline);
    const result = await executePipeline(baseCtx as unknown as ExecutionContext, task, '/repo');
    expect(result.finalStatus).not.toBe('superseded');
    expect(createWorktree).toHaveBeenCalled();
  });
});

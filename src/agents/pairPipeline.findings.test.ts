import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const runDocumenter = vi.fn();
const runAuditor = vi.fn();
const broadcastEvent = vi.fn();
const getDefaultModel = vi.fn();

// Override runWorker only; keep the real pure helpers (e.g. resolveWorkerBashTimeoutMs
// the worker stage now calls to set bashTimeoutMs — INT-2415).
vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

vi.mock('./reviewer.js', async () => {
  const actual = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
  return {
    ...actual,
    runReviewer,
  };
});

vi.mock('./documenter.js', async () => {
  const actual = await vi.importActual<typeof import('./documenter.js')>('./documenter.js');
  return { ...actual, runDocumenter };
});

vi.mock('./auditor.js', async () => {
  const actual = await vi.importActual<typeof import('./auditor.js')>('./auditor.js');
  return { ...actual, runAuditor };
});

vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../memory/repoKnowledge.js', () => ({
  recallRepoKnowledge: vi.fn().mockResolvedValue([]),
}));

vi.mock('../core/eventHub.js', () => ({
  broadcastEvent,
}));

const boardEvents = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>> }));
vi.mock('../coordination/runCoordination.js', () => ({
  publishCoordination: vi.fn(async (event: Record<string, unknown>) => { boardEvents.list.push(event); }),
}));

vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

// Split from pairPipeline.test.ts (LOC cap); same mocks.
// AGT-4535: per-finding ids in the revise loop. Same mocks as the blocker tests.
describe('PairPipeline finding ledger', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getDefaultModel.mockResolvedValue('codex-live-model');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function task(overrides: Partial<TaskItem> = {}): TaskItem {
    return {
      id: 'task-findings',
      source: 'linear',
      title: 'findings task',
      description: 'exercise the finding ledger',
      priority: 1,
      createdAt: Date.now(),
      estimatedMinutes: 60,
      ...overrides,
    };
  }

  const config = (maxIterations: number, maxFindingRounds?: number) => ({
    stages: ['worker', 'reviewer'] as ('worker' | 'reviewer')[],
    maxIterations,
    maxFindingRounds,
    roles: {
      worker: { enabled: true, model: 'w', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'r', timeoutMs: 0 },
    },
  });

  const worked = (summary: string) => ({
    success: true, summary, filesChanged: ['src/a.ts'], commands: ['npm test'], output: '', confidencePercent: 100,
  });

  it('asks the worker to answer each id and shows the reviewer those answers', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker
      .mockResolvedValueOnce(worked('first pass'))
      .mockResolvedValue(worked('F1: fixed — src/a.ts:12 checks the bound'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'one problem', issues: ['range() stops one short'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'F1: resolved' });

    const result = await new PairPipeline(config(5)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('approved');
    const second = runWorker.mock.calls[1][0] as WorkerOptions;
    expect(second.previousFeedback).toContain('- F1: range() stops one short');
    expect(second.previousFeedback).toContain('F<n>: disputed');
    const reviewerSecond = runReviewer.mock.calls[1][0] as ReviewerOptions;
    expect(reviewerSecond.findingLedger).toContain('worker said fixed (round 2): src/a.ts:12 checks the bound');
  });

  it('stops — never approves — when worker and reviewer deadlock on one id', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker
      .mockResolvedValueOnce(worked('first pass'))
      .mockResolvedValue(worked('F1: disputed — README.md:4 says the bound is exclusive'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'bound', issues: ['bound is wrong'] })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: open', issues: ['F1: still wrong, README is stale'] })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: open', issues: ['F1: still wrong'] })
      .mockResolvedValue({ decision: 'approve', feedback: 'fine' });

    const result = await new PairPipeline(config(10, 10)).run(task(), process.cwd());

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(runReviewer).toHaveBeenCalledTimes(3);
    expect(runWorker).toHaveBeenCalledTimes(3);
    expect(result.lastReviewFeedback).toContain('Review loop stopped (deadlock)');
  });

  it('stops at the round cap while an id stays open', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker.mockResolvedValue(worked('tried'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'a', issues: ['missing null check'] })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'F1: still open — null check absent', issues: [] })
      .mockResolvedValue({ decision: 'approve', feedback: 'fine' });

    const result = await new PairPipeline(config(10, 2)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('failed');
    expect(runReviewer).toHaveBeenCalledTimes(2);
    expect(result.lastReviewFeedback).toContain('Review loop stopped (round_cap)');
  });

  it('keeps the old free-text path when the reviewer gives no structured issues', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    runWorker.mockResolvedValue(worked('tried'));
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'tighten the loop' })
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'handle the empty case' })
      .mockResolvedValue({ decision: 'approve', feedback: 'ok' });

    const result = await new PairPipeline(config(5, 1)).run(task(), process.cwd());

    expect(result.finalStatus).toBe('approved');
    const second = runWorker.mock.calls[1][0] as WorkerOptions;
    expect(second.previousFeedback).not.toContain('Open review findings');
  });
});

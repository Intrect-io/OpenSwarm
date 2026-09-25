import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
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


const gitTracker = vi.hoisted(() => ({ isGitRepo: vi.fn(async () => true), takeSnapshot: vi.fn(async () => 'run-start-tree') }));
vi.mock('../support/gitTracker.js', async () => {
  const actual = await vi.importActual<typeof import('../support/gitTracker.js')>('../support/gitTracker.js');
  return { ...actual, ...gitTracker };
});

// AGT-4534, measured on a real run: iteration 1 fixed the code, the
// reviewer asked only for a better report, iteration 2 supplied it without a
// new edit and was failed for "no changed files". Every iteration now gets
// the tree the run started from, so earlier iterations' edits still count.
describe('PairPipeline run-start snapshot', () => {
  const pipelineConfig = {
    stages: ['worker', 'reviewer'] as ('worker' | 'reviewer')[],
    maxIterations: 3,
    roles: {
      worker: { enabled: true, model: 'w', timeoutMs: 0 },
      reviewer: { enabled: true, model: 'r', timeoutMs: 0 },
    },
  };
  const task = (): TaskItem => ({
    id: 'task-1', source: 'linear', title: 'confirm bounds', description: 'summarise',
    priority: 1, createdAt: Date.now(), estimatedMinutes: 60,
  });

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    getDefaultModel.mockResolvedValue('m');
    runWorker.mockResolvedValue({ success: true, summary: 'done', filesChanged: ['src/bounds.mjs'], commands: ['node --test'], output: '', confidencePercent: 100 });
    runReviewer
      .mockResolvedValueOnce({ decision: 'revise', feedback: 'fix is right; add the summary' })
      .mockResolvedValue({ decision: 'approve', feedback: 'ok' });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it('hands every iteration the snapshot taken once when the run started', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');

    await new PairPipeline(pipelineConfig).run(task(), process.cwd());

    expect(runWorker).toHaveBeenCalledTimes(2);
    const hashes = runWorker.mock.calls.map((call) => (call[0] as WorkerOptions).runSnapshotHash);
    expect(hashes).toEqual(['run-start-tree', 'run-start-tree']);
    expect(gitTracker.takeSnapshot).toHaveBeenCalledTimes(1);
  });

  it('runs without it, as before, when the snapshot cannot be taken', async () => {
    gitTracker.takeSnapshot.mockRejectedValueOnce(new Error('index.lock exists'));
    const { PairPipeline } = await import('./pairPipeline.js');

    const result = await new PairPipeline(pipelineConfig).run(task(), process.cwd());

    expect((runWorker.mock.calls[0][0] as WorkerOptions).runSnapshotHash).toBeUndefined();
    expect(result.finalStatus).toBe('approved');
  });
});

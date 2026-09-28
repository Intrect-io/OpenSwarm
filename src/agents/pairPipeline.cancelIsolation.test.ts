// Regression: the per-run abort/stuck controls live in AsyncLocalStorage, so a
// run() call can no longer observe or overwrite another run's cancellation
// state. Before the fix both were instance fields, and the second run's already
// aborted signal made the FIRST run cancel itself at its next stage boundary.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();
const broadcastEvent = vi.fn();
const getDefaultModel = vi.fn();
const hasRepoSnapshot = vi.fn();
const scanAndCache = vi.fn();
const analyzeIssue = vi.fn();
const recallRepoKnowledge = vi.fn();

vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});
vi.mock('./tester.js', async () => {
  const actual = await vi.importActual<typeof import('./tester.js')>('./tester.js');
  return { ...actual, runTester: vi.fn() };
});
vi.mock('../knowledge/index.js', () => ({ hasRepoSnapshot, scanAndCache, analyzeIssue, recallRepoKnowledge }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent }));
vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

describe('PairPipeline concurrent run isolation', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    hasRepoSnapshot.mockReturnValue(true);
    scanAndCache.mockResolvedValue(undefined);
    analyzeIssue.mockResolvedValue(undefined);
    recallRepoKnowledge.mockResolvedValue([]);
    getDefaultModel.mockResolvedValue('model');
    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/a.ts'],
      commands: [],
      output: '',
      confidencePercent: 95,
    });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); });

  function task(id: string): TaskItem {
    return { id, source: 'linear', title: id, description: 'd', priority: 1, createdAt: Date.now(), estimatedMinutes: 30 };
  }

  it('does not cancel a run just because a concurrent run on the same instance is aborted', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 2,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    let releaseFirstCall: () => void = () => {};
    const firstCallGate = new Promise<void>((resolve) => { releaseFirstCall = resolve; });
    let workerCalls = 0;
    runWorker.mockImplementation(async () => {
      workerCalls++;
      if (workerCalls === 1) await firstCallGate;
      return {
        success: true,
        summary: 'done',
        filesChanged: ['src/a.ts'],
        commands: [],
        output: '',
        confidencePercent: 95,
      };
    });

    const first = pipeline.run(task('TASK-A'), process.cwd());

    // A second run on the SAME instance that is already cancelled. It must not
    // install its aborted signal anywhere the first run can read it.
    const controller = new AbortController();
    controller.abort();
    const second = await pipeline.run(task('TASK-B'), process.cwd(), { signal: controller.signal });
    expect(second.finalStatus).toBe('cancelled');

    releaseFirstCall();
    const firstResult = await first;
    expect(firstResult.finalStatus).not.toBe('cancelled');
    expect(firstResult.success).toBe(true);
  });
});

// Purpose: the project goal reaches the worker and reviewer calls through the pipeline (AGT-4662)
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const getDefaultModel = vi.fn();

vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});
vi.mock('./reviewer.js', async () => {
  const actual = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
  return { ...actual, runReviewer };
});
vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn().mockResolvedValue([]) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../coordination/runCoordination.js', () => ({ publishCoordination: vi.fn(async () => undefined) }));
vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

describe('PairPipeline project goal (AGT-4662)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    runWorker.mockResolvedValue({
      success: true, summary: 'done', filesChanged: ['src/example.ts'],
      commands: ['npm test -- src/example.test.ts'], output: '', confidencePercent: 100,
    });
    runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'approved' });
    getDefaultModel.mockResolvedValue('codex-live-model');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  const task = (): TaskItem => ({
    id: 'task-1', source: 'linear', title: 'heavy task', description: 'd',
    priority: 1, createdAt: Date.now(), estimatedMinutes: 60,
  });
  const roles = {
    worker: { enabled: true, model: 'w', timeoutMs: 0 },
    reviewer: { enabled: true, model: 'r', timeoutMs: 0 },
  };

  it('hands the project goal to the worker and reviewer, and leaves it unset otherwise', async () => {
    const { PairPipeline, createPipelineFromConfig } = await import('./pairPipeline.js');

    const withGoal = new PairPipeline({
      stages: ['worker', 'reviewer'], maxIterations: 1, roles,
      projectGoal: 'Reconcile ledgers in dependency order.',
    });
    expect((await withGoal.run(task(), process.cwd())).success).toBe(true);
    expect(runWorker).toHaveBeenCalledWith(expect.objectContaining<Partial<WorkerOptions>>({
      projectGoal: 'Reconcile ledgers in dependency order.',
    }));
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining<Partial<ReviewerOptions>>({
      projectGoal: 'Reconcile ledgers in dependency order.',
    }));

    runWorker.mockClear();
    const without = new PairPipeline({ stages: ['worker'], maxIterations: 1, roles });
    await without.run(task(), process.cwd());
    expect((runWorker.mock.calls[0][0] as WorkerOptions).projectGoal).toBeUndefined();

    // The factory's last argument lands on the pipeline config, which is what the runner calls.
    const built = createPipelineFromConfig(
      roles, 1, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined, 'From the factory.',
    ) as unknown as { config: { projectGoal?: string } };
    expect(built.config.projectGoal).toBe('From the factory.');
  });
});

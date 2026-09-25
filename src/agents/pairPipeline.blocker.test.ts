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
describe('PairPipeline worker blocker claims', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/example.ts'],
      commands: ['npm test -- src/example.test.ts'],
      output: '',
      confidencePercent: 100,
    });
    runReviewer.mockResolvedValue({
      decision: 'approve',
      feedback: 'approved',
    });
    getDefaultModel.mockResolvedValue('codex-live-model');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function task(overrides: Partial<TaskItem> = {}): TaskItem {
    return {
      id: 'task-1',
      source: 'linear',
      title: 'heavy task',
      description: 'exercise job profile model routing',
      priority: 1,
      createdAt: Date.now(),
      estimatedMinutes: 60,
      ...overrides,
    };
  }

  // AGT-4535: measured on a real run, a worker that stopped with a precise,
  // evidenced "the definition of done is unsatisfiable" (as its prompt tells it
  // to) was treated as a quality failure and blindly retried twice. A no-edit
  // blocker claim now goes to the reviewer once, as a claim to verify.
    const blocker = {
      success: false,
      summary: 'Blocked: the two tests assert range(1,3) == [1,2,3] and == [1,2]; no implementation satisfies both.',
      filesChanged: [],
      commands: ['node --test test/range.test.mjs'],
      output: '',
      haltReason: 'DoD unsatisfiable: test/range.test.mjs:7 and :11 contradict each other',
    };
    const pipelineConfig = {
      stages: ['worker', 'reviewer'] as ('worker' | 'reviewer')[],
      maxIterations: 3,
      roles: {
        worker: { enabled: true, model: 'w', timeoutMs: 0 },
        reviewer: { enabled: true, model: 'r', timeoutMs: 0 },
      },
    };

    it('parks for the operator, without retrying, when the reviewer confirms the blocker', async () => {
      const { PairPipeline } = await import('./pairPipeline.js');
      runWorker.mockResolvedValue(blocker);
      runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'Confirmed: test/range.test.mjs:7 expects [1,2,3], :11 expects [1,2].' });

      const result = await new PairPipeline(pipelineConfig).run(task(), process.cwd());

      expect(runWorker).toHaveBeenCalledTimes(1);
      expect(runReviewer).toHaveBeenCalledTimes(1);
      // The reviewer is asked to verify the claim, not to review a diff.
      const reviewed = runReviewer.mock.calls[0][0] as ReviewerOptions;
      expect(reviewed.mode).toBe('blocker');
      expect(reviewed.blockerClaim).toContain('DoD unsatisfiable');
      expect(result.success).toBe(false);
      expect(result.finalStatus).toBe('waiting_on_operator');
      expect(result.operatorPark?.code).toBe('verified_worker_blocker');
      expect(result.operatorPark?.reason).toContain('DoD unsatisfiable');
      expect(result.operatorPark?.reason).toContain('Confirmed: test/range.test.mjs:7');
      expect(result.operatorPark!.reason.length).toBeLessThan(1400);
    });

    it('sends a refuted blocker back to the worker as review feedback', async () => {
      const { PairPipeline } = await import('./pairPipeline.js');
      runWorker
        .mockResolvedValueOnce(blocker)
        .mockResolvedValue({ success: true, summary: 'fixed', filesChanged: ['src/a.ts'], commands: ['npm test'], output: '', confidencePercent: 100 });
      runReviewer
        .mockResolvedValueOnce({ decision: 'revise', feedback: 'Not a blocker: test :11 was deleted on main; only :7 applies.' })
        .mockResolvedValue({ decision: 'approve', feedback: 'ok' });

      const result = await new PairPipeline(pipelineConfig).run(task(), process.cwd());

      expect(result.finalStatus).toBe('approved');
      expect(runWorker).toHaveBeenCalledTimes(2);
      const second = runWorker.mock.calls[1][0] as WorkerOptions;
      expect(second.previousFeedback).toContain('Not a blocker');
    });

    it('verifies a blocker only once per run, then retries as before', async () => {
      const { PairPipeline } = await import('./pairPipeline.js');
      runWorker.mockResolvedValue(blocker);
      runReviewer.mockResolvedValue({ decision: 'revise', feedback: 'Not a blocker.' });

      await new PairPipeline(pipelineConfig).run(task(), process.cwd());

      // One verification; the dialogue does not loop on the same claim.
      expect(runReviewer).toHaveBeenCalledTimes(1);
      expect(runWorker).toHaveBeenCalledTimes(3);
    });

    it('falls back to retrying when the verification itself fails', async () => {
      const { PairPipeline } = await import('./pairPipeline.js');
      runWorker.mockResolvedValue(blocker);
      runReviewer.mockRejectedValue(new Error('reviewer adapter down'));

      const result = await new PairPipeline(pipelineConfig).run(task(), process.cwd());

      expect(result.operatorPark).toBeUndefined();
      expect(runWorker).toHaveBeenCalledTimes(3);
    });

    it('does not treat a stop on a later iteration as a no-edit claim', async () => {
      const { PairPipeline } = await import('./pairPipeline.js');
      runWorker
        .mockResolvedValueOnce({ success: true, summary: 'partial', filesChanged: ['src/a.ts'], commands: ['npm test'], output: '', confidencePercent: 100 })
        .mockResolvedValue(blocker);
      runReviewer.mockResolvedValue({ decision: 'revise', feedback: 'missing case' });

      await new PairPipeline(pipelineConfig).run(task(), process.cwd());

      // Only the real review of iteration 1 — no blocker verification later.
      for (const call of runReviewer.mock.calls) expect((call[0] as ReviewerOptions).mode).not.toBe('blocker');
    });

    it('does not treat an adapter error as a blocker claim', async () => {
      const { PairPipeline } = await import('./pairPipeline.js');
      runWorker.mockResolvedValue({ ...blocker, error: 'ollama-cloud request failed: 502', haltReason: undefined });

      await new PairPipeline(pipelineConfig).run(task(), process.cwd());

      expect(runReviewer).not.toHaveBeenCalled();
    });
  });

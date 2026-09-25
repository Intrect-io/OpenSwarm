// ============================================
// OpenSwarm - a retry is told which paths the fence already rejected (AGT-4451)
//
// AX-1556, 2026-09-18: the reviewer demanded a change to a file outside the
// worker's declared write scope. Three successive workers tried to comply and
// were each failed by the fence, the third having otherwise addressed every
// point raised, and the task exhausted its iterations with the real blocker
// untouched. These pin that the next worker is told, and that the telling is
// sourced from the rejected-path registry — which survives the fresh-context
// retry that wiped this memory before.
// ============================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();

vi.mock('./worker.js', async () => ({
  ...(await vi.importActual<typeof import('./worker.js')>('./worker.js')),
  runWorker,
}));
vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn().mockResolvedValue([]) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../adapters/index.js', async () => ({
  ...(await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js')),
  getAdapter: () => ({ getDefaultModel: vi.fn().mockResolvedValue('default-model') }),
}));

function task(): TaskItem {
  return {
    id: 'scope-fence-task',
    source: 'linear',
    title: 'A2 adapter',
    description: 'exercise the scope-fence guidance',
    priority: 1,
    createdAt: Date.now(),
  };
}

async function runWorkerStage(): Promise<string> {
  const { PairPipeline } = await import('./pairPipeline.js');
  const pipeline = new PairPipeline({
    stages: ['worker'],
    maxIterations: 1,
    roles: { worker: { enabled: true, model: 'w', timeoutMs: 0 } },
  } as unknown as ConstructorParameters<typeof PairPipeline>[0]);

  await pipeline.run(task(), process.cwd());

  const options = runWorker.mock.calls.at(-1)?.[0] as { previousFeedback?: string } | undefined;
  return options?.previousFeedback ?? '';
}

describe('the worker is told what the write-scope fence already refused (AGT-4451)', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { resetRejectedWorkerPathsForTests } = await import('../support/rejectedWorkerPaths.js');
    resetRejectedWorkerPathsForTests();
    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/example.ts'],
      commands: [],
      output: '',
      confidencePercent: 100,
    });
  });

  it('names the rejected paths, so a retry can stop chasing an unsatisfiable demand', async () => {
    const { noteRejectedWorkerPaths } = await import('../support/rejectedWorkerPaths.js');
    noteRejectedWorkerPaths(process.cwd(), ['.gitignore', 'apps/portal/node_modules']);

    const feedback = await runWorkerStage();

    expect(feedback).toContain('Outside your write scope');
    expect(feedback).toContain('.gitignore');
    expect(feedback).toContain('apps/portal/node_modules');
  });

  it('asks for the unmet request to survive as text rather than vanish with the edit', async () => {
    const { noteRejectedWorkerPaths } = await import('../support/rejectedWorkerPaths.js');
    noteRejectedWorkerPaths(process.cwd(), ['.gitignore']);

    const feedback = await runWorkerStage();

    // The point is not just "do not edit" — a silently dropped review request
    // is how the gap reaches nobody. It has to reach the pull request.
    expect(feedback).toContain('summary');
    expect(feedback).toContain('pull');
  });

  it('says nothing about scope when the fence has rejected nothing', async () => {
    expect(await runWorkerStage()).not.toContain('Outside your write scope');
  });

  it('parks a second identical scope rejection instead of spending a fresh-context retry', async () => {
    runWorker.mockResolvedValue({
      success: false, summary: 'could not comply', filesChanged: [], commands: [], output: '',
      error: 'worker-scope: changed files outside declared fileScope: docs/DATA-CATALOG.md',
    });
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'], maxIterations: 3,
      roles: { worker: { enabled: true, model: 'w', timeoutMs: 0 } },
    } as unknown as ConstructorParameters<typeof PairPipeline>[0]);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    const result = await pipeline.run(task(), process.cwd());

    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(result.finalStatus).toBe('waiting_on_operator');
    expect(result.workerResult?.haltReason).toContain('docs/DATA-CATALOG.md');
    const lines = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(lines).toContain('Repeated write-scope rejection; stopped instead of retrying');
    expect(lines).not.toContain('Using fresh context');
  });
});

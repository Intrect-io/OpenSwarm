// A worker rejected for claiming "tests pass" without evidence (AGT-4900)
// must be told so on the retry. A bare worker failure does not reach the next
// prompt, so without this the retry repeats the same unbacked claim.
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

const task: TaskItem = {
  id: 'completion-evidence-task',
  source: 'linear',
  title: 'fix projection',
  description: 'exercise the completion evidence feedback',
  priority: 1,
  createdAt: Date.now(),
};

describe('retry after an unbacked completion claim (AGT-4900)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('puts the missing-evidence issue and the line format into the next worker prompt', async () => {
    runWorker
      .mockResolvedValueOnce({
        success: false, summary: 'done', filesChanged: ['src/a.ts'], commands: [], output: 'All tests pass.',
        unverifiedCompletionClaim: true,
        error: 'worker-evidence: Report claims a check passed but shows no execution evidence. Claim: "All tests pass." Report each check you ran as one line: Ran: <command> -> exit <code>, <N> passed, <M> failed',
      })
      .mockResolvedValue({
        success: false, summary: 'stopped', filesChanged: [], commands: [], output: '', error: 'stop',
      });
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'], maxIterations: 2,
      roles: { worker: { enabled: true, model: 'w', timeoutMs: 0 } },
    } as unknown as ConstructorParameters<typeof PairPipeline>[0]);

    await pipeline.run(task, process.cwd());

    expect(runWorker).toHaveBeenCalledTimes(2);
    const retry = runWorker.mock.calls[1][0] as { previousFeedback?: string };
    expect(retry.previousFeedback).toContain('shows no execution evidence');
    expect(retry.previousFeedback).toContain('Ran: <command> -> exit <code>');
    expect(retry.previousFeedback).not.toContain('worker-evidence:');
  });

  const rejection = (claim: string) => ({
    success: false, summary: 'done', filesChanged: ['src/a.ts'], commands: [], output: claim,
    unverifiedCompletionClaim: true,
    error: `worker-evidence: Report claims a check passed but shows no execution evidence. Claim: "${claim}"`,
  });
  const pipelineWith = async (maxIterations: number, maxReflections: number) => {
    const { PairPipeline } = await import('./pairPipeline.js');
    return new PairPipeline({
      stages: ['worker'], maxIterations, maxReflections,
      roles: { worker: { enabled: true, model: 'w', timeoutMs: 0 } },
    } as unknown as ConstructorParameters<typeof PairPipeline>[0]);
  };

  it('does not spend the reflection budget on evidence rejections', async () => {
    runWorker
      .mockResolvedValueOnce(rejection('All tests pass.'))
      .mockResolvedValueOnce(rejection('Lint is clean.'))
      .mockResolvedValue({ success: false, summary: 'stopped', filesChanged: [], commands: [], output: '', error: 'stop' });
    const pipeline = await pipelineWith(3, 1);
    const counts: number[] = [];
    const aborts: unknown[] = [];
    pipeline.on('iteration:fail', ({ context }: { context: { reflection: { reflectionCount: number } } }) => {
      counts.push(context.reflection.reflectionCount);
    });
    pipeline.on('reflection:abort', (event: unknown) => aborts.push(event));

    await pipeline.run(task, process.cwd());

    expect(runWorker).toHaveBeenCalledTimes(3);
    expect(counts.slice(0, 2)).toEqual([0, 0]);
    expect(aborts).toEqual([]);
  });

  it('stops when the same evidence rejection repeats', async () => {
    runWorker.mockResolvedValue(rejection('All tests pass.'));
    const pipeline = await pipelineWith(5, 3);
    const aborts: Array<{ reason: string }> = [];
    pipeline.on('reflection:abort', (event: { reason: string }) => aborts.push(event));

    await pipeline.run(task, process.cwd());

    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(aborts[0]?.reason).toMatch(/identical validation errors repeated/);
  });
});

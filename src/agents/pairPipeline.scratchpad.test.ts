// ============================================
// OpenSwarm - the worker's own notes reach the next iteration (AGT-4459)
//
// The worker is rebuilt from WorkerOptions every iteration, so nothing it
// wrote to itself used to survive the boundary — only framework-composed
// feedback crossed. These pin that a note written on one iteration is in the
// next iteration's prompt, and that the run identity the tools address is the
// one the pipeline chose.
// ============================================

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    id: 'scratchpad-task-uuid',
    source: 'linear',
    issueIdentifier: 'AX-9001',
    title: 'A2 adapter',
    description: 'exercise the scratchpad carry-over',
    priority: 1,
    createdAt: Date.now(),
  } as TaskItem;
}

interface CapturedOptions { previousFeedback?: string; scratchpadRunId?: string }

async function runWorkerStage(): Promise<CapturedOptions> {
  const { PairPipeline } = await import('./pairPipeline.js');
  const pipeline = new PairPipeline({
    stages: ['worker'],
    maxIterations: 1,
    roles: { worker: { enabled: true, model: 'w', timeoutMs: 0 } },
  } as unknown as ConstructorParameters<typeof PairPipeline>[0]);

  await pipeline.run(task(), process.cwd());
  return (runWorker.mock.calls.at(-1)?.[0] as CapturedOptions | undefined) ?? {};
}

let root: string;
const previousDir = process.env.OPENSWARM_SCRATCHPAD_DIR;

describe('the worker keeps its own notes across an iteration (AGT-4459)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    root = mkdtempSync(join(tmpdir(), 'pipeline-scratch-'));
    process.env.OPENSWARM_SCRATCHPAD_DIR = root;
    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/example.ts'],
      commands: [],
      output: '',
      confidencePercent: 100,
    });
  });

  afterEach(() => {
    if (previousDir === undefined) delete process.env.OPENSWARM_SCRATCHPAD_DIR;
    else process.env.OPENSWARM_SCRATCHPAD_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  });

  it('hands the worker the run whose notes it should address', async () => {
    expect((await runWorkerStage()).scratchpadRunId).toBe('AX-9001');
  });

  it('puts a note written earlier into the next prompt', async () => {
    const { writeNote } = await import('../support/scratchpad.js');
    await writeNote('AX-9001', 'ruled-out', 'the adapter registry is not the seam');

    const feedback = (await runWorkerStage()).previousFeedback ?? '';
    expect(feedback).toContain('Your notes from earlier in this task');
    expect(feedback).toContain('the adapter registry is not the seam');
  });

  it('says nothing about notes when the agent has written none', async () => {
    expect((await runWorkerStage()).previousFeedback ?? '').not.toContain('Your notes from earlier');
  });

  it('reads the notes before the reviewer, so its own conclusions frame the demand', async () => {
    const { writeNote } = await import('../support/scratchpad.js');
    const { noteRejectedWorkerPaths, resetRejectedWorkerPathsForTests } =
      await import('../support/rejectedWorkerPaths.js');
    resetRejectedWorkerPathsForTests();
    await writeNote('AX-9001', 'approach', 'MY-OWN-NOTE');
    noteRejectedWorkerPaths(process.cwd(), ['.gitignore']);

    const feedback = (await runWorkerStage()).previousFeedback ?? '';
    expect(feedback.indexOf('MY-OWN-NOTE')).toBeGreaterThanOrEqual(0);
    expect(feedback.indexOf('MY-OWN-NOTE')).toBeLessThan(feedback.indexOf('Outside your write scope'));
    resetRejectedWorkerPathsForTests();
  });
});

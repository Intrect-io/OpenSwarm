// Purpose: the worker actually records the scope fence's verdict, so the
// preserve commit can leave the discarded iteration's files out. The filter
// end is covered by support/rejectedWorkerPaths.test.ts; without this file,
// deleting the `noteRejectedWorkerPaths` call left that whole suite green.
// (AGT-4440)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const spawnCli = vi.fn(async () => ({ stdout: 'raw' }));
const parseWorkerOutput = vi.fn();
const getChangedFilesSinceSnapshot = vi.fn();

vi.mock('../adapters/index.js', () => ({
  getAdapter: () => ({ parseWorkerOutput }),
  getDefaultAdapterName: () => 'gpt',
  spawnCli: (...args: unknown[]) => spawnCli(...(args as [])),
}));
vi.mock('../support/gitTracker.js', () => ({
  isGitRepo: vi.fn(async () => true),
  takeSnapshot: vi.fn(async () => 'snapshot-tree'),
  getChangedFilesSinceSnapshot,
}));

const { runWorker } = await import('./worker.js');
const { rejectedWorkerPaths, noteRejectedWorkerPaths, resetRejectedWorkerPathsForTests } =
  await import('../support/rejectedWorkerPaths.js');

describe('runWorker records what the scope fence rejected (AGT-4440)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRejectedWorkerPathsForTests();
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Done', filesChanged: [], commands: [], output: 'claimed completion',
    });
  });

  it('records the out-of-scope path, and not the in-scope one beside it', async () => {
    // The measured AX-1556 iteration: one legitimate file plus a fixture
    // written to a doubled `apps/apps/…` prefix.
    getChangedFilesSinceSnapshot.mockResolvedValue([
      'apps/portal/test/fixtures/canonical-mutation-contracts.json',
      'apps/apps/portal/test/fixtures/canonical-mutation-contracts.json',
    ]);

    const result = await runWorker({
      taskTitle: 'A2 fixed-expense mutation adapter',
      taskDescription: 'AX-1556',
      projectPath: '/repo',
      adapterName: 'gpt',
      fileScope: ['apps/portal/test/fixtures/canonical-mutation-contracts.json'],
    });

    expect(result.success).toBe(false);
    expect(rejectedWorkerPaths('/repo'))
      .toEqual(['apps/apps/portal/test/fixtures/canonical-mutation-contracts.json']);
  });

  it('un-rejects a path once a later iteration writes it inside scope', async () => {
    // The scope a task drafts is not stable across iterations, so the verdict
    // must be revisited per path and per iteration rather than accumulated.
    const path = 'apps/pipelines/tests/test_contracts.py';
    noteRejectedWorkerPaths('/repo', [path]);
    getChangedFilesSinceSnapshot.mockResolvedValue([path]);

    const result = await runWorker({
      taskTitle: 'fix the contract test properly',
      taskDescription: 'AX-1556',
      projectPath: '/repo',
      adapterName: 'gpt',
      fileScope: [path],
    });

    expect(result.success).toBe(true);
    expect(rejectedWorkerPaths('/repo')).toEqual([]);
  });

  it('records nothing when every change is inside scope', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue(['apps/portal/a.ts']);

    await runWorker({
      taskTitle: 'in scope', taskDescription: 'x',
      projectPath: '/repo', adapterName: 'gpt', fileScope: ['apps/portal/a.ts'],
    });

    expect(rejectedWorkerPaths('/repo')).toEqual([]);
  });

  it('records nothing when there is no declared scope to escape', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue(['anything/at/all.ts']);

    await runWorker({
      taskTitle: 'no scope', taskDescription: 'x',
      projectPath: '/repo', adapterName: 'gpt',
    });

    expect(rejectedWorkerPaths('/repo')).toEqual([]);
  });
});

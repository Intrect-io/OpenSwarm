// A worker report that claims a check passed must show what ran; a document
// written in the same diff is not evidence (AGT-4900). These run through
// runWorker so the gate is checked against the git-derived file list and after
// the promote-to-success step, which must not flip it back.
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

const run = () => runWorker({
  taskTitle: 'fix projection', taskDescription: 'AX-1', projectPath: '/repo', adapterName: 'gpt',
});

describe('runWorker completion-report evidence (AGT-4900)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getChangedFilesSinceSnapshot.mockResolvedValue(['src/projection.py', 'docs/readiness.md']);
  });

  it('does not accept "tests pass" with no execution evidence as success', async () => {
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Done', filesChanged: [], commands: [],
      output: 'Codename: Atlas\nFixed the projection. All tests pass.',
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.unverifiedCompletionClaim).toBe(true);
    expect(result.error).toMatch(/^worker-evidence: Report claims a check passed but shows no execution evidence/);
  });

  it('does not accept a document from the same diff as the evidence', async () => {
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Done', filesChanged: [], commands: [],
      output: 'No credentials are committed; the readiness check passes.\nEvidence: docs/readiness.md',
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.error).toContain('docs/readiness.md');
  });

  it('is not undone by git promotion when the model reported no JSON success', async () => {
    // Text-only reports start as success=false and are promoted by git changes;
    // the evidence gate must run after that promotion.
    parseWorkerOutput.mockReturnValue({
      success: false, summary: 'Done', filesChanged: [], commands: [],
      output: 'All tests pass.',
    });

    const result = await run();

    expect(result.success).toBe(false);
    expect(result.unverifiedCompletionClaim).toBe(true);
  });

  it('accepts the same claim when the report shows the run', async () => {
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Done', filesChanged: [], commands: [],
      output: 'All tests pass.\nRan: uv run pytest -> exit 0, 2385 passed, 0 failed',
    });

    const result = await run();

    expect(result.success).toBe(true);
    expect(result.unverifiedCompletionClaim).toBeUndefined();
  });

  it('leaves a report without any claim alone', async () => {
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Done', filesChanged: [], commands: [],
      output: 'Codename: Atlas\nRenamed the projection helper.',
    });

    expect((await run()).success).toBe(true);
  });
});

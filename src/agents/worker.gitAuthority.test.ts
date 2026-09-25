import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

describe('runWorker Git authority (INT-2609)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Done', filesChanged: ['worktree/other/web_tools.py'],
      commands: ['pytest'], output: 'claimed completion',
    });
  });

  it('rejects a model-reported change when Git has no diff', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue([]);

    const result = await runWorker({
      taskTitle: 'edit exec tools', taskDescription: 'implement allow-list',
      projectPath: '/repo', adapterName: 'gpt',
    });

    expect(result.success).toBe(false);
    expect(result.filesChanged).toEqual([]);
    expect(result.error).toContain('no changed files');
    // The pipeline parks a session that repeats this outcome; it needs to tell
    // it apart from every other worker failure.
    expect(result.zeroDiffWithoutReason).toBe(true);
  });

  it('keeps a zero-diff success that carries a noChangesReason, and says so in the log', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue([]);
    parseWorkerOutput.mockReturnValue({
      success: true, summary: 'Nothing to do', filesChanged: [], commands: [], output: 'looked',
      noChangesReason: 'ledger.py already splits settlement tags',
    });
    const lines: string[] = [];

    const result = await runWorker({
      taskTitle: 'split settlement tags', taskDescription: 'AX-874',
      projectPath: '/repo', adapterName: 'gpt', onLog: (line) => { lines.push(line); },
    });

    expect(result.success).toBe(true);
    expect(result.noChangesReason).toBe('ledger.py already splits settlement tags');
    expect(lines).toContain('[Worker] Finished without edits: ledger.py already splits settlement tags');
  });

  it('fails when the Git diff escapes planner fileScope', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue([
      'kyte_cli/core/exec_tools.py', 'worktree/other/web_tools.py',
    ]);

    const result = await runWorker({
      taskTitle: 'edit exec tools', taskDescription: 'implement allow-list',
      projectPath: '/repo', adapterName: 'gpt', fileScope: ['kyte_cli/core/exec_tools.py'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('outside declared fileScope');
  });

  it('accepts task-owned files resumed from preserved WIP commits', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue([]);

    const result = await runWorker({
      taskTitle: 'resume exec tools', taskDescription: 'finish preserved work',
      projectPath: '/repo', adapterName: 'gpt',
      resumedTaskFiles: ['kyte_cli/core/exec_tools.py'],
      fileScope: ['kyte_cli/core/exec_tools.py'],
    });

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(['kyte_cli/core/exec_tools.py']);
  });

  it('does not re-reject task-owned WIP solely because the preserved scope was incomplete', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue([]);

    const result = await runWorker({
      taskTitle: 'resume exec tools', taskDescription: 'finish preserved work',
      projectPath: '/repo', adapterName: 'gpt',
      resumedTaskFiles: ['worktree/other/web_tools.py'],
      fileScope: ['kyte_cli/core/exec_tools.py'],
    });

    expect(result.success).toBe(true);
    expect(result.filesChanged).toEqual(['worktree/other/web_tools.py']);
  });

  it('still enforces declared scope for fresh edits made after resume', async () => {
    getChangedFilesSinceSnapshot.mockResolvedValue(['fresh/outside.py']);

    const result = await runWorker({
      taskTitle: 'resume exec tools', taskDescription: 'finish preserved work',
      projectPath: '/repo', adapterName: 'gpt',
      resumedTaskFiles: ['kyte_cli/core/exec_tools.py'],
      fileScope: ['kyte_cli/core/exec_tools.py'],
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('fresh/outside.py');
  });

  // AGT-4534, measured on a real run: iteration 1 fixed the code, the
  // reviewer asked only for a better report, and iteration 2 supplied it
  // without a new edit. Diffed against its own snapshot it changed nothing, so
  // the run failed with the reviewer-accepted fix still in the tree.
  describe('edits from earlier iterations of the same run', () => {
    afterEach(async () => {
      (await import('../support/rejectedWorkerPaths.js')).resetRejectedWorkerPathsForTests();
    });
    const snapshots = (byTree: Record<string, string[]>) =>
      getChangedFilesSinceSnapshot.mockImplementation(async (_cwd: string, tree: string) => byTree[tree] ?? []);

    it('counts files still changed since the run started', async () => {
      snapshots({ 'snapshot-tree': [], 'run-start-tree': ['pkg/src/bounds.mjs'] });

      const result = await runWorker({
        taskTitle: 'confirm bounds', taskDescription: 'summarise',
        projectPath: '/repo', adapterName: 'gpt', runSnapshotHash: 'run-start-tree',
      });

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['pkg/src/bounds.mjs']);
    });

    it('does not count a file an earlier iteration changed and this one reverted', async () => {
      // Reverted: no longer differs from the run start.
      snapshots({ 'snapshot-tree': ['pkg/src/bounds.mjs'], 'run-start-tree': [] });

      const result = await runWorker({
        taskTitle: 'confirm bounds', taskDescription: 'summarise',
        projectPath: '/repo', adapterName: 'gpt', runSnapshotHash: 'run-start-tree',
      });

      expect(result.filesChanged).toEqual(['pkg/src/bounds.mjs']);
      snapshots({ 'snapshot-tree': [], 'run-start-tree': [] });
      const reverted = await runWorker({
        taskTitle: 'confirm bounds', taskDescription: 'summarise',
        projectPath: '/repo', adapterName: 'gpt', runSnapshotHash: 'run-start-tree',
      });
      expect(reverted.success).toBe(false);
      expect(reverted.zeroDiffWithoutReason).toBe(true);
    });

    it('does not credit an earlier out-of-scope write that stayed on disk', async () => {
      snapshots({ 'snapshot-tree': [], 'run-start-tree': ['pkg/src/bounds.mjs', 'earlier/outside.py'] });

      const result = await runWorker({
        taskTitle: 'confirm bounds', taskDescription: 'summarise',
        projectPath: '/repo', adapterName: 'gpt', runSnapshotHash: 'run-start-tree',
        fileScope: ['pkg/src/bounds.mjs'],
      });

      expect(result.success).toBe(true);
      expect(result.filesChanged).toEqual(['pkg/src/bounds.mjs']);
    });

    it('does not credit a path the fence rejected on an earlier iteration', async () => {
      const { noteRejectedWorkerPaths } = await import('../support/rejectedWorkerPaths.js');
      noteRejectedWorkerPaths('/repo', ['pkg/test/bounds.test.mjs']);
      snapshots({ 'snapshot-tree': [], 'run-start-tree': ['pkg/src/bounds.mjs', 'pkg/test/bounds.test.mjs'] });

      const result = await runWorker({
        taskTitle: 'confirm bounds', taskDescription: 'summarise',
        projectPath: '/repo', adapterName: 'gpt', runSnapshotHash: 'run-start-tree',
      });

      expect(result.filesChanged).toEqual(['pkg/src/bounds.mjs']);
    });
  });
});

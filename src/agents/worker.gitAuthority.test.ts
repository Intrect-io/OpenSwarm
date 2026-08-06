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
});

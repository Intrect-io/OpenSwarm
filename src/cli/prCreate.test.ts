import { describe, it, expect, vi, beforeEach } from 'vitest';

// For the default (non-injected) git-backed helpers and the --draft `gh` call.
const { execImpl } = vi.hoisted(() => ({
  execImpl: vi.fn(async (_cmd: string, _args: string[]) => ({ stdout: '', stderr: '' })),
}));
vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  function execFile() { throw new Error('execFile called without promisify in test'); }
  (execFile as unknown as Record<symbol, unknown>)[CUSTOM] = (cmd: string, args: string[]) => execImpl(cmd, args);
  return { execFile };
});

const { createPrFromCwd } = await import('./prCreate.js');
type PrCreateDeps = Parameters<typeof createPrFromCwd>[1];

beforeEach(() => {
  execImpl.mockReset();
  execImpl.mockResolvedValue({ stdout: '', stderr: '' });
});

describe('createPrFromCwd (INT-3282)', () => {
  const baseDeps = (): PrCreateDeps => ({
    runLocalFix: vi.fn(async () => ({ green: true })),
    commitAndCreate: vi.fn(async () => 'https://example.com/pr/1'),
    currentBranch: vi.fn(async () => 'feat/ship'),
    hasDirtyOrAhead: vi.fn(async () => true),
  });

  it('runs local fix then publishes', async () => {
    const deps = baseDeps();
    const result = await createPrFromCwd({ title: 'feat: ship', issue: 'INT-1' }, deps);
    expect(deps.runLocalFix).toHaveBeenCalled();
    expect(deps.commitAndCreate).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/ship', issueId: 'INT-1' }),
      'feat: ship',
      'INT-1',
      expect.any(String),
    );
    expect(result.url).toContain('/pr/1');
  });

  it('skips fix when fix:false', async () => {
    const deps = baseDeps();
    await createPrFromCwd({ fix: false, title: 't' }, deps);
    expect(deps.runLocalFix).not.toHaveBeenCalled();
  });

  it('refuses main/master', async () => {
    const deps = baseDeps();
    deps.currentBranch = vi.fn(async () => 'main');
    await expect(createPrFromCwd({ fix: false }, deps)).rejects.toThrow(/Refusing/);
  });

  it('fails when local fix stays red', async () => {
    const deps = baseDeps();
    deps.runLocalFix = vi.fn(async () => ({ green: false }));
    await expect(createPrFromCwd({}, deps)).rejects.toThrow(/still red/);
  });

  it('fails when nothing to publish', async () => {
    const deps = baseDeps();
    deps.hasDirtyOrAhead = vi.fn(async () => false);
    await expect(createPrFromCwd({ fix: false }, deps)).rejects.toThrow(/Nothing to publish/);
  });

  it('refuses a detached HEAD', async () => {
    const deps = baseDeps();
    deps.currentBranch = vi.fn(async () => 'HEAD');
    await expect(createPrFromCwd({ fix: false }, deps)).rejects.toThrow(/Detached HEAD/);
  });

  it('builds a default body with a Closes line when no body is given', async () => {
    const deps = baseDeps();
    await createPrFromCwd({ title: 'feat: ship', issue: 'INT-1', fix: false }, deps);
    const [, , , description] = vi.mocked(deps.commitAndCreate!).mock.calls[0]!;
    expect(description).toContain('## Summary');
    expect(description).toContain('Closes INT-1');
  });

  it('omits the Closes line for the default "local" issue id', async () => {
    const deps = baseDeps();
    await createPrFromCwd({ title: 'feat: ship', fix: false }, deps);
    const [, , issueIdentifier, description] = vi.mocked(deps.commitAndCreate!).mock.calls[0]!;
    expect(issueIdentifier).toBe('local');
    expect(description).not.toContain('Closes');
  });

  it('best-effort un-readies the PR when --draft is set', async () => {
    const deps = baseDeps();
    await createPrFromCwd({ title: 'feat: ship', fix: false, draft: true }, deps);
    expect(execImpl).toHaveBeenCalledWith('gh', expect.arrayContaining(['pr', 'ready', 'https://example.com/pr/1', '--undo']));
  });

  it('does not fail the whole command when the draft un-ready call itself fails', async () => {
    const deps = baseDeps();
    execImpl.mockRejectedValueOnce(new Error('gh not authenticated'));
    const result = await createPrFromCwd({ title: 'feat: ship', fix: false, draft: true }, deps);
    expect(result.url).toContain('/pr/1');
  });

  it('falls back to the latest commit subject when no title is given', async () => {
    const deps = baseDeps();
    execImpl.mockResolvedValueOnce({ stdout: 'fix: the thing\n', stderr: '' }); // git log -1 --pretty=%s
    await createPrFromCwd({ fix: false }, deps);
    const [, title] = vi.mocked(deps.commitAndCreate!).mock.calls[0]!;
    expect(title).toBe('fix: the thing');
  });

  it('default currentBranch/hasDirtyOrAhead shell out to git when not injected', async () => {
    execImpl
      .mockResolvedValueOnce({ stdout: 'feat/ship\n', stderr: '' }) // rev-parse --abbrev-ref HEAD
      .mockResolvedValueOnce({ stdout: ' M src/x.ts\n', stderr: '' }) // status --porcelain (dirty)
      .mockResolvedValueOnce({ stdout: 'chore: wip\n', stderr: '' }); // log -1 --pretty=%s
    const commitAndCreate = vi.fn(async () => 'https://example.com/pr/2');
    const result = await createPrFromCwd({ fix: false }, { commitAndCreate });
    expect(result.url).toContain('/pr/2');
    expect(commitAndCreate).toHaveBeenCalledWith(
      expect.objectContaining({ branchName: 'feat/ship' }),
      'chore: wip',
      'local',
      expect.any(String),
    );
  });

  it('default hasDirtyOrAhead falls back to rev-list ahead-count when the tree is clean', async () => {
    execImpl
      .mockResolvedValueOnce({ stdout: 'feat/ship\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // status --porcelain (clean)
      .mockResolvedValueOnce({ stdout: '2\n', stderr: '' }) // rev-list --count @{u}..HEAD
      .mockResolvedValueOnce({ stdout: 'chore: wip\n', stderr: '' }); // log -1 --pretty=%s
    const commitAndCreate = vi.fn(async () => 'https://example.com/pr/3');
    const result = await createPrFromCwd({ fix: false }, { commitAndCreate });
    expect(result.url).toContain('/pr/3');
  });

  it('default hasDirtyOrAhead treats a clean tree with no upstream and no commits as nothing to publish', async () => {
    execImpl
      .mockResolvedValueOnce({ stdout: 'feat/ship\n', stderr: '' }) // rev-parse
      .mockResolvedValueOnce({ stdout: '', stderr: '' }) // status --porcelain (clean)
      .mockRejectedValueOnce(new Error('no upstream')) // rev-list fails (no @{u})
      .mockResolvedValueOnce({ stdout: '', stderr: '' }); // log --oneline -1 (nothing)
    const commitAndCreate = vi.fn(async () => 'https://example.com/pr/4');
    await expect(createPrFromCwd({ fix: false }, { commitAndCreate })).rejects.toThrow(/Nothing to publish/);
  });
});

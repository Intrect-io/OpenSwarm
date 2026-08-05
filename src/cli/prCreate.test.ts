import { describe, it, expect, vi } from 'vitest';
import { createPrFromCwd, type PrCreateDeps } from './prCreate.js';

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
});

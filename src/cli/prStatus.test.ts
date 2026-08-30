import { describe, it, expect, vi } from 'vitest';

const gh = vi.hoisted(() => ({
  checkPRConflicts: vi.fn(async () => false),
  checkPRCIStatus: vi.fn(async () => ({ status: 'success' as const, headSha: 'head-a' })),
  getPRReviews: vi.fn(async () => []),
  getPRComments: vi.fn(async () => []),
}));
vi.mock('../github/github.js', () => gh);

const { gatherPrStatus } = await import('./prStatus.js');

const input = { repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', url: 'https://example/pr/9' };

describe('gatherPrStatus (INT-3282)', () => {
  it('reports merge-ready when there are no conflicts, CI is green, and no feedback', async () => {
    const deps = {
      checkConflicts: vi.fn(async () => false),
      checkCI: vi.fn(async () => ({ status: 'success' as const, headSha: 'head-a' })),
      getReviews: vi.fn(async () => []),
      getComments: vi.fn(async () => []),
    };
    const status = await gatherPrStatus(input, deps);
    expect(status).toMatchObject({ mergeable: true, hasConflicts: false, blocker: 'none', mergeReady: true });
  });

  it('classifies conflicts as the top-priority blocker even with other issues present', async () => {
    const deps = {
      checkConflicts: vi.fn(async () => true),
      checkCI: vi.fn(async () => ({ status: 'failure' as const, headSha: 'head-a', failedChecks: [{ name: 'lint', conclusion: 'failure' }] })),
      getReviews: vi.fn(async () => [{ id: 1, author: 'codex', body: 'fix this', createdAt: '2026-08-05T00:00:00.000Z', state: 'CHANGES_REQUESTED' as const }]),
      getComments: vi.fn(async () => []),
    };
    const status = await gatherPrStatus(input, deps);
    expect(status.blocker).toBe('conflicts');
    expect(status.mergeReady).toBe(false);
  });

  it('surfaces a formal CHANGES_REQUESTED review as a "comments" blocker', async () => {
    const deps = {
      checkConflicts: vi.fn(async () => false),
      checkCI: vi.fn(async () => ({ status: 'success' as const, headSha: 'head-a' })),
      getReviews: vi.fn(async () => [{ id: 1, author: 'codex', body: 'please fix', createdAt: '2026-08-05T00:00:00.000Z', state: 'CHANGES_REQUESTED' as const }]),
      getComments: vi.fn(async () => []),
    };
    const status = await gatherPrStatus(input, deps);
    expect(status.blocker).toBe('comments');
    expect(status.changesRequested).toHaveLength(1);
  });

  it('falls back to the real github.js-backed deps when none are injected', async () => {
    gh.checkPRConflicts.mockResolvedValueOnce(false);
    gh.checkPRCIStatus.mockResolvedValueOnce({ status: 'success', headSha: 'head-a' });
    gh.getPRReviews.mockResolvedValueOnce([]);
    gh.getPRComments.mockResolvedValueOnce([]);
    const status = await gatherPrStatus(input);
    expect(status.mergeReady).toBe(true);
    expect(gh.checkPRConflicts).toHaveBeenCalledWith('o/r', 9);
  });

  it('keeps an unknown CI identity fail-closed instead of merge-ready', async () => {
    const deps = {
      checkConflicts: vi.fn(async () => false),
      checkCI: vi.fn(async () => ({
        status: 'unknown' as const,
        reason: 'head_mismatch' as const,
        expectedHeadSha: 'head-b',
        observedHeadSha: 'head-a',
      })),
      getReviews: vi.fn(async () => []),
      getComments: vi.fn(async () => []),
    };

    const status = await gatherPrStatus(input, deps);
    expect(status).toMatchObject({ blocker: 'unknown_ci', mergeReady: false });
  });
});

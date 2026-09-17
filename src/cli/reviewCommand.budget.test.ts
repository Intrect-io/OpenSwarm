import { beforeEach, describe, expect, it, vi } from 'vitest';

// The reviewer is the boundary: everything runReviewCommand resolves for it
// (model, budget, attribution) must arrive there, or a caller like the PR-time
// fresh review sets a budget nobody reads.
const runReviewerMock = vi.fn();
vi.mock('../agents/reviewer.js', () => ({ runReviewer: runReviewerMock }));

const { runReviewCommand } = await import('./reviewCommand.js');

const stubDeps = {
  getChangedFiles: async () => ['src/a.ts'],
  getDiff: async () => 'diff --git a/src/a.ts b/src/a.ts',
  loadHistory: async () => ({ context: undefined, records: [], currentHashes: {} }),
  saveHistory: async () => undefined,
  ensureProjectMapping: async () => ({ ok: true }) as never,
  log: () => undefined,
  startProgress: () => null,
};

describe('runReviewCommand forwards the caller\'s reviewer budget (AGT-4410)', () => {
  beforeEach(() => {
    runReviewerMock.mockReset();
    runReviewerMock.mockResolvedValue({ decision: 'approve', feedback: 'ok' });
  });

  it('hands model, timeoutMs, maxTurns (0 = unbounded) and processContext to runReviewer', async () => {
    await runReviewCommand({
      path: '/repo', adapter: 'openrouter', model: 'deepseek/deepseek-v4-flash',
      timeoutMs: 900_000, maxTurns: 0, processContext: { taskId: 'o/r#9', stage: 'pr-review' },
    }, stubDeps);
    expect(runReviewerMock).toHaveBeenCalledWith(expect.objectContaining({
      model: 'deepseek/deepseek-v4-flash',
      timeoutMs: 900_000,
      maxTurns: 0,
      processContext: { taskId: 'o/r#9', stage: 'pr-review' },
    }));
  });

  it('falls back to the diff-scaled defaults and the adapter\'s own model when the caller sets nothing', async () => {
    await runReviewCommand({ path: '/repo', adapter: 'openrouter' }, stubDeps);
    const [opts] = runReviewerMock.mock.calls[0] as [Record<string, unknown>];
    expect(opts.model).toBeUndefined();
    expect(opts.processContext).toBeUndefined();
    expect(opts.timeoutMs).toBe(300_000);
    expect(opts.maxTurns).toBe(20);
  });
});

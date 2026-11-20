import { beforeEach, describe, expect, it, vi } from 'vitest';

// The reviewer is the boundary: everything runReviewCommand resolves for it
// (model, budget, attribution) must arrive there, or a caller like the PR-time
// fresh review sets a budget nobody reads.
const runReviewerMock = vi.fn();
vi.mock('../agents/reviewer.js', () => ({ runReviewer: runReviewerMock }));

// Pass-through unless a test overrides it, so the "nothing configured" path
// (adapter left to the registry default) can be reached without a config file.
const builtInDefault = vi.hoisted(() => ({ on: false }));
vi.mock('./reviewAdapter.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./reviewAdapter.js')>();
  return {
    ...actual,
    resolveReviewAdapter: (...args: Parameters<typeof actual.resolveReviewAdapter>) =>
      builtInDefault.on ? { source: 'built-in default' as const } : actual.resolveReviewAdapter(...args),
  };
});

const { runReviewCommand } = await import('./reviewCommand.js');
const adapterRegistry = await import('../adapters/index.js');

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
    // OpenRouter gets its own, larger floor (AGT-4313); other adapters keep 300 s.
    expect(opts.timeoutMs).toBe(900_000);
    expect(opts.maxTurns).toBe(20);
  });

  it('keeps the 300 s floor for a non-OpenRouter adapter', async () => {
    await runReviewCommand({ path: '/repo', adapter: 'codex' }, stubDeps);
    const [opts] = runReviewerMock.mock.calls[0] as [Record<string, unknown>];
    expect(opts.timeoutMs).toBe(300_000);
  });

  // AGT-4313 review: with no flag, env or config the reviewer runs on the
  // registry default, which a provider override can set to OpenRouter. The
  // budget must follow that adapter, not fall back to the generic floor.
  it('budgets for the effective registry default when nothing names an adapter', async () => {
    const before = adapterRegistry.getDefaultAdapterName();
    builtInDefault.on = true;
    try {
      adapterRegistry.setDefaultAdapter('openrouter');
      await runReviewCommand({ path: '/repo' }, stubDeps);
      const [opts] = runReviewerMock.mock.calls[0] as [Record<string, unknown>];
      expect(opts.adapterName).toBeUndefined();
      expect(opts.timeoutMs).toBe(900_000);

      adapterRegistry.setDefaultAdapter('codex');
      await runReviewCommand({ path: '/repo' }, stubDeps);
      const [codexOpts] = runReviewerMock.mock.calls[1] as [Record<string, unknown>];
      expect(codexOpts.timeoutMs).toBe(300_000);
    } finally {
      builtInDefault.on = false;
      adapterRegistry.setDefaultAdapter(before);
    }
  });
});

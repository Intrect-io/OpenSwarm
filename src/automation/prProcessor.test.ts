import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isReviewBotComment, getActiveCriticalComments, type PRIssueComment } from './prProcessor.js';

// ============================================
// PRProcessor class tests (fixOne / reviewOne)
// ============================================
//
// git is invoked via util.promisify(execFile); promisify resolves through the
// [promisify.custom] symbol on the mocked function rather than the generic
// callback convention, so the mock controls the exact {stdout,stderr} shape
// gitExec destructures. Referenced from vi.mock's hoisted factory, so it must
// come from vi.hoisted() rather than a plain module-scope const.
const { gitExecImpl } = vi.hoisted(() => ({
  gitExecImpl: vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  function execFile() { throw new Error('execFile called without promisify in test'); }
  (execFile as unknown as Record<symbol, unknown>)[CUSTOM] = (_cmd: string, args: string[]) => gitExecImpl(args);
  return { execFile };
});

vi.mock('../support/atomicFile.js', () => ({ atomicWriteFileSync: vi.fn() }));

const { readFileImpl } = vi.hoisted(() => ({
  readFileImpl: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));
vi.mock('node:fs/promises', () => ({ readFile: readFileImpl }));

// mapRepoToProject() calls existsSync from plain 'node:fs' (not 'node:fs/promises'),
// a separate module specifier that needs its own mock.
const { existsSyncImpl } = vi.hoisted(() => ({
  existsSyncImpl: vi.fn((_path: string) => true),
}));
vi.mock('node:fs', () => ({ existsSync: existsSyncImpl }));

const gh = vi.hoisted(() => ({
  getOpenPRs: vi.fn(async () => []),
  getPRContext: vi.fn(async () => ({
    repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', createdAt: '2026-08-05T00:00:00.000Z',
    url: 'https://example/pr/9', author: 'someone', body: '', diff: 'diff --git a/x b/x',
  })),
  checkPRConflicts: vi.fn(async () => false),
  commentOnPR: vi.fn(async () => undefined),
  waitForCICompletion: vi.fn(async () => ({ status: 'success' as const })),
  getPRReviews: vi.fn(async () => [] as Array<{ author: string; state?: string; createdAt: string; body: string }>),
  getPRComments: vi.fn(async () => [] as PRIssueComment[]),
  getPRReviewComments: vi.fn(async () => [] as Array<{ author: string; body: string; path?: string; line?: number; createdAt: string }>),
  getPRChecks: vi.fn(async () => [] as Array<{ conclusion: string }>),
}));
vi.mock('../github/github.js', () => gh);
vi.mock('../github/index.js', () => gh);

vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../discord/index.js', () => ({ reportEvent: vi.fn(async () => undefined) }));
const { schedulerImpl } = vi.hoisted(() => ({
  schedulerImpl: {
    isProjectBusy: vi.fn(() => false),
    hasAvailableSlot: vi.fn(() => true),
  },
}));
vi.mock('../orchestration/taskScheduler.js', () => ({
  getScheduler: vi.fn(() => schedulerImpl),
}));

const { conflictResolverImpl } = vi.hoisted(() => ({
  conflictResolverImpl: {
    isEnabled: vi.fn(() => true),
    canResolve: vi.fn(async () => false),
    resolve: vi.fn(async () => false),
    cascadeEnabled: vi.fn(() => false),
    checkCascade: vi.fn(async (_repo: string) => undefined),
  },
}));
vi.mock('./conflictResolver.js', () => ({
  ConflictResolver: vi.fn().mockImplementation(function ConflictResolverMock() { return conflictResolverImpl; }),
}));

const pipelineRunImpl = vi.hoisted(() => ({
  run: vi.fn(async () => ({
    success: true,
    iterations: 1,
    workerResult: { summary: 'did the thing', filesChanged: ['a.ts'] },
    reviewResult: { feedback: 'looks good' },
  })),
}));
vi.mock('../agents/pairPipeline.js', () => ({
  createPipelineFromConfig: vi.fn(() => pipelineRunImpl),
}));

const { PRProcessor } = await import('./prProcessor.js');

const pr = { repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', createdAt: '2026-08-05T00:00:00.000Z', url: 'https://example/pr/9' };

function newProcessor() {
  return new PRProcessor({ repos: [], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 3, maxRetries: 3 });
}

beforeEach(() => {
  vi.clearAllMocks();
  gitExecImpl.mockResolvedValue({ stdout: '', stderr: '' });
  readFileImpl.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  existsSyncImpl.mockReturnValue(true);
  schedulerImpl.isProjectBusy.mockReturnValue(false);
  schedulerImpl.hasAvailableSlot.mockReturnValue(true);
  conflictResolverImpl.isEnabled.mockReturnValue(true);
  conflictResolverImpl.canResolve.mockResolvedValue(false);
  conflictResolverImpl.resolve.mockResolvedValue(false);
  conflictResolverImpl.cascadeEnabled.mockReturnValue(false);
  conflictResolverImpl.checkCascade.mockResolvedValue(undefined);
  gh.getOpenPRs.mockResolvedValue([]);
  gh.getPRContext.mockResolvedValue({
    repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', createdAt: '2026-08-05T00:00:00.000Z',
    url: 'https://example/pr/9', author: 'someone', body: '', diff: 'diff --git a/x b/x',
  });
  gh.checkPRConflicts.mockResolvedValue(false);
  gh.commentOnPR.mockResolvedValue(undefined);
  gh.waitForCICompletion.mockResolvedValue({ status: 'success' });
  gh.getPRReviews.mockResolvedValue([]);
  gh.getPRComments.mockResolvedValue([]);
  gh.getPRReviewComments.mockResolvedValue([]);
  gh.getPRChecks.mockResolvedValue([]);
  pipelineRunImpl.run.mockResolvedValue({
    success: true,
    iterations: 1,
    workerResult: { summary: 'did the thing', filesChanged: ['a.ts'] },
    reviewResult: { feedback: 'looks good' },
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PRProcessor.getStatus', () => {
  it('reports idle status with the configured schedule', () => {
    const processor = newProcessor();
    expect(processor.getStatus()).toMatchObject({
      processing: false,
      currentPR: null,
      schedule: '0 0 1 1 *',
      conflictResolverEnabled: false,
    });
  });
});

describe('PRProcessor.fixOne (INT-3282)', () => {
  it('succeeds when there are no conflicts, the pipeline succeeds, and CI passes', async () => {
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result).toEqual({ success: true, error: undefined, iterations: 1 });
    expect(gh.commentOnPR).toHaveBeenCalled();
  });

  it('fails without touching the pipeline when PR context cannot be fetched', async () => {
    gh.getPRContext.mockResolvedValueOnce(null);
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to get PR context/);
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('fails and comments on the PR when there are conflicts and no resolver is configured', async () => {
    gh.checkPRConflicts.mockResolvedValueOnce(true);
    const processor = newProcessor(); // no conflictResolver in config
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/merge conflicts/);
    expect(gh.commentOnPR).toHaveBeenCalledWith('o/r', 9, expect.stringContaining('merge conflicts'));
  });

  it('exhausts retries and fails when the pipeline never succeeds', async () => {
    pipelineRunImpl.run.mockResolvedValue({ success: false, iterations: 1, workerResult: { error: 'boom' } });
    const processor = new PRProcessor({ repos: [], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 3, maxRetries: 2 });
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(2); // maxRetries
  });

  it('resolves conflicts via the ConflictResolver and falls through to a successful CI check', async () => {
    gh.checkPRConflicts.mockResolvedValue(true);
    conflictResolverImpl.canResolve.mockResolvedValue(true);
    conflictResolverImpl.resolve.mockResolvedValue(true);
    const processor = new PRProcessor({
      repos: [], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 3, maxRetries: 3,
      conflictResolver: { enabled: true, ownershipMode: 'auto', maxResolutionAttempts: 3, cascadeCheck: false },
    });
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(true);
    expect(conflictResolverImpl.resolve).toHaveBeenCalledWith(pr, '/tmp/proj');
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1);
  });

  it('fails when the ConflictResolver cannot resolve the conflict', async () => {
    gh.checkPRConflicts.mockResolvedValue(true);
    conflictResolverImpl.canResolve.mockResolvedValue(false);
    const processor = new PRProcessor({
      repos: [], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 3, maxRetries: 3,
      conflictResolver: { enabled: true, ownershipMode: 'auto', maxResolutionAttempts: 3, cascadeCheck: false },
    });
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot auto-resolve/);
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('fails when the ConflictResolver resolve() itself reports failure', async () => {
    gh.checkPRConflicts.mockResolvedValue(true);
    conflictResolverImpl.canResolve.mockResolvedValue(true);
    conflictResolverImpl.resolve.mockResolvedValue(false);
    const processor = new PRProcessor({
      repos: [], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 3, maxRetries: 3,
      conflictResolver: { enabled: true, ownershipMode: 'auto', maxResolutionAttempts: 3, cascadeCheck: false },
    });
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Conflict resolution failed/);
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('retries once after a CI failure and succeeds on the second attempt', async () => {
    gh.waitForCICompletion
      .mockResolvedValueOnce({ status: 'failure', failedChecks: [{ name: 'test', conclusion: 'failure' }] })
      .mockResolvedValueOnce({ status: 'success' });
    const processor = new PRProcessor({ repos: [], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 3, maxRetries: 2 });
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(true);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(2);
    expect(gh.waitForCICompletion).toHaveBeenCalledTimes(2);
  });

  it('breaks out immediately with a CI-timeout error when CI neither succeeds nor fails', async () => {
    gh.waitForCICompletion.mockResolvedValueOnce({ status: 'pending' });
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/CI timeout/);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1);
    expect(gh.commentOnPR).toHaveBeenCalledWith('o/r', 9, expect.stringContaining('Auto-fix failed'));
  });

  it('catches a synchronous pipeline throw and reports it as the error', async () => {
    pipelineRunImpl.run.mockImplementationOnce(() => { throw new Error('pipeline exploded'); });
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toBe('pipeline exploded');
  });

  it('does not throw out of fixOne when restoring the original branch fails in the finally block', async () => {
    gitExecImpl.mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout' && args[1] !== pr.branch) {
        throw new Error('checkout restore failed');
      }
      return { stdout: '', stderr: '' };
    });
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(true);
  });

  it('reports failure when CI succeeds but the subsequent review-feedback pass fails', async () => {
    gh.getPRComments.mockResolvedValue([{ author: 'codex', body: 'critical: fix this', createdAt: '2026-08-05T00:00:00.000Z' }]);
    pipelineRunImpl.run
      .mockResolvedValueOnce({ success: true, iterations: 1, workerResult: { summary: 'fixed CI', filesChanged: ['a.ts'] }, reviewResult: {} })
      .mockResolvedValueOnce({ success: false, iterations: 1, workerResult: { error: 'review fix failed' } });
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toBe('review fix failed');
  });

  it('stashes local changes before checkout and restores them once the branch is back', async () => {
    let stashedMessage: string | null = null;
    gitExecImpl.mockImplementation(async (args: string[]) => {
      if (args[0] === 'stash' && args[1] === 'push') {
        stashedMessage = args[4] ?? null;
        return { stdout: '', stderr: '' };
      }
      if (args[0] === 'stash' && args[1] === 'list') {
        if (!stashedMessage) return { stdout: '', stderr: '' };
        return { stdout: `abc123\x00stash@{0}\x00${stashedMessage}\n`, stderr: '' };
      }
      return { stdout: '', stderr: '' };
    });
    const processor = newProcessor();
    const result = await processor.fixOne(pr, '/tmp/proj');
    expect(result.success).toBe(true);
    expect(gitExecImpl).toHaveBeenCalledWith(expect.arrayContaining(['stash', 'apply', 'stash@{0}']));
    expect(gitExecImpl).toHaveBeenCalledWith(expect.arrayContaining(['stash', 'drop', 'stash@{0}']));
  });
});

describe('PRProcessor.reviewOne (INT-3282)', () => {
  it('completes immediately when there is no pending feedback', async () => {
    const processor = newProcessor();
    const result = await processor.reviewOne(pr, '/tmp/proj');
    expect(result).toEqual({ success: true, error: undefined, iterations: 0 });
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('addresses a critical Codex comment and reports success', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gh.getPRComments
      .mockResolvedValueOnce([{ author: 'codex', body: 'critical: fix the null check', createdAt: '2026-08-05T00:00:00.000Z' }])
      .mockResolvedValueOnce([]); // second iteration: already addressed, nothing left
    const processor = newProcessor();
    const resultPromise = processor.reviewOne(pr, '/tmp/proj');
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1);
    expect(gh.commentOnPR).toHaveBeenCalledWith('o/r', 9, expect.stringContaining('Review feedback addressed'));
  });

  it('does not loop forever on a formal CHANGES_REQUESTED review that cannot be re-reviewed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    // The same review (same createdAt) is "returned" by GitHub on every poll —
    // real behavior, since pushing a fix does not itself clear the review.
    gh.getPRReviews.mockResolvedValue([
      { author: 'codex', state: 'CHANGES_REQUESTED', createdAt: '2026-08-05T00:00:00.000Z', body: 'please fix' },
    ]);
    const processor = newProcessor();
    const resultPromise = processor.reviewOne(pr, '/tmp/proj');
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    const result = await resultPromise;
    // Regression: without the freshness gate this exhausted all 5 iterations
    // re-fixing the same stale review and reported failure.
    expect(result.success).toBe(true);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1);
  });

  it('reports the pipeline error, not "unknown", when addressing feedback fails', async () => {
    gh.getPRComments.mockResolvedValue([{ author: 'codex', body: 'critical: fix this', createdAt: '2026-08-05T00:00:00.000Z' }]);
    pipelineRunImpl.run.mockResolvedValueOnce({ success: false, iterations: 1, workerResult: { error: 'worker exploded' } });
    const processor = newProcessor();
    const result = await processor.reviewOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toBe('worker exploded');
  });

  it('reports a specific error, not "unknown", when PR context cannot be fetched mid-review', async () => {
    gh.getPRComments.mockResolvedValue([{ author: 'codex', body: 'critical: fix this', createdAt: '2026-08-05T00:00:00.000Z' }]);
    gh.getPRContext.mockResolvedValueOnce(null);
    const processor = newProcessor();
    const result = await processor.reviewOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to fetch PR context/);
  });

  it('persists the watermark across separate reviewOne invocations via the durable state file', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let saved: string | null = null;
    const { atomicWriteFileSync } = await import('../support/atomicFile.js');
    vi.mocked(atomicWriteFileSync).mockImplementation((_path, data) => { saved = data as string; });

    gh.getPRReviews.mockResolvedValue([
      { author: 'codex', state: 'CHANGES_REQUESTED', createdAt: '2026-08-05T00:00:00.000Z', body: 'please fix' },
    ]);
    const processor = newProcessor();
    const firstPromise = processor.reviewOne(pr, '/tmp/proj');
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    const first = await firstPromise;
    expect(first.success).toBe(true);
    expect(saved).not.toBeNull();

    // Second invocation loads what the first one saved — same still-open
    // review must not be re-fixed just because it's a fresh process. Resolved
    // on iteration 1 by the freshness gate, so no inter-iteration delay here.
    readFileImpl.mockResolvedValueOnce(saved as unknown as string);
    const second = await processor.reviewOne(pr, '/tmp/proj');
    expect(second.success).toBe(true);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1); // only the first invocation ran it
  });

  it('builds the "Specific comments" section from getPRReviewComments tied to the reviewer', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gh.getPRReviews.mockResolvedValue([
      { author: 'codex', state: 'CHANGES_REQUESTED', createdAt: '2026-08-05T00:00:00.000Z', body: 'please address' },
    ]);
    gh.getPRReviewComments.mockResolvedValue([
      { author: 'codex', body: 'fix the null check', path: 'src/x.ts', line: 42, createdAt: '2026-08-05T00:00:00.000Z' },
      { author: 'codex', body: 'general note with no path', createdAt: '2026-08-05T00:00:00.000Z' },
      { author: 'someone-else', body: 'unrelated comment', createdAt: '2026-08-05T00:00:00.000Z' },
    ]);
    const processor = newProcessor();
    const resultPromise = processor.reviewOne(pr, '/tmp/proj');
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1);
    expect(gh.getPRReviewComments).toHaveBeenCalledWith('o/r', 9);
  });

  it('runs two full push+comment iterations before finding no further feedback', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    gh.getPRComments
      .mockResolvedValueOnce([{ author: 'codex', body: 'critical: issue A', createdAt: '2026-08-05T00:00:00.000Z' }])
      .mockResolvedValueOnce([{ author: 'codex', body: 'critical: issue B', createdAt: new Date(Date.now() + 60_000).toISOString() }])
      .mockResolvedValueOnce([]);
    const processor = newProcessor();
    const resultPromise = processor.reviewOne(pr, '/tmp/proj');
    await vi.advanceTimersByTimeAsync(15_000);
    const result = await resultPromise;
    expect(result.success).toBe(true);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(2);
    expect(gh.commentOnPR).toHaveBeenCalledTimes(2);
  });

  it('gives up after MAX_REVIEW_ITERATIONS (5) when feedback never resolves', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    gh.getPRReviews.mockImplementation(async () => [
      { author: 'codex', state: 'CHANGES_REQUESTED', createdAt: new Date(Date.now() + 999_999_999).toISOString(), body: 'please fix' },
    ]);
    const processor = newProcessor();
    const resultPromise = processor.reviewOne(pr, '/tmp/proj');
    for (let i = 0; i < 5; i++) {
      await vi.advanceTimersByTimeAsync(5_000);
    }
    const result = await resultPromise;
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Max review feedback iterations/);
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(5);
  });

  it('catches a thrown error inside the review loop and reports it', async () => {
    gh.getPRReviews.mockRejectedValueOnce(new Error('feedback blew up'));
    const processor = newProcessor();
    const result = await processor.reviewOne(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.error).toBe('feedback blew up');
  });

  it('does not throw out of reviewOne when restoring the original branch fails in the finally block', async () => {
    gitExecImpl.mockImplementation(async (args: string[]) => {
      if (args[0] === 'checkout' && args[1] !== pr.branch) {
        throw new Error('checkout restore failed');
      }
      return { stdout: '', stderr: '' };
    });
    const processor = newProcessor();
    const result = await processor.reviewOne(pr, '/tmp/proj');
    expect(result.success).toBe(true);
  });
});

describe('PRProcessor state persistence (INT-3282 coverage)', () => {
  it('rejects instead of silently returning empty state on a non-ENOENT read error', async () => {
    readFileImpl.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    const processor = newProcessor();
    await expect(processor.reviewOne(pr, '/tmp/proj')).rejects.toThrow(/PR processor state is invalid/);
  });
});

describe('PRProcessor.processPRs (INT-3282 coverage)', () => {
  function newScanProcessor(overrides: Partial<import('./prProcessor.js').PRProcessorConfig> = {}) {
    return new PRProcessor({
      repos: ['o/r'], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 1, maxRetries: 1, ...overrides,
    });
  }

  it('does nothing for a repo with zero open PRs', async () => {
    gh.getOpenPRs.mockResolvedValue([]);
    const processor = newScanProcessor();
    await processor.processPRs();
    expect(gh.checkPRConflicts).not.toHaveBeenCalled();
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('attempts resolution for a PR with merge conflicts, bypassing cooldown', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    gh.getOpenPRs.mockResolvedValue([pr]);
    gh.checkPRConflicts.mockResolvedValue(true);
    const processor = newScanProcessor();
    await processor.processPRs();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('will attempt resolution'));
    expect(gh.commentOnPR).toHaveBeenCalledWith('o/r', 9, expect.stringContaining('merge conflicts'));
    logSpy.mockRestore();
  });

  it('processes a PR with formal CHANGES_REQUESTED feedback even inside the cooldown window', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const recentState = {
      prs: {
        'o/r#9': { repo: 'o/r', prNumber: 9, status: 'completed', iterations: 1, lastProcessed: new Date(Date.now() - 60_000).toISOString() },
      },
      updatedAt: new Date().toISOString(),
    };
    readFileImpl.mockResolvedValueOnce(JSON.stringify(recentState));
    gh.getOpenPRs.mockResolvedValue([pr]);
    gh.getPRReviews.mockResolvedValue([
      { author: 'codex', state: 'CHANGES_REQUESTED', createdAt: '2026-08-05T00:00:00.000Z', body: 'please fix' },
    ]);
    const processor = newScanProcessor({ cooldownHours: 24 });
    const scanPromise = processor.processPRs();
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    await scanPromise;
    expect(pipelineRunImpl.run).toHaveBeenCalled();
  });

  it('processes a PR with only comment feedback, bypassing cooldown', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const recentState = {
      prs: {
        'o/r#9': { repo: 'o/r', prNumber: 9, status: 'completed', iterations: 1, lastProcessed: new Date(Date.now() - 60_000).toISOString() },
      },
      updatedAt: new Date().toISOString(),
    };
    readFileImpl.mockResolvedValueOnce(JSON.stringify(recentState));
    gh.getOpenPRs.mockResolvedValue([pr]);
    gh.getPRComments.mockResolvedValue([{ author: 'codex', body: 'critical: fix this please', createdAt: new Date().toISOString() }]);
    const processor = newScanProcessor({ cooldownHours: 24 });
    const scanPromise = processor.processPRs();
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    await scanPromise;
    expect(pipelineRunImpl.run).toHaveBeenCalled();
  });

  it('skips a PR within the cooldown window that has no conflicts or feedback', async () => {
    const recentState = {
      prs: {
        'o/r#9': { repo: 'o/r', prNumber: 9, status: 'completed', iterations: 1, lastProcessed: new Date(Date.now() - 60 * 60 * 1000).toISOString() },
      },
      updatedAt: new Date().toISOString(),
    };
    readFileImpl.mockResolvedValueOnce(JSON.stringify(recentState));
    gh.getOpenPRs.mockResolvedValue([pr]);
    const processor = newScanProcessor({ cooldownHours: 24 });
    await processor.processPRs();
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('skips a PR with no conflicts, no feedback, and passing CI', async () => {
    gh.getOpenPRs.mockResolvedValue([pr]);
    gh.getPRChecks.mockResolvedValue([{ conclusion: 'success' }]);
    const processor = newScanProcessor();
    await processor.processPRs();
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('skips a PR when mapRepoToProject finds no local project', async () => {
    existsSyncImpl.mockReturnValue(false);
    gh.getOpenPRs.mockResolvedValue([pr]);
    const processor = newScanProcessor();
    await processor.processPRs();
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('skips a PR when the scheduler reports the project busy', async () => {
    schedulerImpl.isProjectBusy.mockReturnValue(true);
    gh.getOpenPRs.mockResolvedValue([pr]);
    const processor = newScanProcessor();
    await processor.processPRs();
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('stops scanning when the scheduler reports no available slot', async () => {
    schedulerImpl.hasAvailableSlot.mockReturnValue(false);
    gh.getOpenPRs.mockResolvedValue([pr]);
    const processor = newScanProcessor();
    await processor.processPRs();
    expect(pipelineRunImpl.run).not.toHaveBeenCalled();
  });

  it('handles review feedback directly via the fast path when CI is already passing', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    gh.getOpenPRs.mockResolvedValue([pr]);
    gh.getPRReviews.mockResolvedValue([
      { author: 'codex', state: 'CHANGES_REQUESTED', createdAt: '2026-08-05T00:00:00.000Z', body: 'please fix' },
    ]);
    gh.getPRChecks.mockResolvedValue([{ conclusion: 'success' }]);
    const processor = newScanProcessor();
    const scanPromise = processor.processPRs();
    await vi.advanceTimersByTimeAsync(5_000); // inter-iteration delay between rounds 1 and 2
    await scanPromise;
    // Fast path calls processReviewFeedback directly (one pipeline run to
    // address feedback) instead of the full processPR flow (which would
    // also run a separate CI-fix pipeline pass first).
    expect(pipelineRunImpl.run).toHaveBeenCalledTimes(1);
    expect(gh.commentOnPR).toHaveBeenCalledWith('o/r', 9, expect.stringContaining('Review feedback addressed'));
  });

  it('uses a working custom repo mapping without falling back', async () => {
    existsSyncImpl.mockReturnValue(true);
    gh.getOpenPRs.mockResolvedValue([pr]);
    const processor = newScanProcessor({ repoMappings: { 'o/r': '/custom/path' } });
    await processor.processPRs();
    expect(existsSyncImpl).toHaveBeenCalledWith('/custom/path');
    expect(pipelineRunImpl.run).toHaveBeenCalled();
  });

  it('falls back to the default dev path when the custom mapping does not exist', async () => {
    existsSyncImpl.mockImplementation((p: string) => p !== '/custom/path');
    gh.getOpenPRs.mockResolvedValue([pr]);
    const processor = newScanProcessor({ repoMappings: { 'o/r': '/custom/path' } });
    await processor.processPRs();
    expect(existsSyncImpl).toHaveBeenCalledWith('/custom/path');
    expect(pipelineRunImpl.run).toHaveBeenCalled();
  });

  it('reflects processing state via getStatus while a scan is in flight, then clears it', async () => {
    const processor = newScanProcessor({ repos: [] });
    const runPromise = processor.processPRs();
    expect(processor.getStatus().processing).toBe(true);
    await runPromise;
    expect(processor.getStatus().processing).toBe(false);
    expect(processor.getStatus().currentPR).toBeNull();
  });

  it('skips a second concurrent call while one scan is already processing', async () => {
    gh.getOpenPRs.mockResolvedValue([]);
    const processor = newScanProcessor();
    const [first, second] = await Promise.all([processor.processPRs(), processor.processPRs()]);
    expect(first).toBeUndefined();
    expect(second).toBeUndefined();
    expect(gh.getOpenPRs).toHaveBeenCalledTimes(1);
  });

  it('runs conflict-resolver cascade checks across repos once cascade is enabled', async () => {
    conflictResolverImpl.cascadeEnabled.mockReturnValue(true);
    gh.getOpenPRs.mockResolvedValue([]);
    const processor = new PRProcessor({
      repos: ['o/r'], schedule: '0 0 1 1 *', cooldownHours: 0, maxIterations: 1, maxRetries: 1,
      conflictResolver: { enabled: true, ownershipMode: 'auto', maxResolutionAttempts: 3, cascadeCheck: true },
    });
    await processor.processPRs();
    expect(conflictResolverImpl.checkCascade).toHaveBeenCalledWith('o/r');
  });

  it('logs and recovers instead of throwing when the scan loop errors', async () => {
    gh.getOpenPRs.mockRejectedValueOnce(new Error('github down'));
    const processor = newScanProcessor();
    await expect(processor.processPRs()).resolves.toBeUndefined();
    expect(processor.getStatus().processing).toBe(false);
  });
});

describe('PRProcessor.start/stop (INT-3282 coverage)', () => {
  it('warns instead of starting a second cron schedule while one is already running', () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const processor = newProcessor();
    processor.start();
    processor.start();
    expect(logSpy).toHaveBeenCalledWith('[PRProcessor] Already running');
    processor.stop();
    logSpy.mockRestore();
  });

  it('stop() is a no-op when the processor was never started', () => {
    const processor = newProcessor();
    expect(() => processor.stop()).not.toThrow();
  });

  it('runs an initial processPRs pass once the startup timer fires', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { broadcastEvent } = await import('../core/eventHub.js');
    const processor = newProcessor();
    processor.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pr_processor_start' }));
    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pr_processor_end' }));
    processor.stop();
  });
});

function comment(over: Partial<PRIssueComment> = {}): PRIssueComment {
  return {
    author: 'claude',
    body: '🔴 critical: fix the off-by-one',
    createdAt: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

// Regression: critical-comment detection only ever matched "claude" (the
// claude-review action), so a repo also running a Codex-based review action
// had its feedback silently invisible to `openswarm pr fix`/`pr review` —
// codex left a comment, nothing ever picked it up.
describe('isReviewBotComment', () => {
  it('matches claude and codex authors, case-insensitively', () => {
    expect(isReviewBotComment(comment({ author: 'claude' }))).toBe(true);
    expect(isReviewBotComment(comment({ author: 'claude-review[bot]' }))).toBe(true);
    expect(isReviewBotComment(comment({ author: 'Codex' }))).toBe(true);
    expect(isReviewBotComment(comment({ author: 'chatgpt-codex-connector[bot]' }))).toBe(true);
  });

  it('does not match an unrelated human or bot author', () => {
    expect(isReviewBotComment(comment({ author: 'unohee' }))).toBe(false);
    expect(isReviewBotComment(comment({ author: 'dependabot[bot]' }))).toBe(false);
  });

  it('does not match a human account whose name merely contains "claude" or "codex"', () => {
    // Substring-only matching (no [bot] anchor) would misattribute a human
    // comment as automated reviewer feedback — a name collision, not a bot.
    expect(isReviewBotComment(comment({ author: 'claudex' }))).toBe(false);
    expect(isReviewBotComment(comment({ author: 'codexfan99' }))).toBe(false);
  });
});

describe('getActiveCriticalComments', () => {
  it('picks up a critical Codex comment the same way it would a Claude one', () => {
    const comments = [comment({ author: 'chatgpt-codex-connector[bot]', body: 'bug: null deref on line 42' })];
    expect(getActiveCriticalComments(comments)).toEqual(comments);
  });

  it('ignores a critical-sounding comment from a non-review-bot author', () => {
    const comments = [comment({ author: 'unohee', body: 'this looks like a critical bug to me' })];
    expect(getActiveCriticalComments(comments)).toEqual([]);
  });

  it('does not treat a keyword embedded in an unrelated word as critical', () => {
    // Bare substring matching used to fire inside "debug"/"bugfix"/"prerequisite".
    expect(getActiveCriticalComments([comment({ author: 'codex', body: 'left a debug log statement in, non-blocking' })])).toEqual([]);
    expect(getActiveCriticalComments([comment({ author: 'codex', body: 'a small prerequisite change would help' })])).toEqual([]);
  });

  it('still matches the keyword as a standalone word', () => {
    const comments = [comment({ author: 'codex', body: 'this is required before merge' })];
    expect(getActiveCriticalComments(comments)).toEqual(comments);
  });

  it('drops comments already superseded by a "Review feedback addressed" marker', () => {
    const comments = [
      comment({ author: 'codex', body: 'critical: fix this', createdAt: '2026-08-05T00:00:00.000Z' }),
      comment({ author: 'openswarm-bot', body: 'Review feedback addressed', createdAt: '2026-08-05T01:00:00.000Z' }),
    ];
    expect(getActiveCriticalComments(comments)).toEqual([]);
  });

  it('keeps a critical comment posted after the last "addressed" marker', () => {
    const addressed = comment({ author: 'openswarm-bot', body: 'Review feedback addressed', createdAt: '2026-08-05T00:00:00.000Z' });
    const fresh = comment({ author: 'codex', body: 'critical: new issue found', createdAt: '2026-08-05T01:00:00.000Z' });
    expect(getActiveCriticalComments([addressed, fresh])).toEqual([fresh]);
  });
});

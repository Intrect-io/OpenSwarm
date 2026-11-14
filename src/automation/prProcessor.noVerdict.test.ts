import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PRIssueComment } from './prProcessor.js';
import { ReviewerNoVerdictError } from '../agents/reviewerNoVerdict.js';

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

const { atomicWriteFileSyncImpl } = vi.hoisted(() => ({ atomicWriteFileSyncImpl: vi.fn() }));
vi.mock('../support/atomicFile.js', () => ({ atomicWriteFileSync: atomicWriteFileSyncImpl }));

const { readFileImpl } = vi.hoisted(() => ({
  readFileImpl: vi.fn(async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }),
}));
vi.mock('node:fs/promises', () => ({ readFile: readFileImpl }));

const { withFreshReviewLockImpl } = vi.hoisted(() => ({
  withFreshReviewLockImpl: vi.fn(async <T>(_path: string, operation: () => Promise<T>) => operation()),
}));
vi.mock('./freshReviewLock.js', () => ({ withFreshReviewLock: withFreshReviewLockImpl }));

// mapRepoToProject() calls existsSync from plain 'node:fs' (not 'node:fs/promises'),
// a separate module specifier that needs its own mock.
const { existsSyncImpl } = vi.hoisted(() => ({
  existsSyncImpl: vi.fn((_path: string) => true),
}));
vi.mock('node:fs', () => ({ existsSync: existsSyncImpl }));

const gh = vi.hoisted(() => ({
  getOpenPRs: vi.fn(async () => []),
  getOpenPRsOrThrow: vi.fn(async () => []),
  getMergedPRsOrThrow: vi.fn(async () => []),
  getPRMergeability: vi.fn(async () => 'MERGEABLE' as const),
  getPRContext: vi.fn(async () => ({
    repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', createdAt: '2026-08-05T00:00:00.000Z',
    url: 'https://example/pr/9', author: 'someone', body: '', diff: 'diff --git a/x b/x',
  })),
  checkPRConflicts: vi.fn(async () => false),
  checkPRCIStatus: vi.fn(async () => ({
    status: 'failure' as const,
    headSha: 'head-a',
    failedChecks: [{ name: 'unit', conclusion: 'failure' }],
  })),
  commentOnPR: vi.fn(async () => undefined),
  waitForCICompletion: vi.fn(async () => ({ status: 'success' as const, headSha: 'head-b' })),
  getPRReviews: vi.fn(async () => [] as Array<{ author: string; state?: string; createdAt: string; body: string }>),
  getPRComments: vi.fn(async () => [] as PRIssueComment[]),
  getPRReviewComments: vi.fn(async () => [] as Array<{ author: string; body: string; path?: string; line?: number; createdAt: string }>),
  getPRChecks: vi.fn(async () => [] as Array<{ conclusion: string }>),
  getPRBaseBranchOrThrow: vi.fn(async () => 'main'),
  commentOnPROrThrow: vi.fn(async () => undefined),
}));
vi.mock('../github/github.js', () => gh);
vi.mock('../github/index.js', () => gh);

const { runReviewCommandImpl, formatReviewOutputImpl } = vi.hoisted(() => ({
  runReviewCommandImpl: vi.fn(async () => ({ decision: 'approve' as const, feedback: 'looks good' })),
  formatReviewOutputImpl: vi.fn((r: { decision: string }) => `Decision: ${r.decision.toUpperCase()}`),
}));
vi.mock('../cli/reviewCommand.js', () => ({
  runReviewCommand: runReviewCommandImpl,
  formatReviewOutput: formatReviewOutputImpl,
}));

const { saveReviewHistoryImpl, loadReviewHistoryImpl, captureReviewFileHashesImpl, renderReviewHistoryContextImpl } =
  vi.hoisted(() => ({
    saveReviewHistoryImpl: vi.fn(async () => '/tmp/proj/.openswarm/review-history/rec.json'),
    loadReviewHistoryImpl: vi.fn(async () => ({ records: [], legacyExcerpts: [] })),
    captureReviewFileHashesImpl: vi.fn(async () => ({ 'src/a.ts': 'file:abc' })),
    renderReviewHistoryContextImpl: vi.fn(() => ({ context: 'prior context', matchingRecords: [] })),
  }));
vi.mock('../cli/reviewHistory.js', () => ({
  saveReviewHistory: saveReviewHistoryImpl,
  loadReviewHistory: loadReviewHistoryImpl,
  captureReviewFileHashes: captureReviewFileHashesImpl,
  renderReviewHistoryContext: renderReviewHistoryContextImpl,
}));

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

const { integrationCoordinatorImpl, getOwnedPRsForRepoImpl } = vi.hoisted(() => ({
  integrationCoordinatorImpl: {
    integrate: vi.fn(async () => ({
      repo: 'o/r', mergedPRNumber: 10, mergeCommitOid: 'merge-10', complete: true, results: [],
    })),
  },
  getOwnedPRsForRepoImpl: vi.fn(async () => []),
}));
vi.mock('./integrationCoordinator.js', () => ({
  IntegrationCoordinator: vi.fn().mockImplementation(function IntegrationCoordinatorMock() {
    return integrationCoordinatorImpl;
  }),
}));
vi.mock('./prOwnership.js', () => ({ getOwnedPRsForRepo: getOwnedPRsForRepoImpl }));

const { pipelineRunImpl, createPipelineFromConfigImpl } = vi.hoisted(() => {
  const pipelineRunImpl = {
    run: vi.fn(async () => ({
      success: true,
      iterations: 1,
      workerResult: { summary: 'did the thing', filesChanged: ['a.ts'] },
      reviewResult: { feedback: 'looks good' },
    })),
  };
  return { pipelineRunImpl, createPipelineFromConfigImpl: vi.fn(() => pipelineRunImpl) };
});
vi.mock('../agents/pairPipeline.js', () => ({
  createPipelineFromConfig: createPipelineFromConfigImpl,
}));

const { PRProcessor } = await import('./prProcessor.js');

const pr = { repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', headSha: 'head-a', createdAt: '2026-08-05T00:00:00.000Z', url: 'https://example/pr/9' };

function newProcessor(overrides: Partial<import('./prProcessor.js').PRProcessorConfig> = {}) {
  return new PRProcessor({ repos: [], schedule: '0 0 1 1 *', maxIterations: 3, maxRetries: 3, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  gitExecImpl.mockImplementation(async (args: string[]) => ({
    stdout: args[0] === 'rev-parse' && args[1] === 'HEAD' ? 'head-b\n' : '',
    stderr: '',
  }));
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
  gh.getOpenPRsOrThrow.mockResolvedValue([]);
  gh.getMergedPRsOrThrow.mockResolvedValue([]);
  gh.getPRMergeability.mockResolvedValue('MERGEABLE');
  gh.getPRContext.mockResolvedValue({
    repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x', createdAt: '2026-08-05T00:00:00.000Z',
    url: 'https://example/pr/9', author: 'someone', body: '', diff: 'diff --git a/x b/x',
  });
  gh.checkPRConflicts.mockResolvedValue(false);
  gh.checkPRCIStatus.mockResolvedValue({
    status: 'failure',
    headSha: 'head-a',
    failedChecks: [{ name: 'unit', conclusion: 'failure' }],
  });
  gh.commentOnPR.mockResolvedValue(undefined);
  gh.waitForCICompletion.mockResolvedValue({ status: 'success', headSha: 'head-b' });
  gh.getPRReviews.mockResolvedValue([]);
  gh.getPRComments.mockResolvedValue([]);
  gh.getPRReviewComments.mockResolvedValue([]);
  gh.getPRChecks.mockResolvedValue([]);
  gh.getPRBaseBranchOrThrow.mockResolvedValue('main');
  gh.commentOnPROrThrow.mockResolvedValue(undefined);
  integrationCoordinatorImpl.integrate.mockResolvedValue({
    repo: 'o/r', mergedPRNumber: 10, mergeCommitOid: 'merge-10', complete: true, results: [],
  });
  getOwnedPRsForRepoImpl.mockResolvedValue([]);
  runReviewCommandImpl.mockResolvedValue({ decision: 'approve', feedback: 'looks good' });
  formatReviewOutputImpl.mockImplementation((r: { decision: string }) => `Decision: ${r.decision.toUpperCase()}`);
  pipelineRunImpl.run.mockResolvedValue({
    success: true,
    iterations: 1,
    workerResult: { summary: 'did the thing', filesChanged: ['a.ts'] },
    reviewResult: { feedback: 'looks good' },
  });
});

// AGT-4413: split from prProcessor.test.ts (1000-line cap); same mocks.
describe('PRProcessor.freshReview with no verdict (AGT-4413)', () => {
  beforeEach(() => {
    gitExecImpl.mockImplementation(async (args: string[]) => {
      if (args[0] === 'remote' && args[1] === 'get-url') return { stdout: 'https://github.com/o/r.git\n', stderr: '' };
      if (args[0] === 'repo' && args[1] === 'view') return { stdout: 'o/r\n', stderr: '' };
      if (args[0] === 'rev-parse') return { stdout: 'headsha1234567\n', stderr: '' };
      if (args[0] === 'merge-base') return { stdout: 'mergebasesha123\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
  });

  it('posts the reviewer partial notes under a "no decision" header and stays gate-not-run (AGT-4413)', async () => {
    runReviewCommandImpl.mockRejectedValueOnce(new ReviewerNoVerdictError(
      'reviewer-stage: produced no parseable verdict: Reviewer output carried no verdict',
      'src/a.ts:42 swallows the error; src/b.ts:10 counter never reset',
    ));
    const processor = newProcessor();
    const result = await processor.freshReview(pr, '/tmp/proj');
    expect(result.success).toBe(false);
    expect(result.gateRan).toBe(false);
    expect(result.partialFindingsPosted).toBe(true);
    const body = (gh.commentOnPROrThrow.mock.calls.at(-1) as unknown[] | undefined)?.[2] as string;
    expect(body).toContain('headsha: no decision');
    expect(body).toContain('**Decision: NONE.**');
    expect(body).toContain('src/a.ts:42 swallows the error');
  });

  it('posts nothing for a no-verdict error without partial text, and survives a failed comment', async () => {
    runReviewCommandImpl.mockRejectedValueOnce(new ReviewerNoVerdictError('reviewer-stage: produced no parseable verdict: x', undefined));
    const processor = newProcessor();
    const quiet = await processor.freshReview(pr, '/tmp/proj');
    expect(quiet.partialFindingsPosted).toBeUndefined();
    expect(gh.commentOnPROrThrow).not.toHaveBeenCalled();

    runReviewCommandImpl.mockRejectedValueOnce(new ReviewerNoVerdictError('reviewer-stage: produced no parseable verdict: x', 'notes'));
    gh.commentOnPROrThrow.mockRejectedValueOnce(new Error('gh pr comment exited with code 4'));
    const failed = await processor.freshReview(pr, '/tmp/proj');
    expect(failed.gateRan).toBe(false);
    expect(failed.partialFindingsPosted).toBeUndefined();
  });
});

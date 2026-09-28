import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withPRProcessLease } from './prProcessLease.js';
import { prLeaseLockPath } from './prProcessLease.js';

// The lock under test must be the REAL one: asserting that a mocked lock was
// called would pass even if nothing serialized. Only HOME is redirected, so the
// lease lands in a temp directory instead of the developer's real one.
const { gitExecImpl } = vi.hoisted(() => ({
  gitExecImpl: vi.fn(async (_args: string[]) => ({ stdout: '', stderr: '' })),
}));

vi.mock('node:child_process', () => {
  const CUSTOM = Symbol.for('nodejs.util.promisify.custom');
  function execFile() { throw new Error('execFile called without promisify in test'); }
  (execFile as unknown as Record<symbol, unknown>)[CUSTOM] = (_cmd: string, args: string[]) => gitExecImpl(args);
  return { execFile };
});

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
  checkPRCIStatus: vi.fn(async () => ({ status: 'failure' as const, headSha: 'head-a', failedChecks: [] })),
  commentOnPR: vi.fn(async () => undefined),
  waitForCICompletion: vi.fn(async () => ({ status: 'success' as const, headSha: 'head-b' })),
  getPRReviews: vi.fn(async () => [] as Array<{ author: string; state?: string; createdAt: string; body: string }>),
  getPRComments: vi.fn(async () => [] as Array<{ author: string; body: string; createdAt: string }>),
  getPRReviewComments: vi.fn(async () => []),
  getPRChecks: vi.fn(async () => []),
  getPRBaseBranchOrThrow: vi.fn(async () => 'main'),
  commentOnPROrThrow: vi.fn(async () => undefined),
}));
vi.mock('../github/github.js', () => gh);
vi.mock('../github/index.js', () => gh);
vi.mock('../cli/reviewCommand.js', () => ({
  runReviewCommand: vi.fn(async () => ({ decision: 'approve', feedback: 'ok' })),
  formatReviewOutput: vi.fn(() => 'Decision: APPROVE'),
}));
vi.mock('../cli/reviewHistory.js', () => ({
  saveReviewHistory: vi.fn(async () => '/tmp/x/rec.json'),
  loadReviewHistory: vi.fn(async () => ({ records: [], legacyExcerpts: [] })),
  captureReviewFileHashes: vi.fn(async () => ({})),
  renderReviewHistoryContext: vi.fn(() => ({ context: '', matchingRecords: [] })),
}));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../discord/index.js', () => ({ reportEvent: vi.fn(async () => undefined) }));
vi.mock('../orchestration/taskScheduler.js', () => ({
  getScheduler: vi.fn(() => ({ isProjectBusy: vi.fn(() => false), hasAvailableSlot: vi.fn(() => true) })),
}));
vi.mock('./conflictResolver.js', () => ({
  ConflictResolver: vi.fn().mockImplementation(function ConflictResolverMock() {
    return { isEnabled: vi.fn(() => false), cascadeEnabled: vi.fn(() => false), checkCascade: vi.fn() };
  }),
}));
vi.mock('./integrationCoordinator.js', () => ({
  IntegrationCoordinator: vi.fn().mockImplementation(function IntegrationCoordinatorMock() {
    return { integrate: vi.fn(async () => ({ repo: 'o/r', mergedPRNumber: 10, mergeCommitOid: 'm', complete: true, results: [] })) };
  }),
}));
vi.mock('./prOwnership.js', () => ({ getOwnedPRsForRepo: vi.fn(async () => []) }));

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
vi.mock('../agents/pairPipeline.js', () => ({ createPipelineFromConfig: createPipelineFromConfigImpl }));

let tempHome = '';
let PRProcessor: typeof import('./prProcessor.js').PRProcessor;

const pr = {
  repo: 'o/r', number: 9, title: 'Ship it', branch: 'feat/x',
  headSha: 'head-a', createdAt: '2026-08-05T00:00:00.000Z', url: 'https://example/pr/9',
};

function newProcessor() {
  return new PRProcessor({ repos: [], schedule: '0 0 1 1 *', maxIterations: 3, maxRetries: 3 });
}

/**
 * Take this checkout's lease on behalf of another process.
 *
 * The lock is owner-safe against pid reuse, and a same-process holder is by
 * definition not a rival — so the recorded owner is pid 1, which exists on any
 * host and is never us. Held until `releaseLease`.
 */
function takeForeignLease(projectPath: string): () => void {
  const lockPath = prLeaseLockPath(projectPath);
  mkdirSync(dirname(lockPath), { recursive: true });
  writeFileSync(lockPath, JSON.stringify({ pid: 1, token: 'foreign-holder' }), { encoding: 'utf8', mode: 0o600 });
  return () => rmSync(lockPath, { force: true });
}

describe('PRProcessor.fixOne takes the cross-process PR lease (AGT-3468)', () => {
  beforeEach(async () => {
    vi.resetModules();
    tempHome = mkdtempSync(join(tmpdir(), 'openswarm-prlease-'));
    vi.stubEnv('HOME', tempHome);
    vi.stubEnv('USERPROFILE', tempHome);
    gitExecImpl.mockImplementation(async (args: string[]) => {
      // `rev-parse --abbrev-ref HEAD` names the branch to restore; a bare
      // `rev-parse HEAD` is the SHA processPR publishes against.
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return { stdout: 'main\n', stderr: '' };
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return { stdout: 'head-b\n', stderr: '' };
      return { stdout: '', stderr: '' };
    });
    pipelineRunImpl.run.mockResolvedValue({
      success: true,
      iterations: 1,
      workerResult: { summary: 'did the thing', filesChanged: ['a.ts'] },
      reviewResult: { feedback: 'looks good' },
    });
    ({ PRProcessor } = await import('./prProcessor.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    if (tempHome) rmSync(tempHome, { recursive: true, force: true });
  });

  it('serializes two overlapping fixOne calls instead of letting them interleave', async () => {
    // Two invocations — a `pr fix` racing the daemon, or two CLI calls — both
    // move ONE checkout: stash, checkout pr.branch, commit, push. Without the
    // lease both are inside that window at once. (AGT-3468)
    let active = 0;
    let maxActive = 0;
    const firstEntered = Promise.withResolvers<void>();
    const holdFirst = Promise.withResolvers<void>();
    let entries = 0;

    pipelineRunImpl.run.mockImplementation(async () => {
      active += 1;
      entries += 1;
      maxActive = Math.max(maxActive, active);
      if (entries === 1) {
        firstEntered.resolve();
        await holdFirst.promise;
      }
      active -= 1;
      return {
        success: true, iterations: 1,
        workerResult: { summary: 'done', filesChanged: ['a.ts'] },
        reviewResult: { feedback: 'looks good' },
      };
    });

    const first = newProcessor().fixOne(pr, '/tmp/proj');
    await firstEntered.promise;

    // Start the rival while the first is provably inside its critical section.
    // If the lease did not serialize them, this second run reaches the pipeline
    // immediately and `entries` becomes 2 here.
    const second = newProcessor().fixOne(pr, '/tmp/proj');
    await new Promise((resolve) => setImmediate(resolve));
    expect(entries).toBe(1);

    holdFirst.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(a.success).toBe(true);
    expect(b.success).toBe(true);
    // Both eventually ran, and never two at once.
    expect(entries).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('refuses instead of crashing when another process already holds the lease', async () => {
    // A refusal the CLI can print and retry; an unhandled lock timeout would
    // surface as a crash with no explanation. (AGT-3468)
    //
    // The holder is a real second process: a same-process lock would be
    // reclaimed as ours, so the lease must be taken from outside this one.
    const releaseLease = takeForeignLease('/tmp/proj');
    try {
      const result = await withPRProcessLease('/tmp/proj', 'o/r#9', async () => {
        throw new Error('the operation must not run while the lease is held');
      }, 150);
      expect(result).toEqual({
        success: false,
        error: 'Another process owns the PR processing lease',
        iterations: 0,
      });
    } finally {
      releaseLease();
    }
  });
});

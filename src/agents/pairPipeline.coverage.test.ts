// Additional coverage for src/agents/pairPipeline.ts targeting branches the
// companion pairPipeline.test.ts does not exercise: tester-stage execution,
// documenter/auditor/skill-documenter success paths, blocking/non-blocking
// pipeline guards, stuck-loop detection, cancellation, non-infra error
// propagation, worker-context collection edge cases, and the pipeline factory
// helpers. Mocking conventions mirror pairPipeline.test.ts (partial mocks via
// vi.importActual, keeping the real pure helpers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkerOptions } from './worker.js';
import type { ReviewerOptions } from './reviewer.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { GuardsRunResult } from './pipelineGuards.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const runTester = vi.fn();
const runDocumenter = vi.fn();
const runAuditor = vi.fn();
const runSkillDocumenter = vi.fn();
const runGuards = vi.fn();
const broadcastEvent = vi.fn();
const getDefaultModel = vi.fn();
const hasRepoSnapshot = vi.fn();
const scanAndCache = vi.fn();
const analyzeIssue = vi.fn();
const recallRepoKnowledge = vi.fn();

vi.mock('./worker.js', async () => {
  const actual = await vi.importActual<typeof import('./worker.js')>('./worker.js');
  return { ...actual, runWorker };
});

vi.mock('./reviewer.js', async () => {
  const actual = await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js');
  return { ...actual, runReviewer };
});

vi.mock('./tester.js', async () => {
  const actual = await vi.importActual<typeof import('./tester.js')>('./tester.js');
  return { ...actual, runTester };
});

vi.mock('./documenter.js', async () => {
  const actual = await vi.importActual<typeof import('./documenter.js')>('./documenter.js');
  return { ...actual, runDocumenter };
});

vi.mock('./auditor.js', async () => {
  const actual = await vi.importActual<typeof import('./auditor.js')>('./auditor.js');
  return { ...actual, runAuditor };
});

vi.mock('./skillDocumenter.js', async () => {
  const actual = await vi.importActual<typeof import('./skillDocumenter.js')>('./skillDocumenter.js');
  return { ...actual, runSkillDocumenter };
});

vi.mock('./pipelineGuards.js', async () => {
  const actual = await vi.importActual<typeof import('./pipelineGuards.js')>('./pipelineGuards.js');
  return { ...actual, runGuards };
});

vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot,
  scanAndCache,
  analyzeIssue,
}));

vi.mock('../memory/repoKnowledge.js', () => ({
  recallRepoKnowledge,
}));

vi.mock('../core/eventHub.js', () => ({
  broadcastEvent,
}));

vi.mock('../adapters/index.js', async () => {
  const actual = await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js');
  return { ...actual, getAdapter: () => ({ getDefaultModel }) };
});

describe('PairPipeline coverage extension', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    runWorker.mockResolvedValue({
      success: true,
      summary: 'done',
      filesChanged: ['src/example.ts'],
      commands: ['npm test -- src/example.test.ts'],
      output: '',
      confidencePercent: 95,
    });
    runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'approved' });
    runTester.mockResolvedValue({
      success: true, testsPassed: 1, testsFailed: 0, output: 'PASS',
    } satisfies TesterResult);
    runDocumenter.mockResolvedValue({
      success: true, updatedFiles: ['docs/usage.md'], apiDocsUpdated: false, summary: 'docs updated',
    } satisfies DocumenterResult);
    runAuditor.mockResolvedValue({
      success: true, criticalCount: 0, warningCount: 0, minorCount: 0, issues: [], summary: 'clean',
    } satisfies AuditorResult);
    runSkillDocumenter.mockResolvedValue({
      success: true, updatedFiles: ['skills/example/SKILL.md'], summary: 'skill doc updated',
    } satisfies SkillDocumenterResult);
    runGuards.mockResolvedValue({
      allPassed: true, results: [], combinedIssues: [],
    } satisfies GuardsRunResult);
    getDefaultModel.mockResolvedValue('codex-live-model');
    hasRepoSnapshot.mockReturnValue(true);
    scanAndCache.mockResolvedValue(undefined);
    analyzeIssue.mockResolvedValue(undefined);
    recallRepoKnowledge.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  function task(overrides: Partial<TaskItem> = {}): TaskItem {
    return {
      id: 'task-cov-1',
      source: 'linear',
      title: 'coverage task',
      description: 'exercise pairPipeline branches not hit by the main spec',
      priority: 1,
      createdAt: Date.now(),
      estimatedMinutes: 30,
      ...overrides,
    };
  }

  // ============================================
  // Factory functions
  // ============================================

  describe('factory functions', () => {
    it('createDefaultPipeline builds a worker+reviewer pipeline', async () => {
      const { createDefaultPipeline } = await import('./pairPipeline.js');
      const pipeline = createDefaultPipeline(5);
      const config = (pipeline as unknown as { config: { stages: string[]; maxIterations: number } }).config;
      expect(config.stages).toEqual(['worker', 'reviewer']);
      expect(config.maxIterations).toBe(5);
    });

    it('createFullPipeline builds worker+reviewer+tester+documenter with defaults', async () => {
      const { createFullPipeline } = await import('./pairPipeline.js');
      const pipeline = createFullPipeline();
      const config = (pipeline as unknown as {
        config: { stages: string[]; continueOnTestFail: boolean; skipDocumenterIfNoChange: boolean };
      }).config;
      expect(config.stages).toEqual(['worker', 'reviewer', 'tester', 'documenter']);
      expect(config.continueOnTestFail).toBe(false);
      expect(config.skipDocumenterIfNoChange).toBe(true);
    });

    it('createPipelineFromConfig derives the stage list from enabled roles', async () => {
      const { createPipelineFromConfig } = await import('./pairPipeline.js');
      const pipeline = createPipelineFromConfig({
        worker: { enabled: false, timeoutMs: 0 },
        reviewer: { enabled: false, timeoutMs: 0 },
        tester: { enabled: true, timeoutMs: 0 },
        documenter: { enabled: true, timeoutMs: 0 },
        auditor: { enabled: true, timeoutMs: 0 },
        'skill-documenter': { enabled: true, timeoutMs: 0 },
      });
      const config = (pipeline as unknown as { config: { stages: string[] } }).config;
      // worker/reviewer explicitly disabled → excluded; the rest opted in via enabled:true.
      expect(config.stages).toEqual(['tester', 'documenter', 'auditor', 'skill-documenter']);
    });

    it('createPipelineFromConfig defaults worker/reviewer to enabled when omitted', async () => {
      const { createPipelineFromConfig } = await import('./pairPipeline.js');
      const pipeline = createPipelineFromConfig(undefined);
      const config = (pipeline as unknown as { config: { stages: string[] } }).config;
      expect(config.stages).toEqual(['worker', 'reviewer']);
    });
  });

  // ============================================
  // Early-exit / guard branches in run()
  // ============================================

  it('fails immediately without running anything when no worker stage is configured', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['reviewer'],
      maxIterations: 1,
      roles: { reviewer: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(false);
    expect(runWorker).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it('cancels immediately when the run is started with an already-aborted signal', async () => {
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 3,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });
    const controller = new AbortController();
    controller.abort();

    const result = await pipeline.run(task(), process.cwd(), { signal: controller.signal });

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('cancelled');
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('scans the repo when no snapshot exists yet, then proceeds', async () => {
    hasRepoSnapshot.mockReturnValue(false);
    scanAndCache.mockResolvedValueOnce(undefined);
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(scanAndCache).toHaveBeenCalledWith(process.cwd());
  });

  it('tolerates a repo-scan failure as non-blocking and still runs the worker', async () => {
    hasRepoSnapshot.mockReturnValue(false);
    scanAndCache.mockRejectedValueOnce(new Error('scan crashed'));
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  // ============================================
  // Worker-context collection (draftAnalysis passthrough / recall / failure)
  // ============================================

  it('passes draft impactAnalysis/registrySnapshot and recalled memories straight to the worker (verbose)', async () => {
    recallRepoKnowledge.mockResolvedValueOnce(['Prior PR added retry logic to the cache invalidation layer.']);
    runWorker.mockResolvedValueOnce({
      success: true,
      summary: 'implemented the retry fix',
      filesChanged: ['src/cache.ts'],
      commands: ['npm test -- src/cache.test.ts'],
      output: 'PASS',
      confidencePercent: 88,
      haltReason: 'Uncertain whether the tenant-scoping edge case is fully covered.',
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      verbose: true,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
      draftAnalysis: {
        taskType: 'bugfix',
        intentSummary: 'Fix tenant-scoped cache invalidation.',
        relevantFiles: ['src/cache.ts'],
        suggestedApproach: 'Scope invalidation keys per tenant.',
        completionCriteria: ['Cache invalidation is tenant-scoped'],
        sufficient: true,
        impactAnalysis: {
          directModules: ['src/cache.ts'],
          dependentModules: ['src/agents/pairPipeline.ts'],
          testFiles: ['src/cache.test.ts'],
          estimatedScope: 'small',
        },
        registrySnapshot: [{ filePath: 'src/cache.ts', summary: 'Cache module', highlights: [] }],
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    const workerCall = runWorker.mock.calls[0][0] as WorkerOptions;
    expect(workerCall.workerContext?.impactAnalysis?.directModules).toEqual(['src/cache.ts']);
    expect(workerCall.workerContext?.registryBriefs?.[0].filePath).toBe('src/cache.ts');
    expect(workerCall.workerContext?.repoMemories).toEqual(['Prior PR added retry logic to the cache invalidation layer.']);
    // analyzeIssue/getRegistryStore must NOT be consulted — the draft already
    // supplied both, so the (heavy) fallback collection path is skipped.
    expect(analyzeIssue).not.toHaveBeenCalled();
  });

  it('treats a worker-context collection failure as non-blocking (analyzeIssue throws)', async () => {
    analyzeIssue.mockRejectedValueOnce(new Error('analyzer exploded'));
    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('Worker context collection failed'),
      'Error: analyzer exploded',
    );
    // Falls back to undefined worker context rather than failing the run.
    const workerCall = runWorker.mock.calls[0][0] as WorkerOptions;
    expect(workerCall.workerContext).toBeUndefined();
  });

  it('flags a sudden confidence drop as needing intervention', async () => {
    // Iteration 1: high (PROCEED-eligible) confidence. Reviewer asks for a
    // revision so a 2nd worker attempt happens. Iteration 2: confidence craters
    // — the tracker's "PROCEED → below HALT" sudden-drop check should fire
    // (checked inside runStage() right after the 2nd worker call completes).
    runWorker
      .mockResolvedValueOnce({
        success: true, summary: 'ok', filesChanged: ['src/example.ts'],
        commands: ['npm test -- src/example.test.ts'], output: 'PASS', confidencePercent: 95,
      })
      .mockResolvedValueOnce({
        success: true, summary: 'ok', filesChanged: ['src/example.ts'],
        commands: ['npm test -- src/example.test.ts'], output: 'PASS', confidencePercent: 10,
      });
    runReviewer.mockResolvedValueOnce({
      decision: 'revise',
      feedback: 'The retry handling still drops the cursor state between pages; fix it.',
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 2,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
      },
    });

    await pipeline.run(task(), process.cwd());

    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Confidence intervention needed'));
  });

  // ============================================
  // Worker-failure retry + stuck-loop detection
  // ============================================

  it('detects a stuck loop after 3 identical non-infra worker failures and aborts without exhausting maxIterations', async () => {
    // Same (non-infra) message every time → StuckDetector's error-loop check
    // (sameErrorRepeat: 3) should trip at the start of the would-be 4th iteration.
    runWorker.mockRejectedValue(new Error('the config loader keeps failing the same schema validation check'));

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 4,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result).toMatchObject({
      success: false,
      failureSignal: 'stuck',
      stuckReason: expect.stringContaining('Same error repeated'),
    });
    // Stuck detection fires before a 4th worker call would happen.
    expect(runWorker).toHaveBeenCalledTimes(3);
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('STUCK DETECTED'));
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Same error repeated'));
  });

  // cgf-portal AX-868 reached attempt 27 and AGT-3844 attempt 53 on 2026-09-02
  // this way: the worker claimed success, changed nothing, gave no reason, and
  // the run was re-asked the same question at ~900k tokens a time.
  it('parks a stuck loop of empty worker results for the operator instead of leaving it retryable', async () => {
    runWorker.mockResolvedValue({
      success: false,
      summary: 'nothing',
      filesChanged: [],
      commands: [],
      output: '',
      zeroDiffWithoutReason: true,
      error: 'Worker reported success with no changed files and no explicit noChangesReason.',
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 4,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.failureSignal).toBe('stuck');
    expect(result.operatorPark).toEqual({
      code: 'worker_no_changes',
      reason: expect.stringContaining('without changing a file'),
    });
  });

  it('leaves an ordinary stuck loop retryable — only the empty-worker contract parks', async () => {
    runWorker.mockRejectedValue(new Error('the config loader keeps failing the same schema validation check'));

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 4,
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    expect((await pipeline.run(task(), process.cwd())).operatorPark).toBeUndefined();
  });

  // ============================================
  // Pipeline guards (blocking vs non-blocking)
  // ============================================

  it('aborts self-repair once a blocking guard failure stagnates on identical issues', async () => {
    runGuards.mockResolvedValue({
      allPassed: false,
      results: [{ guard: 'qualityGate', passed: false, blocking: true, issues: ['TS2322: type mismatch in cache.ts'] }],
      combinedIssues: ['TS2322: type mismatch in cache.ts'],
    } satisfies GuardsRunResult);

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 5,
      guards: { qualityGate: true },
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(false);
    // Iteration 1: guard fails (first occurrence → "progressed"), continues.
    // Iteration 2: identical issue → stagnation → shouldAbortSelfRepair() returns
    // true and the loop stops WITHOUT reaching the configured max of 5.
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runGuards).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Aborting self-repair'));
  });

  it('surfaces non-blocking guard warnings to the reviewer without retrying', async () => {
    runGuards.mockResolvedValue({
      allPassed: true,
      results: [{ guard: 'reformatCheck', passed: false, blocking: false, issues: ['Cosmetic reformat detected in cache.ts'] }],
      combinedIssues: ['Cosmetic reformat detected in cache.ts'],
    } satisfies GuardsRunResult);

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      guards: { qualityGate: true },
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Guard warnings: reformatCheck'));
    const reviewerCall = runReviewer.mock.calls[0][0] as ReviewerOptions;
    expect(reviewerCall.guardWarnings).toEqual(['Cosmetic reformat detected in cache.ts']);
  });

  it('propagates a non-infra error thrown outside stage execution as a plain failure', async () => {
    // runGuards() is NOT wrapped by runStage()'s try/catch (it runs directly in
    // the iteration loop), so a plain rejection here reaches run()'s top-level
    // catch unclassified — neither rate-limited, infra, nor cancelled.
    runGuards.mockRejectedValueOnce(new Error('guard evaluation exploded unexpectedly'));

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker'],
      maxIterations: 1,
      guards: { qualityGate: true },
      roles: { worker: { enabled: true, timeoutMs: 0 } },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(console.error).toHaveBeenCalledWith(
      '[%s] Error:',
      expect.any(String),
      'Error: guard evaluation exploded unexpectedly',
    );
  });

  // ============================================
  // Tester stage (execution, failure/retry, success)
  // ============================================

  it('retries after a tester failure then succeeds on the next iteration (verbose)', async () => {
    runTester
      .mockResolvedValueOnce({
        success: false,
        testsPassed: 2,
        testsFailed: 1,
        output: 'FAIL src/cache.test.ts',
        failedTests: ['cache.test.ts > invalidates per tenant'],
        suggestions: ['Scope the invalidation key by tenant id'],
      } satisfies TesterResult)
      .mockResolvedValueOnce({
        success: true,
        testsPassed: 3,
        testsFailed: 0,
        output: 'PASS',
      } satisfies TesterResult);

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'tester'],
      maxIterations: 2,
      verbose: true,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        tester: { enabled: true, timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runTester).toHaveBeenCalledTimes(2);
    // Second worker call carries the objective test-failure feedback forward.
    expect(runWorker.mock.calls[1][0]).toEqual(expect.objectContaining({
      previousFeedback: expect.stringContaining('tests failed'),
    }));
  });

  it('aborts self-repair when the tester keeps failing with the identical error', async () => {
    // Same failure every call → recordReflection() sees identical errors on the
    // 2nd objective 'test' entry → progressed:false → shouldAbortSelfRepair()
    // returns true and the loop stops instead of burning the full iteration budget.
    runTester.mockResolvedValue({
      success: false,
      testsPassed: 0,
      testsFailed: 1,
      output: 'FAIL',
      failedTests: ['cache.test.ts > invalidates per tenant'],
      suggestions: ['Scope the invalidation key by tenant id'],
    } satisfies TesterResult);

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'tester'],
      maxIterations: 5,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        tester: { enabled: true, timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(false);
    // Iteration 1: first objective failure → progressed. Iteration 2: identical
    // failure → stagnation → abort, well short of the configured max of 5.
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runTester).toHaveBeenCalledTimes(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Aborting self-repair'));
  });

  // ============================================
  // Post-success stages: skip vs run, totalCost aggregation
  // ============================================

  it('skips documenter and auditor when there is not enough change to justify them', async () => {
    runWorker.mockResolvedValueOnce({
      success: true,
      summary: 'Investigated the report and confirmed no code change was actually necessary.',
      filesChanged: [],
      commands: [],
      output: 'Investigation complete: existing behavior already satisfies the request in full detail.',
      noChangesReason: 'Current implementation already satisfies the task; no code edit is required.',
      confidencePercent: 90,
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer', 'documenter', 'auditor'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
        documenter: { enabled: true, timeoutMs: 0 },
        auditor: { enabled: true, timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runDocumenter).not.toHaveBeenCalled();
    expect(runAuditor).not.toHaveBeenCalled();
  });

  it('runs documenter, auditor, and skill-documenter to success and aggregates total cost', async () => {
    runWorker.mockResolvedValueOnce({
      success: true,
      summary: 'Refactored the cache invalidation to be tenant-scoped.',
      filesChanged: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      commands: ['npm test -- src/cache.test.ts'],
      output: 'PASS',
      confidencePercent: 95,
      costInfo: {
        costUsd: 0.01, inputTokens: 1000, outputTokens: 200,
        cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 5000, model: 'worker-model',
      },
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer', 'documenter', 'auditor', 'skill-documenter'],
      maxIterations: 1,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
        documenter: { enabled: true, timeoutMs: 0 },
        auditor: { enabled: true, timeoutMs: 0 },
        'skill-documenter': { enabled: true, timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    expect(runDocumenter).toHaveBeenCalledTimes(1);
    expect(runAuditor).toHaveBeenCalledTimes(1);
    expect(runSkillDocumenter).toHaveBeenCalledTimes(1);
    expect(result.documenterResult?.success).toBe(true);
    expect(result.auditorResult?.success).toBe(true);
    expect(result.skillDocumenterResult?.success).toBe(true);
    expect(result.totalCost).toBeDefined();
    expect(result.totalCost?.inputTokens).toBe(1000);
    const costEvent = broadcastEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === 'task:cost');
    expect(costEvent).toBeDefined();
  });

  // ============================================
  // Reviewer: reject + escalation
  // ============================================

  it('terminates the pipeline immediately when the reviewer rejects', async () => {
    runReviewer.mockResolvedValueOnce({ decision: 'reject', feedback: 'This approach is fundamentally unsound.' });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 3,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(false);
    expect(result.lastReviewFeedback).toBe('This approach is fundamentally unsound.');
    expect(runWorker).toHaveBeenCalledTimes(1);
    expect(runReviewer).toHaveBeenCalledTimes(1);
  });

  it('escalates the reviewer to the configured model at the configured iteration threshold (verbose)', async () => {
    runReviewer.mockResolvedValueOnce({
      decision: 'approve',
      feedback: 'Looks solid overall.\nGood test coverage on the tenant scoping.\nShip it.',
    });

    const { PairPipeline } = await import('./pairPipeline.js');
    const pipeline = new PairPipeline({
      stages: ['worker', 'reviewer'],
      maxIterations: 1,
      verbose: true,
      roles: {
        worker: { enabled: true, timeoutMs: 0 },
        reviewer: { enabled: true, timeoutMs: 0, escalateModel: 'reviewer-big', escalateAfterIteration: 1 },
      },
    });

    const result = await pipeline.run(task(), process.cwd());

    expect(result.success).toBe(true);
    // The escalation decision is logged and drives both the displayed stage
    // model and the model passed to the actual reviewer invocation.
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Reviewer escalation → reviewer-big'));
    const reviewerStageEvent = broadcastEvent.mock.calls
      .map((c) => c[0])
      .find((e) => e.type === 'pipeline:stage' && e.data.stage === 'reviewer' && e.data.status === 'complete');
    expect(reviewerStageEvent?.data.model).toBe('reviewer-big');
    expect(runReviewer.mock.calls[0][0]).toEqual(expect.objectContaining({ model: 'reviewer-big' }));
  });
});

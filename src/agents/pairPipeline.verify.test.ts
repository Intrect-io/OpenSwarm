import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { VerifyCommand } from '../verify/manifest.js';

const runWorker = vi.fn();
const runReviewer = vi.fn();
const runTester = vi.fn();
const loadVerifyManifest = vi.fn();
const discoverVerifyCommands = vi.fn();
const runVerify = vi.fn();
const resolveBaseRef = vi.fn();
const listTrackedSecurityFiles = vi.fn();
const runSecurityAudit = vi.fn();

vi.mock('./worker.js', async () => ({
  ...(await vi.importActual<typeof import('./worker.js')>('./worker.js')),
  runWorker,
}));
vi.mock('./reviewer.js', async () => ({
  ...(await vi.importActual<typeof import('./reviewer.js')>('./reviewer.js')),
  runReviewer,
}));
vi.mock('./tester.js', async () => ({
  ...(await vi.importActual<typeof import('./tester.js')>('./tester.js')),
  runTester,
}));
vi.mock('../verify/manifest.js', async () => ({
  ...(await vi.importActual<typeof import('../verify/manifest.js')>('../verify/manifest.js')),
  loadVerifyManifest,
}));
vi.mock('../verify/discover.js', () => ({ discoverVerifyCommands }));
vi.mock('../verify/runner.js', () => ({ runVerify }));
vi.mock('../verify/securityAudit.js', async () => ({
  ...(await vi.importActual<typeof import('../verify/securityAudit.js')>('../verify/securityAudit.js')),
  listTrackedSecurityFiles,
  runSecurityAudit,
}));
vi.mock('../support/worktreeManager.js', async () => ({
  ...(await vi.importActual<typeof import('../support/worktreeManager.js')>('../support/worktreeManager.js')),
  resolveBaseRef,
}));
vi.mock('../knowledge/index.js', () => ({
  hasRepoSnapshot: () => true,
  scanAndCache: vi.fn(),
  analyzeIssue: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn().mockResolvedValue([]) }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));
vi.mock('../adapters/index.js', async () => ({
  ...(await vi.importActual<typeof import('../adapters/index.js')>('../adapters/index.js')),
  getAdapter: () => ({ getDefaultModel: vi.fn().mockResolvedValue('default-model') }),
}));

const verifyCommand: VerifyCommand = {
  name: 'unit tests',
  run: 'npm test',
  kind: 'test',
  timeoutMs: 300_000,
};

function task(): TaskItem {
  return {
    id: 'verify-task',
    source: 'linear',
    title: 'verify deterministic tester',
    description: 'exercise deterministic tester selection',
    priority: 1,
    createdAt: Date.now(),
  };
}

async function runPipeline(options: {
  stages?: Array<'worker' | 'tester' | 'reviewer'>;
  maxIterations?: number;
  maxReflections?: number;
  continueOnTestFail?: boolean;
  skipTesterIfNoCodeChange?: boolean;
  verbose?: boolean;
  verify?: { enabled: boolean; blockOnNewFailures: boolean; maxCommands: number };
  securityAudit?: { enabled: boolean; maxThreads: number };
} = {}) {
  const { PairPipeline } = await import('./pairPipeline.js');
  const pipeline = new PairPipeline({
    stages: ['worker', 'tester', 'reviewer'],
    maxIterations: 1,
    skipTesterIfNoCodeChange: false,
    verify: { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
    ...options,
  });
  const logs: string[] = [];
  pipeline.on('log', ({ line }) => logs.push(line));
  return { result: await pipeline.run(task(), process.cwd()), logs };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  runWorker.mockResolvedValue({
    success: true,
    summary: 'implemented',
    filesChanged: ['src/example.ts'],
    commands: [],
    output: '',
    confidencePercent: 100,
  });
  runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'approved' });
  runTester.mockResolvedValue({ success: true, testsPassed: 1, testsFailed: 0, output: 'LLM tester' });
  loadVerifyManifest.mockResolvedValue({ manifest: null });
  discoverVerifyCommands.mockResolvedValue([]);
  resolveBaseRef.mockResolvedValue({ remote: 'origin', branch: 'main', ref: 'origin/main' });
  listTrackedSecurityFiles.mockResolvedValue(['src/example.ts']);
  runSecurityAudit.mockResolvedValue({
    status: 'passed',
    codeqlLanguages: ['javascript'],
    skippedCodeqlLanguages: [],
    findings: [],
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PairPipeline deterministic tester (INT-2662)', () => {
  it('treats CodeQL partial coverage as a known extractor gap, not infrastructure failure', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Go/Swift extractors reject --build-mode=none permanently. Baseline and
    // current skip the same languages, so the introduced-findings comparison
    // stays sound; failing closed here parked every Go pipeline (AGT-3841).
    runWorker.mockResolvedValue({
      success: true,
      summary: 'implemented',
      filesChanged: ['src/example.ts'],
      commands: ['npm test'],
      output: '',
      confidencePercent: 100,
    });
    runSecurityAudit.mockResolvedValue({
      status: 'partial',
      codeqlLanguages: ['javascript', 'swift'],
      skippedCodeqlLanguages: ['swift'],
      findings: [],
      detail: 'Swift does not support build-mode=none.',
    });

    const { result } = await runPipeline({
      stages: ['worker', 'reviewer'],
      securityAudit: { enabled: true, maxThreads: 2 },
    });

    expect(result).toMatchObject({ success: true, finalStatus: 'approved' });
    expect(runSecurityAudit).toHaveBeenCalledTimes(2);
    expect(runWorker).toHaveBeenCalled();
    expect(runReviewer).toHaveBeenCalled();
    // The gap is accepted but never silent: the log names the language (AGT-4098).
    expect(warn.mock.calls.map((call) => String(call[0])))
      .toEqual(expect.arrayContaining([expect.stringMatching(/CodeQL coverage is partial — not analysed: swift\. Swift does not support build-mode=none\./)]));
  });

  it('blocks new CodeQL findings even when the tester stage is not configured', async () => {
    runSecurityAudit
      .mockResolvedValueOnce({
        status: 'passed',
        codeqlLanguages: ['javascript'],
        skippedCodeqlLanguages: [],
        findings: [],
      })
      .mockResolvedValueOnce({
        status: 'findings',
        codeqlLanguages: ['javascript'],
        skippedCodeqlLanguages: [],
        findings: [{
          ruleId: 'codeql/js/file-access-to-http', level: 'error', message: 'outbound file data', filePath: 'src/new.ts', line: 12,
        }],
      });

    const { result } = await runPipeline({
      stages: ['worker', 'reviewer'],
      securityAudit: { enabled: true, maxThreads: 2 },
    });

    expect(result).toMatchObject({ success: false, finalStatus: 'failed' });
    expect(runSecurityAudit).toHaveBeenCalledTimes(2);
    expect(runTester).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it('reaches deterministic verify for a package-only change with a one-iteration budget', async () => {
    runWorker.mockResolvedValue({
      success: true, summary: 'updated package config', filesChanged: ['package.json'],
      commands: [], output: '', confidencePercent: 100,
    });
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand, baseStatus: 'skipped', headStatus: 'pass', newFailure: false,
      rawOutputTail: 'pass', durationMs: 1,
    }]);

    const { result } = await runPipeline({ skipTesterIfNoCodeChange: true });

    expect(result.success).toBe(true);
    expect(runVerify).toHaveBeenCalledOnce();
    expect(runReviewer).toHaveBeenCalledOnce();
  });

  it('pins verification commands before the worker can weaken the manifest', async () => {
    const weakened = { ...verifyCommand, name: 'weakened', run: 'true' };
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [verifyCommand] } });
    runWorker.mockImplementation(async () => {
      loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [weakened] } });
      return {
        success: true, summary: 'weakened manifest', filesChanged: ['.openswarm/verify.yaml'],
        commands: [], output: '', confidencePercent: 100,
      };
    });
    runVerify.mockResolvedValue([{
      command: verifyCommand, baseStatus: 'skipped', headStatus: 'pass', newFailure: false,
      rawOutputTail: 'pass', durationMs: 1,
    }]);

    await runPipeline();

    expect(loadVerifyManifest).toHaveBeenCalledOnce();
    expect(loadVerifyManifest.mock.invocationCallOrder[0]).toBeLessThan(runWorker.mock.invocationCallOrder[0]);
    expect(runVerify).toHaveBeenCalledWith(expect.objectContaining({ commands: [verifyCommand] }));
  });

  it('uses manifest commands without calling the LLM tester', async () => {
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [verifyCommand] } });
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'skipped',
      headStatus: 'pass',
      newFailure: false,
      rawOutputTail: '1 passed',
      durationMs: 5,
    }]);
    const { result, logs } = await runPipeline({ verbose: true });
    expect(result.success).toBe(true);
    expect(result.testerResult).toMatchObject({ success: true, deterministic: true, testsPassed: 1, testsFailed: 0 });
    expect(runTester).not.toHaveBeenCalled();
    expect(discoverVerifyCommands).not.toHaveBeenCalled();
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining({
      verificationEvidence: [expect.objectContaining({ headStatus: 'pass', newFailure: false })],
    }));
    expect(logs).toContainEqual(expect.stringContaining('(deterministic)'));
  });

  it('uses discovered commands when the manifest is absent', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'fail',
      headStatus: 'fail',
      newFailure: false,
      rawOutputTail: 'pre-existing failure',
      durationMs: 5,
    }]);
    const { result } = await runPipeline();
    expect(result.success).toBe(true);
    expect(result.testerResult).toMatchObject({ deterministic: true, testsPassed: 0, testsFailed: 1 });
    expect(runTester).not.toHaveBeenCalled();
  });

  it('falls back to the LLM tester only when no commands are available', async () => {
    const { result } = await runPipeline();
    expect(result.success).toBe(true);
    expect(runTester).toHaveBeenCalledOnce();
    expect(result.testerResult?.deterministic).toBeUndefined();
  });

  it('fails closed when the explicit verification manifest is invalid', async () => {
    loadVerifyManifest.mockResolvedValue({ manifest: null, error: 'commands[0].run is required' });
    const { result } = await runPipeline();
    expect(result.success).toBe(false);
    expect(result.stages.at(-1)).toMatchObject({ stage: 'tester', success: false });
    expect(runTester).not.toHaveBeenCalled();
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it('downgrades deterministic infrastructure failures to the LLM fallback', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'skipped',
      headStatus: 'infra',
      newFailure: false,
      rawOutputTail: 'timeout after 20ms',
      durationMs: 20,
    }]);
    const { result, logs } = await runPipeline();
    expect(result).toMatchObject({ success: true, finalStatus: 'approved' });
    expect(result.testerResult?.deterministic).toBeUndefined();
    expect(runTester).toHaveBeenCalledOnce();
    expect(runReviewer).toHaveBeenCalledOnce();
    // The downgrade is on the stage log, not only stderr (AGT-4416).
    expect(logs).toEqual(expect.arrayContaining([expect.stringMatching(/^Deterministic verify unavailable; falling back to LLM tester: verify-runner: /)]));
  });

  it('downgrades an unavailable baseline comparison to the LLM fallback', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand, baseStatus: 'infra', headStatus: 'fail', newFailure: false,
      rawOutputTail: 'unable to create baseline worktree', durationMs: 20,
    }]);
    const { result } = await runPipeline();
    expect(result).toMatchObject({ success: true, finalStatus: 'approved' });
    expect(result.testerResult?.deterministic).toBeUndefined();
    expect(runTester).toHaveBeenCalledOnce();
  });

  it('preserves self-repair when an LLM fallback reports failure', async () => {
    runTester.mockResolvedValue({
      success: false, testsPassed: 0, testsFailed: 1, failedTests: ['LLM failure'], output: 'failed',
    });
    const { result } = await runPipeline();
    expect(result.success).toBe(false);
    expect(runTester).toHaveBeenCalledOnce();
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it('lets the reviewer judge a deterministic new failure', async () => {
    runReviewer.mockResolvedValue({
      decision: 'revise', feedback: 'unit tests introduced a new regression', issues: ['unit tests'],
    });
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'pass',
      headStatus: 'fail',
      newFailure: true,
      rawOutputTail: 'new regression',
      durationMs: 5,
    }]);
    const { result } = await runPipeline();
    expect(result.success).toBe(false);
    expect(result.testerResult).toMatchObject({ success: false, deterministic: true, failedTests: ['unit tests'] });
    expect(runReviewer).toHaveBeenCalledOnce();
  });

  it('does not let reviewer approval waive a blocking deterministic new failure', async () => {
    runReviewer.mockResolvedValue({ decision: 'approve', feedback: 'looks fine' });
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'pass',
      headStatus: 'fail',
      newFailure: true,
      rawOutputTail: 'new regression',
      durationMs: 5,
    }]);

    const { result } = await runPipeline();

    expect(result).toMatchObject({ success: false, finalStatus: 'failed', failureSignal: 'gate-fail' });
    expect(runReviewer).toHaveBeenCalledOnce();
  });

  it('blocks a deterministic new failure even when no reviewer stage is configured', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'pass',
      headStatus: 'fail',
      newFailure: true,
      rawOutputTail: 'new regression',
      durationMs: 5,
    }]);

    const { result } = await runPipeline({ stages: ['worker', 'tester'] });

    expect(result).toMatchObject({ success: false, finalStatus: 'failed', failureSignal: 'gate-fail' });
    expect(runReviewer).not.toHaveBeenCalled();
  });

  it('runs verification for a validation-relevant manifest change', async () => {
    runWorker.mockResolvedValue({
      success: true, summary: 'updated manifest', filesChanged: ['.openswarm/verify.yaml'],
      commands: ['npm test'], output: '', confidencePercent: 100,
    });
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [verifyCommand] } });
    runVerify.mockResolvedValue([{
      command: verifyCommand, baseStatus: 'skipped', headStatus: 'pass',
      newFailure: false, rawOutputTail: 'pass', durationMs: 1,
    }]);
    const { result } = await runPipeline({ skipTesterIfNoCodeChange: true });
    expect(result.testerResult?.deterministic).toBe(true);
    expect(runVerify).toHaveBeenCalledOnce();
  });

  it('limits manifest commands and executes deterministic verify only once', async () => {
    const commands = Array.from({ length: 5 }, (_, index) => ({ ...verifyCommand, name: `command-${index}` }));
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands } });
    runVerify.mockImplementation(async ({ commands: selected }) => selected.map((command: VerifyCommand) => ({
      command,
      baseStatus: 'skipped',
      headStatus: 'pass',
      newFailure: false,
      rawOutputTail: 'pass',
      durationMs: 1,
    })));
    await runPipeline({ verify: { enabled: true, blockOnNewFailures: true, maxCommands: 2 } });
    expect(runVerify).toHaveBeenCalledOnce();
    expect(runVerify.mock.calls[0][0].commands).toHaveLength(2);
    expect(runReviewer).toHaveBeenCalledWith(expect.objectContaining({
      verificationEvidence: expect.arrayContaining([expect.objectContaining({ command: expect.objectContaining({ name: 'command-0' }) })]),
    }));
  });

  it('does not mark new failures failed when blockOnNewFailures is disabled', async () => {
    discoverVerifyCommands.mockResolvedValue([verifyCommand]);
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'pass',
      headStatus: 'fail',
      newFailure: true,
      rawOutputTail: 'new regression',
      durationMs: 5,
    }]);
    const { result } = await runPipeline({ verify: { enabled: true, blockOnNewFailures: false, maxCommands: 4 } });
    expect(result.testerResult).toMatchObject({ success: true, testsFailed: 1, deterministic: true });
  });

  it('auto-enables the tester stage from createPipelineFromConfig when verify is enabled', async () => {
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [verifyCommand] } });
    runVerify.mockResolvedValue([{
      command: verifyCommand,
      baseStatus: 'skipped',
      headStatus: 'pass',
      newFailure: false,
      rawOutputTail: 'pass',
      durationMs: 1,
    }]);
    const { createPipelineFromConfig } = await import('./pairPipeline.js');
    const roles = {
      worker: { enabled: true, timeoutMs: 0 },
      reviewer: { enabled: true, timeoutMs: 0 },
      tester: { enabled: false, timeoutMs: 0 },
    };
    const pipeline = createPipelineFromConfig(
      roles,
      1,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      { enabled: true, blockOnNewFailures: true, maxCommands: 4 },
    );
    const result = await pipeline.run(task(), process.cwd());
    expect(result.success).toBe(true);
    expect(result.testerResult?.deterministic).toBe(true);
    expect(runVerify).toHaveBeenCalledOnce();
  });
});

describe('PairPipeline deterministic tester without a reviewer (AGT-4438)', () => {
  const verifyCommand = { name: 'pytest', run: 'pytest', kind: 'test' as const };

  /** One evidence row; `pass` flips the head status. */
  function evidence(pass: boolean, tail: string) {
    return [{
      command: verifyCommand,
      baseStatus: 'pass' as const,
      headStatus: pass ? ('pass' as const) : ('fail' as const),
      newFailure: !pass,
      rawOutputTail: tail,
      durationMs: 1,
    }];
  }

  const CONTRACT_FAILURE = [
    'FAILED tests/test_contracts.py::test_dataset_column_schema',
    "AssertionError: 'boolean' is not one of ['text', 'date', 'number']",
  ].join('\n');

  beforeEach(() => {
    loadVerifyManifest.mockResolvedValue({ manifest: { version: 1, commands: [verifyCommand] } });
  });

  it('drives another iteration instead of ending the run, and reaches success when the retry fixes it', async () => {
    runVerify
      .mockResolvedValueOnce(evidence(false, CONTRACT_FAILURE))
      .mockResolvedValueOnce(evidence(true, '1 passed'));

    const { result } = await runPipeline({ stages: ['worker', 'tester'], maxIterations: 2 });

    expect(result.success).toBe(true);
    // The whole point: the failure came back to the worker rather than ending
    // the attempt and waiting for the scheduler's backoff.
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(runVerify).toHaveBeenCalledTimes(2);
  });

  it('carries the failing command output into the retry as objective feedback', async () => {
    runVerify
      .mockResolvedValueOnce(evidence(false, CONTRACT_FAILURE))
      .mockResolvedValueOnce(evidence(true, '1 passed'));

    await runPipeline({ stages: ['worker', 'tester'], maxIterations: 2 });

    // The trail must carry what failed, not just which command failed:
    // `failedTests` from the deterministic runner holds command names only.
    const secondCall = runWorker.mock.calls[1]?.[0] as { previousFeedback?: string } | undefined;
    expect(secondCall?.previousFeedback ?? '').toContain('test_dataset_column_schema');
    expect(secondCall?.previousFeedback ?? '').toContain("'boolean' is not one of");
  });

  it('still defers to the reviewer when the reviewer stage is enabled', async () => {
    runVerify.mockResolvedValue(evidence(false, CONTRACT_FAILURE));

    const { result } = await runPipeline({ stages: ['worker', 'tester', 'reviewer'], maxIterations: 2 });

    // Unchanged behaviour: the deterministic verdict is the reviewer's to judge,
    // and the terminal check ends the run rather than retrying the worker.
    expect(result.success).toBe(false);
    expect(runWorker).toHaveBeenCalledTimes(1);
  });

  it('stops on an identical repeated failure through the self-repair guard, not by burning the budget', async () => {
    runVerify.mockResolvedValue(evidence(false, CONTRACT_FAILURE));

    const { result, logs } = await runPipeline({ stages: ['worker', 'tester'], maxIterations: 5 });

    expect(result.success).toBe(false);
    // Two passes, then the stagnation guard — not five.
    expect(runWorker).toHaveBeenCalledTimes(2);
    expect(logs.join(' ')).toContain('self-repair stagnated');
  });

  it('leaves the CodeQL gate ahead of the tester: a new finding is what the retry is told about', async () => {
    runVerify.mockResolvedValue(evidence(false, CONTRACT_FAILURE));
    // Baseline clean, head with a finding: only an INTRODUCED finding counts.
    runSecurityAudit
      .mockResolvedValueOnce({
        status: 'passed', codeqlLanguages: ['javascript'], skippedCodeqlLanguages: [], findings: [],
      })
      .mockResolvedValueOnce({
        status: 'findings',
        codeqlLanguages: ['javascript'],
        skippedCodeqlLanguages: [],
        findings: [{
          ruleId: 'codeql/js/file-access-to-http', level: 'error', message: 'outbound file data', filePath: 'src/example.ts', line: 12,
        }],
      });

    const { result } = await runPipeline({
      stages: ['worker', 'tester'],
      maxIterations: 3,
      securityAudit: { enabled: true, maxThreads: 2 },
    });

    expect(result.success).toBe(false);
    // The CodeQL gate sits before the tester block and drives its own bounded
    // retry, so the finding — not the test failure — is what iteration 2 is
    // told to fix. Reaching the tester's self-repair path must not change that.
    const secondCall = runWorker.mock.calls[1]?.[0] as { previousFeedback?: string } | undefined;
    expect(secondCall?.previousFeedback ?? '').toContain('file-access-to-http');
    expect(secondCall?.previousFeedback ?? '').not.toContain('test_dataset_column_schema');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RunLedger, type RunClaim } from '../automation/runLedger.js';
import type { PipelineConfig } from './pairPipelineTypes.js';

const mocks = vi.hoisted(() => ({ worker: vi.fn(), reviewer: vi.fn(), tester: vi.fn(), advisor: vi.fn() }));
vi.mock('./worker.js', async (actual) => ({ ...await actual(), runWorker: mocks.worker }));
vi.mock('./reviewer.js', async (actual) => ({ ...await actual(), runReviewer: mocks.reviewer }));
vi.mock('./tester.js', async (actual) => ({ ...await actual(), runTester: mocks.tester }));
vi.mock('./recoveryAdvisor.js', async (actual) => ({ ...await actual(), runRecoveryAdvisor: mocks.advisor }));
vi.mock('../knowledge/index.js', () => ({ hasRepoSnapshot: () => true, scanAndCache: vi.fn(), analyzeIssue: vi.fn() }));
vi.mock('../memory/repoKnowledge.js', () => ({ recallRepoKnowledge: vi.fn(async () => []) }));
vi.mock('../coordination/runCoordination.js', () => ({ publishCoordination: vi.fn() }));

let root: string, repo: string, ledger: RunLedger, claim: RunClaim;
const task = { id: 'recovery-task', source: 'linear' as const, title: 'Change documented behavior', description: 'Keep all required checks', priority: 1, createdAt: 1 };
const base: PipelineConfig = { stages: ['worker', 'tester', 'reviewer'], maxIterations: 1,
  roles: { worker: { enabled: true, model: 'worker-model' }, reviewer: { enabled: true, model: 'reviewer-model' }, tester: { enabled: true, model: 'tester-model' } },
  guards: { enabled: false }, loopAdvisor: { mode: 'off' } };
const advice = { diagnosis: 'Use the observed evidence', action: 'revise_strategy' as const, evidence: ['failure'], condition: 'Same artifact', verification: 'Rerun the required checks' };
const cost = { costUsd: 0.01, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1, model: 'independent-advisor', servedModels: ['independent-advisor'] };
const hooks = () => { const lease = claim; return ledger.recovery.forClaim(() => lease); };
async function run(config: Partial<PipelineConfig> = {}, durable = true) {
  const { PairPipeline } = await import('./pairPipeline.js');
  return new PairPipeline({ ...base, ...config }).run(task, repo, durable ? { recovery: hooks() } : undefined);
}
function retry() {
  expect(ledger.transition(claim, 'RETRY_AT', { retryAt: Date.now() - 1 })).toBe(true);
  ledger.close(); ledger = new RunLedger(join(root, 'automation.db'));
  claim = ledger.claimRun(task.id, { ownerInstanceId: 'replacement', leaseMs: 600_000 })!;
  expect(claim).toBeTruthy(); expect(ledger.transition(claim, 'EXECUTING')).toBe(true);
}
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  root = mkdtempSync(join(tmpdir(), 'pipeline-recovery-')); repo = join(root, 'repo'); mkdirSync(repo);
  writeFileSync(join(repo, 'README.md'), 'before\n');
  writeFileSync(join(repo, 'value.ts'), 'export const value = 0;\n');
  for (const args of [['init', '-q'], ['config', 'user.name', 'Recovery Test'], ['config', 'user.email', 'test@example.invalid'], ['add', '.'], ['commit', '-qm', 'seed']]) execFileSync('git', args, { cwd: repo });
  ledger = new RunLedger(join(root, 'automation.db'));
  ledger.registerRun({ issueId: task.id, source: 'linear', projectPath: repo });
  claim = ledger.claimRun(task.id, { ownerInstanceId: 'initial', leaseMs: 600_000 })!;
  ledger.transition(claim, 'EXECUTING');
  mocks.worker.mockImplementation(async () => {
    writeFileSync(join(repo, 'README.md'), 'after\n'); writeFileSync(join(repo, 'value.ts'), 'export const value = 1;\n');
    return { success: true, summary: 'Updated behavior', filesChanged: ['README.md', 'value.ts'], commands: ['node --test'], executedCommands: ['node --test'], output: '', confidencePercent: 100, costInfo: { ...cost, model: 'worker-model', servedModels: ['worker-model'] } };
  });
  mocks.tester.mockResolvedValue({ success: true, summary: 'Verified', testsRun: 1, testsPassed: 1, testsFailed: 0, output: '' });
  mocks.reviewer.mockResolvedValue({ decision: 'approve', feedback: 'All requirements met' });
  mocks.advisor.mockResolvedValue({ decision: advice, costInfo: cost });
});
afterEach(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); vi.restoreAllMocks(); vi.clearAllMocks(); });

describe('pipeline restart boundaries', () => {
  it('reuses only the worker and reruns verification after a known reviewer infra failure and database restart', async () => {
    mocks.reviewer.mockRejectedValueOnce(new Error('Reviewer execution failed: codex CLI failed with code 1'));
    expect((await run()).finalStatus).toBe('infra_error');
    retry();
    const recovered = await run();
    expect(recovered.success).toBe(true);
    expect(mocks.worker).toHaveBeenCalledTimes(1); expect(mocks.reviewer).toHaveBeenCalledTimes(2);
    expect(mocks.tester).toHaveBeenCalledTimes(2);
    expect(recovered.stages.filter(s => s.reused).map(s => s.stage)).toEqual(['worker']);
    expect(recovered.totalCost?.costUsd ?? 0).toBe(0);
  });

  it.each(['artifact', 'policy', 'intent', 'verify-input'])('invalidates reuse when %s changes', async (change) => {
    mocks.reviewer.mockRejectedValueOnce(new Error('HTTP 503 service unavailable'));
    expect((await run()).finalStatus).toBe('infra_error'); retry();
    const config: Partial<PipelineConfig> = {};
    if (change === 'artifact') writeFileSync(join(repo, 'new.txt'), 'operator change');
    if (change === 'policy') config.projectGoal = 'A new acceptance boundary';
    if (change === 'intent') config.draftAnalysis = { completionCriteria: ['new criterion'] } as PipelineConfig['draftAnalysis'];
    if (change === 'verify-input') writeFileSync(join(repo, 'package.json'), '{"scripts":{"test":"exit 1"}}');
    await run(config); expect(mocks.worker).toHaveBeenCalledTimes(2);
  });

  it('does not cache quality failures or a completed run that is reopened', async () => {
    mocks.reviewer.mockResolvedValueOnce({ decision: 'reject', feedback: 'The specified behavior is absent', issues: ['Required behavior absent'] });
    expect((await run()).success).toBe(false); retry();
    expect((await run()).success).toBe(true); retry(); await run();
    expect(mocks.worker).toHaveBeenCalledTimes(3);
  });

  it('invalidates a worker checkpoint when process environment changes', async () => {
    const original = process.env.OPENSWARM_RECOVERY_ENV_FIXTURE;
    try {
      process.env.OPENSWARM_RECOVERY_ENV_FIXTURE = 'before';
      mocks.reviewer.mockRejectedValueOnce(new Error('HTTP 503 service unavailable'));
      expect((await run()).finalStatus).toBe('infra_error'); retry();
      process.env.OPENSWARM_RECOVERY_ENV_FIXTURE = 'after';
      expect((await run()).success).toBe(true);
      expect(mocks.worker).toHaveBeenCalledTimes(2); expect(mocks.tester).toHaveBeenCalledTimes(2);
    } finally {
      if (original === undefined) delete process.env.OPENSWARM_RECOVERY_ENV_FIXTURE;
      else process.env.OPENSWARM_RECOVERY_ENV_FIXTURE = original;
    }
  });
});

describe('recovery policy and bounded intervention', () => {
  async function twoFailures(mode: 'off' | 'shadow' | 'active') {
    mocks.worker.mockResolvedValue({ success: false, summary: 'No artifact change', error: 'Required behavior absent', filesChanged: [], commands: [], output: '', confidencePercent: 100 });
    return run({ stages: ['worker'], maxIterations: 2, loopAdvisor: { mode } });
  }
  it.each(['off', 'shadow', 'active'] as const)('keeps mode %s explicit and counts advisor usage', async (mode) => {
    const result = await twoFailures(mode);
    expect(mocks.advisor).toHaveBeenCalledTimes(mode === 'off' ? 0 : 1);
    if (mode !== 'off') {
      expect(result.recovery?.advice?.applied).toBe(mode === 'active');
      expect(result.totalCost?.costUsd).toBe(0.01);
    }
    expect(result.success).toBe(false);
  });

  it('persists diagnosis across restart without spending again on the same evidence', async () => {
    await twoFailures('active'); retry(); await twoFailures('active');
    expect(mocks.advisor).toHaveBeenCalledTimes(1);
    expect(mocks.worker.mock.calls.at(-1)?.[0].previousFeedback).toContain('Automated recovery advice');
  });

  it('ignores late advice after the claim is replaced', async () => {
    mocks.advisor.mockImplementationOnce(async () => {
      ledger.transition(claim, 'RETRY_AT', { retryAt: Date.now() - 1 });
      claim = ledger.claimRun(task.id, { ownerInstanceId: 'replacement', leaseMs: 600_000 })!;
      ledger.transition(claim, 'EXECUTING');
      return { decision: { ...advice, action: 'stop' }, costInfo: cost };
    });
    const result = await twoFailures('active');
    expect(result.operatorPark?.code).not.toBe('recovery_advisor_park');
    expect(ledger.recovery.status(task.id).advice?.applied).toBe(false);
  });

  it('never consults for operator waits or unknown execution outcomes', async () => {
    for (const flag of ['blockedOnOperator', 'executionOutcomeUnknown']) {
      mocks.worker.mockResolvedValue({ success: false, summary: 'Stopped', filesChanged: [], commands: [], output: '', terminationCause: 'no_progress', [flag]: true });
      expect((await run({ stages: ['worker'], loopAdvisor: { mode: 'active' } })).finalStatus).toBe('waiting_on_operator');
    }
    expect(mocks.advisor).not.toHaveBeenCalled();
  });

  it('rejects an unconfigured model switch', async () => {
    mocks.advisor.mockResolvedValueOnce({ decision: { ...advice, action: 'switch_model', model: 'unapproved' } });
    const result = await twoFailures('active');
    expect(result.recovery?.advice?.applied).toBe(false);
    expect(mocks.worker.mock.calls.some(c => c[0].model === 'unapproved')).toBe(false);
  });

  it('runs independent source-based premise verification without replacing the original review', async () => {
    mocks.reviewer.mockResolvedValue({ decision: 'revise', feedback: 'Behavior is absent', issues: [] });
    mocks.advisor.mockResolvedValueOnce({ decision: { ...advice, action: 'verify_claim' }, costInfo: cost })
      .mockResolvedValueOnce({ decision: { ...advice, action: 'verify_claim', premiseDisposition: 'refuted', evidence: ['source:README.md:0'] }, costInfo: { ...cost, model: 'premise-model', servedModels: ['premise-model'] } });
    const result = await run({ maxIterations: 2, loopAdvisor: { mode: 'active' }, roles: { ...base.roles, reviewer: { ...base.roles?.reviewer, escalateModel: 'premise-model' } } });
    expect(mocks.advisor).toHaveBeenCalledTimes(2);
    expect(mocks.advisor.mock.calls[1][0]).toMatchObject({ purpose: 'premise_verification', model: 'premise-model', failedModels: ['reviewer-model', 'independent-advisor'], evidence: { 'source:README.md:0': 'after\n' } });
    expect(result.success).toBe(false); expect(result.reviewResult?.decision).toBe('revise');
    expect(result.totalCost?.costUsd).toBe(0.04);
    expect(result.recovery?.advice?.premiseVerification?.disposition).toBe('refuted');
  });

  it('does not reuse the first advisor model for independent premise verification', async () => {
    mocks.reviewer.mockResolvedValue({ decision: 'revise', feedback: 'Check this premise', issues: [] });
    mocks.advisor.mockResolvedValueOnce({ decision: { ...advice, action: 'verify_claim' }, costInfo: cost });
    const result = await run({ maxIterations: 2, loopAdvisor: { mode: 'active' }, roles: { ...base.roles, reviewer: { ...base.roles?.reviewer, escalateModel: 'provider/independent-advisor' } } });
    expect(mocks.advisor).toHaveBeenCalledTimes(1);
    expect(result.reviewResult?.decision).toBe('revise');
    expect(result.recovery?.advice?.applied).toBe(false);
  });
});

describe('paired fault replay (fixture economics, not live-model quality)', () => {
  it.each(['reviewer', 'tester'] as const)('compares baseline versus durable recovery after %s infrastructure failure', async (stage) => {
    const counts: Array<Record<string, unknown>> = [];
    const { takeSnapshot } = await import('../support/gitTracker.js');
    for (const durable of [false, true]) {
      mocks.worker.mockClear(); mocks.tester.mockClear(); mocks.reviewer.mockClear();
      writeFileSync(join(repo, 'README.md'), 'before\n'); writeFileSync(join(repo, 'value.ts'), 'export const value = 0;\n');
      mocks[stage].mockRejectedValueOnce(new Error('HTTP 503 service unavailable'));
      const started = performance.now();
      expect((await run({}, durable)).finalStatus).toBe('infra_error');
      if (durable) retry();
      const result = await run({}, durable);
      expect(result.success).toBe(true);
      counts.push({ mode: durable ? 'durable' : 'baseline', stage, workerCalls: mocks.worker.mock.calls.length,
        testerCalls: mocks.tester.mock.calls.length, reviewerCalls: mocks.reviewer.mock.calls.length,
        finalArtifact: await takeSnapshot(repo), success: result.success, wallMs: Math.round(performance.now() - started),
        heapBytes: process.memoryUsage().heapUsed });
    }
    expect(counts[0].workerCalls).toBe(2); expect(counts[1].workerCalls).toBe(1);
    expect(counts[0].finalArtifact).toBe(counts[1].finalArtifact);
    expect(counts[1].reviewerCalls).toBe(stage === 'reviewer' ? 2 : 1);
    if (process.env.OPENSWARM_RECOVERY_BENCHMARK_OUT) {
      const { appendFileSync } = await import('node:fs');
      appendFileSync(process.env.OPENSWARM_RECOVERY_BENCHMARK_OUT, JSON.stringify({ fixture: stage, counts }) + '\n');
    }
  });
});

it('carries a configured tester escalation through restart into the actual tester invocation', async () => {
  const config: Partial<PipelineConfig> = { maxIterations: 2, loopAdvisor: { mode: 'active' }, roles: { ...base.roles,
    tester: { enabled: true, model: 'tester-model', escalateModel: 'tester-tier' } } };
  mocks.tester.mockResolvedValueOnce({ success: false, testsPassed: 0, testsFailed: 1, output: 'assertion mismatch', error: 'assertion mismatch' })
    .mockResolvedValueOnce({ success: false, testsPassed: 0, testsFailed: 1, output: 'assertion mismatch', error: 'assertion mismatch' });
  mocks.advisor.mockResolvedValueOnce({ decision: { ...advice, action: 'switch_model', model: 'tester-tier' } });
  expect((await run(config)).success).toBe(false);
  retry(); expect((await run(config)).success).toBe(true);
  expect(mocks.tester.mock.calls.at(-1)?.[0].model).toBe('tester-tier');
});

it.each(['worker', 'reviewer', 'tester'] as const)('retains successful %s progress when native final tool turns repeated', async (stage) => {
  const original = mocks[stage].getMockImplementation();
  mocks[stage].mockImplementationOnce(async (...args) => ({ ...await original!(...args), terminationCause: 'no_progress' }));
  mocks.advisor.mockResolvedValue({ decision: { ...advice, action: 'stop' }, costInfo: cost });
  const result = await run({ loopAdvisor: { mode: 'active' } });
  expect(result.success).toBe(true); expect(result.operatorPark).toBeUndefined();
  expect(mocks.advisor).not.toHaveBeenCalled();
  const observed = result.stages.find((s) => s.stage === stage)?.result as { terminationCause?: string };
  expect(observed.terminationCause).toBe('no_progress');
});

it('persists unknown in both verdict fields when the source packet was truncated', async () => {
  const originalWorker = mocks.worker.getMockImplementation()!;
  mocks.worker.mockImplementation(async (...args) => {
    const result = await originalWorker(...args); writeFileSync(join(repo, 'README.md'), 'after\n' + 'bounded source\n'.repeat(200)); return result;
  });
  mocks.reviewer.mockResolvedValue({ decision: 'revise', feedback: 'Behavior absent', issues: [] });
  mocks.advisor.mockResolvedValueOnce({ decision: { ...advice, action: 'verify_claim' }, costInfo: cost })
    .mockResolvedValueOnce({ decision: { ...advice, action: 'verify_claim', premiseDisposition: 'refuted', evidence: ['source:README.md:0'] }, costInfo: { ...cost, servedModels: ['premise-model'] } });
  const result = await run({ maxIterations: 2, loopAdvisor: { mode: 'active' }, roles: { ...base.roles, reviewer: { ...base.roles?.reviewer, escalateModel: 'premise-model' } } });
  expect(result.recovery?.advice?.premiseVerification?.disposition).toBe('unknown');
  expect(result.recovery?.advice?.decision?.premiseDisposition).toBe('unknown');
  expect(result.reviewResult?.decision).toBe('revise');
});

// Created: 2026-11-22
// Purpose: Unit tests for the model-selection bench scoring (AGT-4186): the
//          infrastructure-failure classifier, pass-rate aggregation, the abort
//          with no ranking, and the ESCALATION FINDING against --primary.
// Dependencies: benchmarks/modelSelectScoring.ts (pure; no network, no model calls)
// Test Status: passing
import { describe, expect, it, vi } from 'vitest';
import {
  aggregate, classifyInfraFailure, escalationVerdict, isWorkerCatchPath, levelTable, report, runSweep, summarizeRun,
  type ModelAgg, type RunResult,
} from '../benchmarks/modelSelectScoring.js';

function run(over: Partial<RunResult> = {}): RunResult {
  return {
    model: 'm/a', taskId: 'L0-fix-multiply', rep: 1, passed: true, reason: 'ok',
    toolCalls: 2, apiCalls: 2, promptTokens: 80, completionTokens: 20, costUsd: 0.01, durationMs: 1000,
    ...over,
  };
}

function agg(model: string, passRate: number, costPerPass: number, runs = 4): ModelAgg {
  return {
    model, runs, passes: Math.round(passRate * runs), passRate, avgCostUsd: costPerPass * passRate,
    costPerPass, avgToolCalls: 3, avgDurationMs: 1000, infraErrors: 0,
  };
}

describe('classifyInfraFailure', () => {
  it('treats a 401 or 402 as an infrastructure failure, not a model score', () => {
    // runWorker returns a 401 in result.error and never writes it to onLog.
    expect(classifyInfraFailure({ error: 'OpenRouter API error (401): {"error":{"message":"User not found."}}', logs: [] }))
      .toMatch(/401/);
    expect(classifyInfraFailure({ error: 'User not found', logs: [] })).toMatch(/auth/);
    // The typed out-of-credits RateLimitError message, thrown and logged as FATAL.
    expect(classifyInfraFailure({ logs: ['FATAL: HTTP 402 out of credits'] })).toMatch(/402.*pool is dry/);
    expect(classifyInfraFailure({ error: 'OpenRouter API error (402): insufficient balance' })).toMatch(/402/);
    expect(classifyInfraFailure({ error: 'Insufficient credits' })).toMatch(/402/);

    // ...and such a run is left out of the pass rate.
    const [a] = aggregate([
      run({ passed: false, infraError: classifyInfraFailure({ error: 'OpenRouter API error (401): User not found' })! }),
      run({ passed: true }),
    ]);
    expect(a.runs).toBe(1);
    expect(a.passRate).toBe(1);
    expect(a.infraErrors).toBe(1);
  });

  it('classifies quota errors and the worker infra-fallback line', () => {
    expect(classifyInfraFailure({ error: 'insufficient_quota: You exceeded your current quota' })).toMatch(/quota/);
    expect(classifyInfraFailure({ error: 'HTTP 429 rate limit reached' })).toMatch(/quota/);
    expect(classifyInfraFailure({ logs: ['[Worker] quota on openrouter, fallback to claude'] })).toMatch(/fallback/);
    expect(classifyInfraFailure({ logs: ['[Worker] infra on openrouter, fallback to codex'] })).toMatch(/fallback/);
    expect(classifyInfraFailure({ summary: 'OpenRouter API error (402): insufficient balance' })).toMatch(/402/);
  });

  it('still scores a real model failure, even when the model text mentions 401 or quota', () => {
    expect(classifyInfraFailure({})).toBeNull();
    expect(classifyInfraFailure({
      summary: 'Added a quota check that returns 401 for unknown users',
      logs: ['🔧 edit src/auth.ts', 'expected status 402 in test output', 'tests failed: 3'],
    })).toBeNull();
    expect(classifyInfraFailure({ error: 'Worker execution failed: max turns reached' })).toBeNull();
    // A policy fallback line is not one of the quota/infra fallbacks.
    expect(classifyInfraFailure({ logs: ['[Worker] policy on codex, fallback to openrouter'] })).toBeNull();

    const [a] = aggregate([run({ passed: false }), run({ passed: true })]);
    expect(a.passRate).toBe(0.5);
    expect(a.infraErrors).toBe(0);
  });
});

describe('classifyInfraFailure trust boundary', () => {
  it('still scores a model-authored WorkerResult.error that mentions 401, 402, quota or user not found', () => {
    // Outside runWorker's catch path, WorkerResult.error comes from the model's
    // completion block or names model-chosen paths, so the broad rules must not apply.
    for (const workerError of [
      'expected 402 entries, got 400',
      'cache lookup returned user not found for id 7',
      'retry quota exceeded in tokenizer',
      'worker-scope: changed files outside declared fileScope: src/quota.ts',
      'status 401 returned by the handler under test',
    ]) {
      expect(classifyInfraFailure({ workerError, summary: 'Implemented the cache', logs: [] }), workerError).toBeNull();
      expect(classifyInfraFailure({ workerError, logs: [] }), workerError).toBeNull();
    }
  });

  it('trusts WorkerResult.error on the runWorker catch path', () => {
    expect(classifyInfraFailure({
      workerError: '[openrouter] OpenRouter API error (401): User not found',
      summary: 'Worker execution failed',
    })).toMatch(/401.*auth/);
    expect(classifyInfraFailure({
      workerError: '[openrouter] insufficient credits',
      summary: '[openrouter] Worker execution failed',
    })).toMatch(/402/);
    expect(isWorkerCatchPath('Worker execution failed')).toBe(true);
    expect(isWorkerCatchPath('[codex] Worker execution failed')).toBe(true);
    expect(isWorkerCatchPath('Worker execution failed: max turns')).toBe(false);
    expect(isWorkerCatchPath(undefined)).toBe(false);
  });

  it('still flags the wrapped adapter API error form in a model-path WorkerResult.error', () => {
    expect(classifyInfraFailure({ workerError: 'OpenRouter API error (402): insufficient balance', summary: 'x' }))
      .toMatch(/402/);
  });

  it('treats the OpenRouter model escalation line as an infrastructure failure', () => {
    expect(classifyInfraFailure({
      logs: ['[OpenRouter] deepseek/deepseek-v4-flash failed; escalating to z-ai/glm-5.3-flash: boom'],
    })).toMatch(/escalation.*another model/);
    // Anchored: model text quoting the line mid-sentence is not the adapter's log line.
    expect(classifyInfraFailure({
      logs: ['note: [OpenRouter] a/b failed; escalating to c/d'],
    })).toBeNull();
  });
});

describe('aggregate and levelTable', () => {
  it('excludes infrastructure failures from pass rates even when the run passed', () => {
    // A fallback run can pass under another adapter; it still must not count.
    const [a] = aggregate([
      run({ passed: true, infraError: 'worker infra fallback' }),
      run({ passed: false }),
    ]);
    expect(a.runs).toBe(1);
    expect(a.passes).toBe(0);
    expect(a.passRate).toBe(0);
  });

  it('gives a model with only infrastructure failures a zero score instead of NaN', () => {
    const [a] = aggregate([run({ infraError: '402' })]);
    expect(a.runs).toBe(0);
    expect(a.passRate).toBe(0);
    expect(Number.isNaN(a.avgCostUsd)).toBe(false);
  });

  it('leaves infrastructure failures out of the level table', () => {
    const table = levelTable([
      run({ model: 'm/a', taskId: 'L0-x', passed: true }),
      run({ model: 'm/a', taskId: 'L0-y', passed: false, infraError: '401' }),
    ]);
    const row = table.split('\n').find((l) => l.startsWith('m/a'))!;
    expect(row).toContain('100%');
  });
});

describe('summarizeRun and runSweep', () => {
  it('aborts with a clear message and no ranking when an infrastructure failure occurs', () => {
    const s = summarizeRun([
      run({ model: 'm/a', passed: true }),
      run({ model: 'm/b', passed: false, infraError: '402 insufficient balance: the provider pool is dry (billing), not a model failure' }),
    ], 'm/a', 'm/a');
    expect(s.ok).toBe(false);
    expect(s.text).toMatch(/ABORTED: infrastructure failure on m\/b/);
    expect(s.text).toMatch(/pool is dry/);
    expect(s.text).not.toMatch(/MODEL RANKING|PARETO FINDING|ESCALATION FINDING/);
  });

  it('produces the ranking when every run is a model result', () => {
    const s = summarizeRun([run({ model: 'm/a' }), run({ model: 'm/b', passed: false })], 'm/a');
    expect(s.ok).toBe(true);
    expect(s.text).toMatch(/MODEL RANKING/);
  });

  it('stops starting new runs after the first infrastructure failure', async () => {
    const runner = vi.fn(async (task: { id: string }, model: string, rep: number) =>
      run({ model, taskId: task.id, rep, ...(model === 'm/a' ? { infraError: '401' } : {}) }));
    const tasks = [{ id: 'L0-a' }, { id: 'L1-b' }, { id: 'L2-c' }];
    const results = await runSweep(['m/a', 'm/b'], tasks, 2, runner);
    // Without the abort this would be 2 models x 3 tasks x 2 repeats = 12.
    expect(runner).toHaveBeenCalledTimes(2);
    expect(results.filter((r) => r.infraError)).toHaveLength(1);
  });

  it('runs the full sweep when nothing fails for infrastructure', async () => {
    const runner = vi.fn(async (task: { id: string }, model: string, rep: number) => run({ model, taskId: task.id, rep }));
    const results = await runSweep(['m/a', 'm/b'], [{ id: 'L0-a' }], 3, runner);
    expect(results).toHaveLength(6);
  });
});

describe('escalationVerdict', () => {
  it('prints an ESCALATION FINDING against --primary and marks a weaker candidate as not a second opinion', () => {
    // The qwen3-235b case: it never beat the primary.
    const text = escalationVerdict([agg('deepseek/v4-flash', 0.75, 0.01), agg('qwen/qwen3-235b', 0.25, 0.02)], 'deepseek/v4-flash');
    expect(text).toMatch(/ESCALATION FINDING/);
    expect(text).toMatch(/primary: deepseek\/v4-flash — pass 75%/);
    expect(text).toMatch(/qwen\/qwen3-235b .*weaker than primary - not a second opinion/);
    expect(text).toMatch(/No candidate matched/);
  });

  it('ranks eligible candidates by pass rate, then $/pass, and counts a tie with the primary as eligible', () => {
    const text = escalationVerdict([
      agg('p/primary', 0.5, 0.01),
      agg('c/tie-cheap', 0.5, 0.005),
      agg('c/best-expensive', 1, 0.05),
      agg('c/best-cheap', 1, 0.02),
    ], 'p/primary');
    const order = ['c/best-cheap', 'c/best-expensive', 'c/tie-cheap'].map((m) => text.indexOf(`. ${m}`));
    expect(order.every((i) => i > 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(text).not.toMatch(/\. p\/primary/);
    expect(text).toMatch(/best second opinion: c\/best-cheap/);
  });

  it('warns that the task set does not discriminate when the primary passes 100%', () => {
    const text = escalationVerdict([agg('p/primary', 1, 0.01), agg('c/other', 1, 0.005)], 'p/primary');
    expect(text).toMatch(/task set does not discriminate - need a harder tier/);
    expect(text).toMatch(/Recommend no escalate change/);
  });

  it('says so when the primary has no scored runs, without throwing', () => {
    expect(escalationVerdict([agg('c/other', 1, 0.01)], 'p/missing')).toMatch(/primary p\/missing has no scored runs/);
  });

  it('report includes ESCALATION FINDING only when a primary is given', () => {
    const results = [run({ model: 'm/a' }), run({ model: 'm/b', passed: false })];
    const aggs = aggregate(results);
    expect(report(aggs, 'm/a', results)).not.toMatch(/ESCALATION FINDING/);
    const withPrimary = report(aggs, 'm/a', results, 'm/b');
    expect(withPrimary).toMatch(/ESCALATION FINDING/);
    expect(withPrimary).toMatch(/m\/b .*\(primary\)/);
  });
});

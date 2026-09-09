// ============================================
// OpenSwarm - workerFanoutGate.ts unit tests
// ============================================
//
// workerFanoutGate.ts previously had no dedicated companion test file — it was
// only exercised indirectly through pairPipeline.test.ts's end-to-end fan-out
// scenario (one signal combination, one emit path). This file adds direct
// coverage of evaluateWorkerFanoutGate's individual signals, the candidate
// builder's configured/dedup branches, emitWorkerFanoutGateDecision's quiet
// early-return, and runWorkerWithOptionalFanout's no-winner fallback logging —
// all confirmed uncovered by `vitest run src/agents/pairPipeline.test.ts
// --coverage` scoped to this file.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { WorkerOptions } from './worker.js';
import type { WorkerFanoutRunResult } from './workerFanout.js';

const runWorkerFanout = vi.fn();
vi.mock('./workerFanout.js', async () => {
  const actual = await vi.importActual<typeof import('./workerFanout.js')>('./workerFanout.js');
  return { ...actual, runWorkerFanout };
});

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'task-1',
    source: 'linear',
    title: 'a task',
    description: 'a description',
    priority: 3,
    createdAt: Date.now(),
    ...overrides,
  };
}

beforeEach(() => {
  runWorkerFanout.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('evaluateWorkerFanoutGate — individual signals', () => {
  it('adds insufficient-draft when the draft analysis was insufficient', async () => {
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const decision = evaluateWorkerFanoutGate({
      task: task(),
      draftAnalysis: { relevantFiles: [], sufficient: false },
      iteration: 1,
    });
    expect(decision.signals.map((s) => s.code)).toContain('insufficient-draft');
  });

  it('adds broad-file-scope when 4 or more relevant files are in scope', async () => {
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const decision = evaluateWorkerFanoutGate({
      task: task(),
      draftAnalysis: { relevantFiles: ['a.ts', 'b.ts', 'c.ts', 'd.ts'] },
      iteration: 1,
    });
    const signal = decision.signals.find((s) => s.code === 'broad-file-scope');
    expect(signal).toBeDefined();
    expect(signal?.reason).toBe('broad file scope (4 files)');
  });

  it('does not add broad-file-scope for fewer than 4 files', async () => {
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const decision = evaluateWorkerFanoutGate({
      task: task(),
      draftAnalysis: { relevantFiles: ['a.ts', 'b.ts'] },
      iteration: 1,
    });
    expect(decision.signals.map((s) => s.code)).not.toContain('broad-file-scope');
  });

  it('adds high-effort-profile when the resolved job profile effort is high', async () => {
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const decision = evaluateWorkerFanoutGate({
      task: task(),
      iteration: 1,
      effort: 'high',
    });
    expect(decision.signals.map((s) => s.code)).toContain('high-effort-profile');
  });

  it('does not add high-effort-profile for medium/low/absent effort', async () => {
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const decision = evaluateWorkerFanoutGate({
      task: task(),
      iteration: 1,
      effort: 'medium',
    });
    expect(decision.signals.map((s) => s.code)).not.toContain('high-effort-profile');
  });

  it('is disabled outright when config.enabled is false, ignoring every other signal', async () => {
    const { evaluateWorkerFanoutGate } = await import('./workerFanoutGate.js');
    const decision = evaluateWorkerFanoutGate({
      task: task({ priority: 1, estimatedMinutes: 999 }),
      draftAnalysis: { relevantFiles: ['a', 'b', 'c', 'd'], sufficient: false },
      iteration: 5,
      feedbackSource: 'objective',
      effort: 'high',
      config: { enabled: false },
    });
    expect(decision).toEqual({ enabled: false, shouldFanOut: false, score: 0, threshold: 2, signals: [] });
  });
});

describe('emitWorkerFanoutGateDecision — quiet single-worker verdict', () => {
  it('emits the gate event but suppresses the log line when not fanning out and not verbose', async () => {
    const { emitWorkerFanoutGateDecision } = await import('./workerFanoutGate.js');
    const emit = vi.fn();
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    emitWorkerFanoutGateDecision({
      context: { task: task(), currentIteration: 1, taskPrefix: 'T-1' },
      decision: { enabled: true, shouldFanOut: false, score: 0, threshold: 2, signals: [] },
      verbose: false,
      emit,
    });

    // The structured event always fires (dashboard/telemetry needs it)...
    expect(emit).toHaveBeenCalledWith('fanout:gate', expect.anything());
    // ...but the noisy "single worker" log line does not, since shouldFanOut is
    // false and verbose was not requested.
    expect(emit).not.toHaveBeenCalledWith('log', expect.anything());
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it('logs the single-worker verdict when verbose is true even though it did not fan out', async () => {
    const { emitWorkerFanoutGateDecision } = await import('./workerFanoutGate.js');
    const emit = vi.fn();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    emitWorkerFanoutGateDecision({
      context: { task: task(), currentIteration: 1, taskPrefix: 'T-1' },
      decision: { enabled: true, shouldFanOut: false, score: 0, threshold: 2, signals: [] },
      verbose: true,
      emit,
    });

    expect(emit).toHaveBeenCalledWith('log', expect.objectContaining({ line: expect.stringContaining('single worker') }));
  });
});

describe('runWorkerWithOptionalFanout — candidate building and no-winner fallback', () => {
  const baseWorkerOptions: WorkerOptions = {
    taskTitle: 'T', taskDescription: 'D', projectPath: '/tmp/proj',
    adapterName: 'codex-responses', model: 'gpt-5.4-mini',
  };

  it('uses explicitly configured candidates verbatim instead of the default primary+spark pair', async () => {
    runWorkerFanout.mockResolvedValueOnce({
      winner: {
        id: 'custom-a', projectPath: '/tmp/sandbox', filesChanged: ['x.ts'], durationMs: 1, score: 1, eligible: true,
        result: { success: true, summary: 'ok', filesChanged: ['x.ts'], commands: [], output: '' },
      },
      candidates: [],
    } satisfies WorkerFanoutRunResult);

    const { runWorkerWithOptionalFanout } = await import('./workerFanoutGate.js');
    const runWorker = vi.fn();
    await runWorkerWithOptionalFanout({
      projectPath: '/tmp/proj',
      workerOptions: baseWorkerOptions,
      fanoutDecision: { enabled: true, shouldFanOut: true, score: 5, threshold: 2, signals: [] },
      fanoutConfig: {
        mode: 'execute',
        candidates: [
          { id: 'custom-a', adapter: 'codex-responses', model: 'gpt-5.4-mini' },
          { id: 'custom-b', adapter: 'openrouter', model: 'some-model' },
        ],
      },
      onLog: vi.fn(),
      runWorker,
    });

    expect(runWorkerFanout).toHaveBeenCalledTimes(1);
    const passedCandidates = runWorkerFanout.mock.calls[0][0].candidates;
    expect(passedCandidates.map((c: { id: string }) => c.id)).toEqual(['custom-a', 'custom-b']);
    expect(runWorkerFanout.mock.calls[0][0].concurrency).toBe(2);
    // The single-worker fallback must not run when fan-out already found a winner.
    expect(runWorker).not.toHaveBeenCalled();
  });

  it('deduplicates the default spark candidate when the primary worker already has that exact identity', async () => {
    runWorkerFanout.mockResolvedValueOnce({ candidates: [], fallbackReason: 'no eligible fan-out candidate produced a guarded diff' });

    const { runWorkerWithOptionalFanout } = await import('./workerFanoutGate.js');
    const runWorker = vi.fn().mockResolvedValue({ success: true, summary: 'single', filesChanged: [], commands: [], output: '' });

    await runWorkerWithOptionalFanout({
      projectPath: '/tmp/proj',
      // Matches the hardcoded spark-diversity candidate's own identity exactly.
      workerOptions: { ...baseWorkerOptions, adapterName: 'codex-responses', model: 'gpt-5.3-codex-spark' },
      fanoutDecision: { enabled: true, shouldFanOut: true, score: 5, threshold: 2, signals: [] },
      fanoutConfig: { mode: 'execute' },
      onLog: vi.fn(),
      runWorker,
    });

    expect(runWorkerFanout).toHaveBeenCalledTimes(1);
    const passedCandidates = runWorkerFanout.mock.calls[0][0].candidates;
    // Only 1 candidate survives: primary and the hardcoded spark collide on
    // "adapter:model" identity, so the second (spark) is filtered out.
    expect(passedCandidates).toHaveLength(1);
  });

  it('logs the fallback reason via onLog when fan-out executes but produces no winner', async () => {
    runWorkerFanout.mockResolvedValueOnce({
      candidates: [],
      fallbackReason: 'winner promotion failed: simulated',
    } satisfies WorkerFanoutRunResult);

    const { runWorkerWithOptionalFanout } = await import('./workerFanoutGate.js');
    const onLog = vi.fn();
    const runWorker = vi.fn().mockResolvedValue({ success: true, summary: 'single-worker result', filesChanged: [], commands: [], output: '' });

    const result = await runWorkerWithOptionalFanout({
      projectPath: '/tmp/proj',
      workerOptions: baseWorkerOptions,
      fanoutDecision: { enabled: true, shouldFanOut: true, score: 5, threshold: 2, signals: [] },
      fanoutConfig: { mode: 'execute' },
      onLog,
      runWorker,
    });

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('fallback to single worker: winner promotion failed: simulated'));
    // Falls through to the plain single-worker call when there is no winner.
    expect(runWorker).toHaveBeenCalledWith(baseWorkerOptions);
    expect(result.summary).toBe('single-worker result');
  });
});

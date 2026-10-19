import { describe, expect, it, vi } from 'vitest';
import type { CliAdapter } from '../adapters/types.js';
import { parseRecoveryAdvice, runRecoveryAdvisor, type RecoveryAdvisorInput } from './recoveryAdvisor.js';

const input: RecoveryAdvisorInput = { cwd: '/isolated/repo', adapter: 'codex-responses', model: 'advisor-model', failedModel: 'worker-model',
  stage: 'worker', cause: 'quality', evidence: { failure: 'A required test fails', artifact: 'tree-a' }, allowedModels: ['approved-escalation'], remainingMs: 90_000 };
const decision = { diagnosis: 'Fix the observed failure', action: 'revise_strategy', evidence: ['failure'], condition: 'Same input', verification: 'Run the required check' };
const adapter = { name: 'codex-responses', run: vi.fn(), capabilities: { enforcesReadOnly: true, enforcesHumanSurfaceReadOnly: true } } as unknown as CliAdapter;
const raw = (stdout = JSON.stringify(decision)) => ({ stdout, stderr: '', exitCode: 0, durationMs: 1,
  costInfo: { costUsd: 0, inputTokens: 12, outputTokens: 4, cacheReadTokens: 0, cacheCreationTokens: 0, durationMs: 1, model: 'advisor-model', servedModels: ['advisor-model'] } });

describe('bounded recovery advice', () => {
  it('executes a distinct native model with no tools or coordination authority', async () => {
    const spawn = vi.fn(async () => raw());
    expect((await runRecoveryAdvisor(input, { resolve: () => adapter, spawn })).decision).toEqual(decision);
    expect(spawn.mock.calls[0][1]).toMatchObject({ readOnly: true, maxTurns: 1, timeoutMs: 45_000,
      shellTools: false, filesystemTools: false, webTools: false, memoryTools: false, toolDeny: ['*'] });
    expect(spawn.mock.calls[0][1]).not.toHaveProperty('coordinationContext');
  });

  it('spends no model call on same model, unsupported enforcement, no budget or cancellation', async () => {
    const spawn = vi.fn(async () => raw());
    for (const changed of [{ failedModel: 'advisor-model' }, { remainingMs: 0 }, { signal: AbortSignal.abort() }]) {
      expect((await runRecoveryAdvisor({ ...input, ...changed }, { resolve: () => adapter, spawn })).decision).toBeUndefined();
    }
    expect((await runRecoveryAdvisor(input, { resolve: () => ({ ...adapter, run: undefined }), spawn })).decision).toBeUndefined();
    expect(spawn).not.toHaveBeenCalled();
  });

  it('honors the remaining task budget and preserves a failed consultation', async () => {
    const spawn = vi.fn(async () => raw('not JSON'));
    const result = await runRecoveryAdvisor({ ...input, remainingMs: 125 }, { resolve: () => adapter, spawn });
    expect(result.decision).toBeUndefined(); expect(result.reason).toBeTruthy();
    expect(result.costInfo).toEqual(raw().costInfo);
    expect(spawn.mock.calls[0][1].timeoutMs).toBe(125);
  });

  it('rejects invented evidence, approval actions and invalid shape', () => {
    for (const d of [{ ...decision, evidence: ['invented'] }, { ...decision, action: 'approve' }, { ...decision, verification: '' }, { ...decision, evidence: [] }]) {
      expect(() => parseRecoveryAdvice(JSON.stringify(d), input.evidence)).toThrow();
    }
    expect(() => parseRecoveryAdvice('approved', input.evidence)).toThrow();
  });

  it('does not apply a silently routed same-model response', async () => {
    const spawn = vi.fn(async () => ({ ...raw(), costInfo: { ...raw().costInfo, servedModels: ['worker-model'] } }));
    expect((await runRecoveryAdvisor(input, { resolve: () => adapter, spawn })).decision).toBeUndefined();
  });
  it('requires provider-reported identity and rejects collision with any failed-stage model', async () => {
    for (const servedModels of [undefined, ['provider/worker-model'], ['advisor-model', 'worker-model']]) {
      const spawn = vi.fn(async () => ({ ...raw(), costInfo: { ...raw().costInfo, servedModels } }));
      expect((await runRecoveryAdvisor(input, { resolve: () => adapter, spawn })).decision).toBeUndefined();
    }
    expect((await runRecoveryAdvisor({ ...input, failedModels: ['advisor-model'] }, { resolve: () => adapter, spawn: vi.fn(async () => raw()) })).decision).toBeUndefined();
    const firstAdvisor = vi.fn(async () => ({ ...raw(), costInfo: { ...raw().costInfo, servedModels: ['first-advisor'] } }));
    expect((await runRecoveryAdvisor({ ...input, purpose: 'premise_verification', failedModels: ['first-advisor'] }, { resolve: () => adapter, spawn: firstAdvisor })).decision).toBeUndefined();
    expect(firstAdvisor).toHaveBeenCalledTimes(1);
  });

  it('enforces its own deadline even when an adapter ignores cancellation', async () => {
    vi.useFakeTimers();
    try {
      const spawn = vi.fn(() => new Promise<never>(() => {}));
      const pending = runRecoveryAdvisor({ ...input, remainingMs: 17 }, { resolve: () => adapter, spawn });
      await vi.advanceTimersByTimeAsync(17);
      expect(await pending).toMatchObject({ reason: 'Recovery advisor deadline exceeded' });
      expect(spawn.mock.calls[0][1].signal.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

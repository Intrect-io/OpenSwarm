import { afterEach, describe, expect, it, vi } from 'vitest';
import * as adapters from '../adapters/index.js';
import { runReviewer } from './reviewer.js';
import { runTester } from './tester.js';

const workerResult = { success: true, summary: 'Changed behavior', filesChanged: ['value.ts'], commands: [], output: '' };
const costInfo = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheCreationTokens: 0, costUsd: 0, durationMs: 1, servedModels: ['actual-model'] };
afterEach(() => vi.restoreAllMocks());
describe('native stage metadata remains execution evidence', () => {
  it.each(['executionOutcomeUnknown', 'blockedOnOperator'] as const)('fails closed on trusted %s even when the text claims success', async (flag) => {
    vi.spyOn(adapters, 'spawnCli').mockResolvedValue({ stdout: flag === 'executionOutcomeUnknown'
      ? 'OUTCOME_UNKNOWN_DO_NOT_RETRY: sandbox command outcome requires operator inspection before this worktree can continue.'
      : '{"success":true,"testsPassed":10,"testsFailed":0}',
    stderr: '', exitCode: 0, durationMs: 1, [flag]: true, operatorQuestionCorrelationIds: ['exact-question'], costInfo });
    const parseReview = vi.fn(() => { throw new Error('A terminal native boundary must not depend on model parsing'); });
    vi.spyOn(adapters, 'getAdapter').mockReturnValue({ name: 'test', parseReviewerOutput: parseReview } as never);
    const options = { taskTitle: 'Task', taskDescription: 'Keep checks', workerResult, projectPath: '/tmp' };
    const tester = await runTester(options); const review = await runReviewer(options);
    expect(tester.success).toBe(false); expect(review.decision).toBe('revise');
    expect(tester[flag]).toBe(true); expect(review[flag]).toBe(true);
    expect(tester.operatorQuestionCorrelationIds).toEqual(['exact-question']);
    expect(review.operatorQuestionCorrelationIds).toEqual(['exact-question']);
    expect(tester.costInfo).toEqual(costInfo); expect(review.costInfo).toEqual(costInfo);
    expect(parseReview).not.toHaveBeenCalled();
  });

  it.each([false, true])('carries native termination/usage without inventing CLI tool activity; native=%s', async (native) => {
    vi.spyOn(adapters, 'spawnCli').mockResolvedValue({ stdout: '{"success":false,"testsFailed":1}', stderr: '', exitCode: 0, durationMs: 1,
      ...(native ? { terminationCause: 'no_progress' as const, executedCommands: ['node --test'], costInfo } : {}) });
    vi.spyOn(adapters, 'getAdapter').mockReturnValue({ name: 'test', parseReviewerOutput: () => ({ decision: 'revise', feedback: 'Required check failed' }) } as never);
    const options = { taskTitle: 'Task', taskDescription: 'Keep checks', workerResult, projectPath: '/tmp' };
    const review = await runReviewer(options); const tester = await runTester(options);
    expect(review.terminationCause).toBe(native ? 'no_progress' : undefined);
    expect(tester.terminationCause).toBe(native ? 'no_progress' : undefined);
    expect(tester.executedCommands).toEqual(native ? ['node --test'] : undefined);
    expect(review.costInfo?.servedModels).toEqual(native ? ['actual-model'] : undefined);
    expect(tester.costInfo?.servedModels).toEqual(native ? ['actual-model'] : undefined);
  });
});

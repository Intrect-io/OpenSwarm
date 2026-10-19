import { describe, expect, it } from 'vitest';
import { executionContract, observedChecks, recoveryCause } from './loopRecoveryEvidence.js';
import type { PipelineContext, StageResult } from './pairPipelineTypes.js';

const context = { task: { id: 'task', title: 'Implement behavior', description: 'Keep the checks' }, projectPath: '/repo',
  config: { stages: ['worker', 'reviewer'], maxIterations: 2 } } as PipelineContext;

describe('recovery evidence identities', () => {
  it('invalidates policy for effective grants, routing, profiles and iteration budget', () => {
    const original = executionContract(context).policyHash;
    for (const extra of [{ roleMcpTools: { worker: [{ function: { name: 'read_data', parameters: {} } }] } },
      { adapterRouting: { primary: 'claude' } }, { jobProfiles: [{ name: 'heavy', minMinutes: 10 }] }, { maxIterations: 3 }]) {
      expect(executionContract({ ...context, config: { ...context.config, ...extra } } as PipelineContext).policyHash).not.toBe(original);
    }
  });
  it('uses observed evidence and ignores self-report and verifier timestamps', () => {
    const stage = (result: unknown) => ({ stage: 'tester', result } as StageResult);
    expect(observedChecks(stage({ commands: ['npm test'] }))).toEqual([]);
    const a = observedChecks(stage({ executedCommands: ['node --test'], verificationEvidence: [{ command: 'npm test', status: 'passed', exitCode: 0, durationMs: 10 }] }));
    expect(a).toEqual(observedChecks(stage({ executedCommands: ['node --test'], verificationEvidence: [{ command: 'npm test', status: 'passed', exitCode: 0, durationMs: 500 }] })));
    expect(a).not.toEqual(observedChecks(stage({ executedCommands: ['node --test'], verificationEvidence: [{ command: 'npm test', status: 'failed', exitCode: 1 }] })));
  });
  it('does not infer transport failure from prose numbers and retains unknown/wait precedence', () => {
    expect(recoveryCause('Expected 503 rows; line 429 differs')).toBe('quality');
    expect(recoveryCause('Needs revision', { decision: 'revise', issues: [] } as never)).toBe('quality');
    expect(recoveryCause('CLI failed with code 1', undefined, new Error('codex CLI failed with code 1'))).toBe('infra');
    expect(recoveryCause('stalled', { terminationCause: 'no_progress', executionOutcomeUnknown: true } as never)).toBe('outcome_unknown');
    expect(recoveryCause('stalled', { terminationCause: 'no_progress', blockedOnOperator: true } as never)).toBe('operator_wait');
  });
});

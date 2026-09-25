import { describe, expect, it } from 'vitest';
import type { WorkerResult } from './agentPair.js';
import { blockerVerificationDescription, workerBlockerClaim } from './workerBlockerReview.js';

const stop = (over: Partial<WorkerResult> = {}): WorkerResult => ({
  success: false, summary: 's', filesChanged: [], commands: [], output: '', haltReason: 'DoD unsatisfiable', ...over,
});

describe('workerBlockerClaim', () => {
  it('is the stated reason of a no-edit stop', () => {
    expect(workerBlockerClaim(stop())).toBe('DoD unsatisfiable');
    expect(workerBlockerClaim(stop({ haltReason: undefined, noChangesReason: 'already fixed on main' }))).toBe('already fixed on main');
  });

  it.each([
    ['a success', { success: true }],
    ['an adapter error', { error: 'HTTP 502' }],
    ['a stop with edits', { filesChanged: ['src/a.ts'] }],
    ['an operator question', { blockedOnOperator: true }],
    ['an unknown sandbox outcome', { executionOutcomeUnknown: true }],
    ['a stop with no reason', { haltReason: '  ' }],
  ])('is not claimed by %s', (_label, over) => {
    expect(workerBlockerClaim(stop(over as Partial<WorkerResult>))).toBeUndefined();
  });
});

describe('blockerVerificationDescription', () => {
  it('asks for independent verification with evidence and keeps the task', () => {
    const text = blockerVerificationDescription('Make range tests pass', 'tests contradict\nat :7 and :11', 'no edit');
    expect(text.startsWith('Make range tests pass')).toBe(true);
    expect(text).toContain('Blocker verification');
    expect(text).toContain('> tests contradict\n> at :7 and :11');
    expect(text).toContain('APPROVE only if you confirm it with concrete evidence');
    expect(text).toContain('REVISE');
  });
});

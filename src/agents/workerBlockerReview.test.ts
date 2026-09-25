import { describe, expect, it } from 'vitest';
import type { WorkerResult } from './agentPair.js';
import { workerBlockerClaim } from './workerBlockerReview.js';

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
    ['a rate-limit stop', { haltReason: 'Rate limit reached for gpt; quota resets at 12:00' }],
    ['a turn-limit stop', { haltReason: 'hit max turns before finishing' }],
  ])('is not claimed by %s', (_label, over) => {
    expect(workerBlockerClaim(stop(over as Partial<WorkerResult>))).toBeUndefined();
  });
});

describe('blocker-mode reviewer prompt', () => {
  it('asks to verify the claim, with its own approve rule and no completion-criteria gate', async () => {
    const { buildReviewerPrompt } = await import('./reviewer.js');
    const prompt = buildReviewerPrompt({
      taskTitle: 'Make range tests pass', taskDescription: 'Make every test pass', projectPath: '/repo',
      mode: 'blocker', blockerClaim: 'test/range.test.mjs:7 and :11 contradict each other',
      completionCriteria: ['all tests pass'],
      workerResult: { success: false, summary: 'no edit', filesChanged: [], commands: [], output: '', executedCommands: ['node --test test/range.test.mjs [exit 1]'] },
    });
    expect(prompt).toContain('Blocker Verification Mode');
    expect(prompt).toContain('test/range.test.mjs:7 and :11 contradict each other');
    expect(prompt).toContain('node --test test/range.test.mjs [exit 1]');
    expect(prompt).toContain('It is NOT a blocker that the worker was stuck');
    // The change-mode rules would make a no-diff confirmation impossible.
    expect(prompt).not.toContain('EVERY Definition of Done');
    expect(prompt).not.toContain('all tests pass');
  });
});

import { describe, expect, it } from 'vitest';
import { readmitWithRollback, shouldReadmitEarly } from './operatorAnswers.js';

describe('shouldReadmitEarly', () => {
  it('cuts the backoff short for a task parked on the operator', () => {
    expect(shouldReadmitEarly({ parkedOnOperator: true, allQuestionsAnswered: true })).toBe(true);
  });

  it('leaves an ordinary failure backoff alone, answered question or not', () => {
    // A task retrying after failures can still carry an answered question from an
    // earlier park. Without the park flag every heartbeat would re-admit it, and
    // the backoff that exists to stop a hot retry loop would stop existing.
    expect(shouldReadmitEarly({ parkedOnOperator: false, allQuestionsAnswered: true })).toBe(false);
  });

  it('leaves a parked task alone until the answer is actually there', () => {
    expect(shouldReadmitEarly({ parkedOnOperator: true, allQuestionsAnswered: false })).toBe(false);
  });
});

describe('readmitWithRollback', () => {
  function recorder(outcomes: { retire: boolean; promote: boolean }) {
    const calls: string[] = [];
    return {
      calls,
      steps: {
        retireSignal: () => { calls.push('retire'); return outcomes.retire; },
        promote: () => { calls.push('promote'); return outcomes.promote; },
        restoreSignal: () => { calls.push('restore'); },
      },
    };
  }

  it('retires the signal before promoting, so a later failure cannot replay it', () => {
    // Promoting while the signal is still set lets a run that then fails for its
    // own reasons be pulled forward again every heartbeat, past the backoff that
    // exists to stop exactly that.
    const { calls, steps } = recorder({ retire: true, promote: true });
    expect(readmitWithRollback(steps)).toBe(true);
    expect(calls).toEqual(['retire', 'promote']);
  });

  it('puts the signal back when the promotion does not happen', () => {
    // Otherwise the only record that an early re-admission was permitted is gone,
    // and the operator's answer can never shorten anything again.
    const { calls, steps } = recorder({ retire: true, promote: false });
    expect(readmitWithRollback(steps)).toBe(false);
    expect(calls).toEqual(['retire', 'promote', 'restore']);
  });

  it('does nothing at all when the signal cannot be retired', () => {
    // Failing to write leaves the task on its backoff, which is only a delay.
    const { calls, steps } = recorder({ retire: false, promote: true });
    expect(readmitWithRollback(steps)).toBe(false);
    expect(calls).toEqual(['retire']);
  });
});

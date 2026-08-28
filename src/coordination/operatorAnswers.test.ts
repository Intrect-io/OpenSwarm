import { describe, expect, it } from 'vitest';
import { shouldReadmitEarly } from './operatorAnswers.js';

describe('shouldReadmitEarly', () => {
  it('cuts the backoff short for a task parked on the operator', () => {
    expect(shouldReadmitEarly({ parkedOnOperator: true, allQuestionsAnswered: true })).toBe(true);
  });

  it('leaves an ordinary failure backoff alone, answered question or not', () => {
    // A task retrying after failures can still carry an answered question from an
    // earlier park. Without the park code every heartbeat would re-admit it, and
    // the backoff that exists to stop a hot retry loop would stop existing.
    expect(shouldReadmitEarly({ parkedOnOperator: false, allQuestionsAnswered: true })).toBe(false);
  });

  it('leaves a parked task alone until the answer is actually there', () => {
    expect(shouldReadmitEarly({ parkedOnOperator: true, allQuestionsAnswered: false })).toBe(false);
  });
});

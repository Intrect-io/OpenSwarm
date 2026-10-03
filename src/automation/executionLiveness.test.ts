import { describe, expect, it } from 'vitest';
import { isExecutionLive } from './executionLiveness.js';

describe('isExecutionLive (AGT-4667)', () => {
  it.each(['CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING'])('is live while the ledger row is %s', (ledgerState) => {
    expect(isExecutionLive({ schedulerHolds: false, ledgerState })).toBe(true);
  });

  // Every state in which the ledger says nobody holds the run: the local
  // in_progress marker is a leftover, not a live executor.
  it.each(['READY', 'RETRY_AT', 'NEEDS_HUMAN', 'NEEDS_RECONCILE', 'DONE', 'CANCELLED', 'DECOMPOSED', 'WAITING_EXTERNAL'])(
    'is not live when the ledger row is %s and the scheduler does not hold it',
    (ledgerState) => {
      expect(isExecutionLive({ schedulerHolds: false, ledgerState })).toBe(false);
    },
  );

  it('is live whenever the scheduler holds the task, whatever the ledger says', () => {
    expect(isExecutionLive({ schedulerHolds: true, ledgerState: 'READY' })).toBe(true);
    expect(isExecutionLive({ schedulerHolds: true })).toBe(true);
  });

  it('keeps trusting the marker when there is no ledger row to contradict it', () => {
    expect(isExecutionLive({ schedulerHolds: false })).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import { OPERATOR_QUESTION_PARK_REASON } from '../coordination/operatorAnswers.js';
import { SANDBOX_OUTCOME_UNKNOWN_PARK_REASON } from '../sandboxExecutor/protocol.js';
import { decideExplicitReadmission, OPERATOR_QUESTION_PARK_MARKER } from './explicitDispatchReadmission.js';
import type { RunRecord } from './runLedgerTypes.js';

function run(over: Partial<RunRecord>): RunRecord {
  return {
    issueId: 'r', source: 'linear', projectPath: '/repo', state: 'READY', stateVersion: 1,
    attemptNo: 1, leaseEpoch: 1, createdAt: 0, updatedAt: 0, ...over,
  } as RunRecord;
}

describe('decideExplicitReadmission', () => {
  it('leaves a claimable or unknown row alone', () => {
    expect(decideExplicitReadmission(undefined)).toEqual({ action: 'none' });
    expect(decideExplicitReadmission(null)).toEqual({ action: 'none' });
    expect(decideExplicitReadmission(run({ state: 'READY' }))).toEqual({ action: 'none' });
    expect(decideExplicitReadmission(run({ state: 'EXECUTING' }))).toEqual({ action: 'none' });
  });

  // vela 2026-09-02: six runs parked "until explicit operator redispatch" were
  // redispatched and every one came back "superseded".
  it('resumes a sandbox-outcome quarantine, which is exactly the park redispatch exists for', () => {
    expect(decideExplicitReadmission(run({
      state: 'NEEDS_HUMAN', lastErrorCode: SANDBOX_OUTCOME_UNKNOWN_PARK_REASON,
    }))).toEqual({ action: 'resume-needs-human' });
  });

  it('resumes a generic operator park', () => {
    expect(decideExplicitReadmission(run({ state: 'NEEDS_HUMAN', lastErrorCode: 'needs_human' })))
      .toEqual({ action: 'resume-needs-human' });
  });

  it('refuses a park that only its own answers may end', () => {
    expect(decideExplicitReadmission(run({ state: 'NEEDS_HUMAN', lastErrorCode: OPERATOR_QUESTION_PARK_REASON })).action)
      .toBe('refuse');
    expect(decideExplicitReadmission(run({
      state: 'NEEDS_HUMAN', lastErrorMessage: `${OPERATOR_QUESTION_PARK_MARKER} which file?`,
    })).action).toBe('refuse');
  });

  it('overrides a backoff whose time has not come, and ignores one that has', () => {
    expect(decideExplicitReadmission(run({ state: 'RETRY_AT', retryAt: 2_000 }), 1_000)).toEqual({ action: 'mark-ready' });
    expect(decideExplicitReadmission(run({ state: 'RETRY_AT', retryAt: 500 }), 1_000)).toEqual({ action: 'none' });
  });

  it('reopens a terminal record the way the heartbeat does for a Todo card', () => {
    for (const state of ['DONE', 'DECOMPOSED', 'CANCELLED'] as const) {
      expect(decideExplicitReadmission(run({ state }))).toEqual({ action: 'mark-ready' });
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { RunRecord } from './runLedgerTypes.js';
import {
  isExplicitAdmissionRetry,
  planExplicitDeferredRecovery,
} from './explicitDispatchRecovery.js';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    issueId: 'issue-1', source: 'linear', identifier: 'AGT-1', title: 'recover me',
    projectPath: '/repo', state: 'RETRY_AT', stateVersion: 4, attemptNo: 1,
    leaseEpoch: 1, retryAt: 5_000, lastErrorCode: 'claim_deferred',
    discoveredAt: 1_000, updatedAt: 2_000, metadata: { explicitDispatch: true },
    ...overrides,
  };
}

function task(state: string, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'issue-1', issueId: 'issue-1', issueIdentifier: 'AGT-1', source: 'linear',
    title: 'current title', priority: 2, createdAt: 1_000, linearState: state,
    ...overrides,
  };
}

describe('explicit deferred restart recovery', () => {
  it.each(['Todo', 'Backlog', 'In Progress'])(
    'restores an explicit claim_deferred task in tracker state %s',
    (state) => {
      const planned = planExplicitDeferredRecovery([run()], [task(state)]);

      expect(planned).toHaveLength(1);
      expect(planned[0]).toMatchObject({ projectPath: '/repo', retryAt: 5_000 });
      expect(planned[0].task).toMatchObject({
        id: 'issue-1', issueId: 'issue-1', title: 'current title',
        explicitDispatch: true,
      });
    },
  );

  it.each(['waiting_on_operator', 'rate_limited', 'failed', 'shutdown_cancelled', 'superseded'])(
    'does not turn %s backoff into scheduler ownership',
    (lastErrorCode) => {
      expect(planExplicitDeferredRecovery(
        [run({ lastErrorCode })],
        [task('In Progress')],
      )).toEqual([]);
    },
  );

  it('requires explicit durable provenance and an unowned finite retry deadline', () => {
    expect(isExplicitAdmissionRetry(run({ metadata: {} }))).toBe(false);
    expect(isExplicitAdmissionRetry(run({ metadata: { explicitDispatch: false } }))).toBe(false);
    expect(isExplicitAdmissionRetry(run({ retryAt: undefined }))).toBe(false);
    expect(isExplicitAdmissionRetry(run({ retryAt: Number.POSITIVE_INFINITY }))).toBe(false);
    expect(isExplicitAdmissionRetry(run({ ownerInstanceId: 'other' }))).toBe(false);
  });

  it('fails closed when the tracker no longer reports an executable card', () => {
    expect(planExplicitDeferredRecovery([run()], [])).toEqual([]);
    expect(planExplicitDeferredRecovery([run()], [task('In Review')])).toEqual([]);
    expect(planExplicitDeferredRecovery([run()], [task('Done')])).toEqual([]);
  });

  it('uses the runner dispatch scope and the durable repository path', () => {
    expect(planExplicitDeferredRecovery(
      [run({ projectPath: '/disabled' })],
      [task('Todo', { projectPath: '/stale' })],
      (projectPath) => projectPath === '/repo',
    )).toEqual([]);

    const [planned] = planExplicitDeferredRecovery(
      [run()],
      [task('Todo', { projectPath: '/stale' })],
      (projectPath) => projectPath === '/repo',
    );
    expect(planned.projectPath).toBe('/repo');
    expect(planned.task.projectPath).toBe('/repo');
  });
});

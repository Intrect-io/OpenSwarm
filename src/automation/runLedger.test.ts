import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RunLedger, type RunClaim } from './runLedger.js';
import Database from 'better-sqlite3';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

function createDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-run-ledger-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function register(ledger: RunLedger, issueId: string, projectPath = '/repo', fileScope?: string[]): void {
  ledger.registerRun({
    issueId,
    source: 'linear',
    identifier: issueId,
    title: `Task ${issueId}`,
    projectPath,
    metadata: fileScope ? { fileScope } : undefined,
  }, 1_000);
}

function claim(ledger: RunLedger, issueId: string, owner: string, now = 2_000, maxActiveForProject = 1): RunClaim {
  const result = ledger.claimRun(issueId, {
    ownerInstanceId: owner,
    leaseMs: 1_000,
    maxActiveForProject,
    now,
  });
  expect(result).not.toBeNull();
  return result!;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('RunLedger state machine', () => {
  it('does not rewind a run when discovery sees the same issue again', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'INT-1');
    const first = claim(ledger, 'INT-1', 'daemon-a');
    expect(ledger.transition(first, 'EXECUTING', {}, 2_100)).toBe(true);

    ledger.registerRun({
      issueId: 'INT-1', source: 'linear', identifier: 'INT-1',
      title: 'Updated title', projectPath: '/repo',
    }, 2_200);

    expect(ledger.getRun('INT-1')).toMatchObject({
      state: 'EXECUTING',
      title: 'Updated title',
      attemptNo: 1,
      leaseEpoch: 1,
    });
    ledger.close();
  });

  it('rejects an illegal state transition', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'INT-2');
    const runClaim = claim(ledger, 'INT-2', 'daemon-a');

    expect(ledger.transition(runClaim, 'DONE', {}, 2_100)).toBe(false);
    expect(ledger.getRun('INT-2')?.state).toBe('CLAIMED');
    ledger.close();
  });

  it('protects worktrees until a run reaches a terminal state', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'INT-3');
    const runClaim = claim(ledger, 'INT-3', 'daemon-a');
    expect(ledger.attachWorktree(runClaim, '/repo/worktree/INT-3', 'swarm/INT-3', 2_100)).toBe(true);
    expect(ledger.getProtectedWorktreePaths('/repo')).toEqual(new Set(['/repo/worktree/INT-3']));

    expect(ledger.transition(runClaim, 'CANCELLED', {}, 2_200)).toBe(true);
    expect(ledger.getProtectedWorktreePaths('/repo')).toEqual(new Set());
    ledger.close();
  });

  it.each(['DONE', 'DECOMPOSED', 'CANCELLED'] as const)('allows an explicit operator reopen from %s', (terminal) => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, `REOPEN-${terminal}`);
    const runClaim = claim(ledger, `REOPEN-${terminal}`, 'daemon');
    if (terminal === 'DONE') {
      expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_050)).toBe(true);
      expect(ledger.transition(runClaim, 'SYNC_PENDING', {}, 2_100)).toBe(true);
      expect(ledger.finalizeSyncedRun(`REOPEN-${terminal}`, 2_200)).toBe(true);
    } else if (terminal === 'DECOMPOSED') {
      expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_050)).toBe(true);
      expect(ledger.transition(runClaim, terminal, {}, 2_100)).toBe(true);
    } else {
      expect(ledger.transition(runClaim, terminal, {}, 2_100)).toBe(true);
    }
    expect(ledger.markReady(`REOPEN-${terminal}`, 2_300)).toBe(true);
    expect(ledger.getRun(`REOPEN-${terminal}`)?.state).toBe('READY');
    ledger.close();
  });
});

describe('RunLedger claim-owner history', () => {
  it('lists every executor that ever claimed the run, newest first, without duplicates', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OWNERS-1');
    const first = claim(ledger, 'OWNERS-1', '7-first-generation', 2_000);
    expect(ledger.transition(first, 'RETRY_AT', { retryAt: 2_500 }, 2_100)).toBe(true);
    const second = claim(ledger, 'OWNERS-1', '7-second-generation', 3_000);
    expect(ledger.transition(second, 'RETRY_AT', { retryAt: 3_500 }, 3_100)).toBe(true);
    claim(ledger, 'OWNERS-1', '7-second-generation', 4_000);

    expect(ledger.listClaimOwners('OWNERS-1')).toEqual(['7-second-generation', '7-first-generation']);
    expect(ledger.listClaimOwners('never-registered')).toEqual([]);
    ledger.close();
  });
});

describe('RunLedger tracker observation cache (AGT-4127)', () => {
  it('preserves the row and recovery fields while closing a stale run from tracker truth', () => {
    const ledger = new RunLedger(createDbPath());
    ledger.importRun({
      issueId: 'TRACKER-DONE', source: 'linear', identifier: 'AX-856',
      title: 'done upstream', projectPath: '/repo', state: 'RETRY_AT',
      retryAt: 10_000, branchName: 'swarm/AX-856', errorCode: 'failed',
      errorMessage: 'original failure evidence',
    }, 1_000);
    const stale = ledger.getRun('TRACKER-DONE')!;

    expect(ledger.cacheTrackerObservation(
      stale,
      { state: 'Done', stateType: 'completed' },
      'DONE',
      3_000,
    )).toBe(true);
    expect(ledger.listRuns()).toHaveLength(1);
    expect(ledger.getRun('TRACKER-DONE')).toMatchObject({
      state: 'DONE',
      branchName: 'swarm/AX-856',
      lastErrorCode: 'failed',
      lastErrorMessage: 'original failure evidence',
      trackerState: 'Done',
      trackerStateType: 'completed',
      trackerCheckedAt: 3_000,
      completedAt: 3_000,
    });
    ledger.close();
  });

  it('caches an open state without refreshing run age, and loses to a concurrent claim', () => {
    const ledger = new RunLedger(createDbPath());
    ledger.importRun({
      issueId: 'TRACKER-OPEN', source: 'linear', projectPath: '/repo',
      state: 'RETRY_AT', retryAt: 1_000,
    }, 1_000);
    const stale = ledger.getRun('TRACKER-OPEN')!;
    expect(ledger.cacheTrackerObservation(stale, { state: 'Todo', stateType: 'unstarted' }, undefined, 2_000)).toBe(true);
    expect(ledger.getRun('TRACKER-OPEN')).toMatchObject({
      state: 'RETRY_AT', updatedAt: 1_000, trackerState: 'Todo', trackerCheckedAt: 2_000,
    });

    const observed = ledger.getRun('TRACKER-OPEN')!;
    expect(claim(ledger, 'TRACKER-OPEN', 'worker', 3_000)).not.toBeNull();
    expect(ledger.cacheTrackerObservation(
      observed,
      { state: 'Done', stateType: 'completed' },
      'DONE',
      3_100,
    )).toBe(false);
    expect(ledger.getRun('TRACKER-OPEN')?.state).toBe('CLAIMED');
    ledger.close();
  });
});

describe('RunLedger operator re-admission (AGT-4033)', () => {
  it('parks the first unanswered attempt and resumes after restart only for its exact correlation set', async () => {
    const dbPath = createDbPath();
    const previousDb = process.env.OPENSWARM_AUTOMATION_DB;
    process.env.OPENSWARM_AUTOMATION_DB = dbPath;
    const trace = await import('../coordination/coordinationTrace.js');
    trace.resetTraceDbForTests();
    const { CoordinationStore } = await import('../coordination/coordinationStore.js');
    const store = new CoordinationStore(resolve(dbPath, '../coordination.json'));
    let ledger: RunLedger | undefined = new RunLedger(dbPath);
    try {
      register(ledger, 'AX-1075');
      const parkedAttempt = claim(ledger, 'AX-1075', 'daemon');
      expect(ledger.transition(parkedAttempt, 'RETRY_AT', {
        retryAt: 99_000,
        errorCode: 'waiting_on_operator',
      }, 2_100)).toBe(true);
      for (const correlationId of ['hq-attempt-5', 'hq-attempt-9']) {
        await store.publish({
          repository: '/repo', taskId: 'AX-1075', actor: 'worker', recipient: 'human',
          kind: 'human-question', status: 'waiting', correlationId, summary: `question ${correlationId}`,
        });
      }

      expect(ledger.markNeedsHumanForQuestions(
        'AX-1075', ['hq-attempt-5', 'hq-attempt-9', 'hq-attempt-5'], 'waiting for operator', 2_200,
      )).toBe(true);
      expect(ledger.getRun('AX-1075')).toMatchObject({
        state: 'NEEDS_HUMAN', attemptNo: 1, lastErrorCode: 'operator_question', retryAt: undefined,
      });
      // The generic Linear/operator path may not bypass exact answer fencing.
      expect(ledger.resumeNeedsHuman('AX-1075', 2_300)).toBeNull();

      await store.publish({
        repository: '/repo', taskId: 'AX-1075', actor: 'operator', recipient: 'worker',
        kind: 'human-answer', status: 'completed', correlationId: 'hq-attempt-5',
        summary: 'answered first', detail: 'Use monthly_cutoff; do not create due_date.',
      });
      // An unrelated answered question cannot stand in for attempt-9.
      await store.publish({
        repository: '/repo', taskId: 'AX-1075', actor: 'worker', recipient: 'human',
        kind: 'human-question', status: 'waiting', correlationId: 'hq-unrelated', summary: 'unrelated',
      });
      await store.publish({
        repository: '/repo', taskId: 'AX-1075', actor: 'operator', recipient: 'worker',
        kind: 'human-answer', status: 'completed', correlationId: 'hq-unrelated', summary: 'answered unrelated',
      });

      ledger.close();
      ledger = new RunLedger(dbPath); // daemon restart
      expect(ledger.resumeNeedsHumanForQuestions('AX-1075', 3_000)).toBeNull();
      expect(ledger.getRun('AX-1075')?.state).toBe('NEEDS_HUMAN');

      await store.publish({
        repository: '/repo', taskId: 'AX-1075', actor: 'operator', recipient: 'worker',
        kind: 'human-answer', status: 'completed', correlationId: 'hq-attempt-9',
        summary: 'answered retry', detail: 'Use monthly_cutoff; do not create due_date.',
      });
      expect(ledger.resumeNeedsHumanForQuestions('AX-1075', 3_100)).toBe('READY');
      expect(ledger.getRun('AX-1075')).toMatchObject({ state: 'READY', attemptNo: 1 });
    } finally {
      ledger?.close();
      if (previousDb === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
      else process.env.OPENSWARM_AUTOMATION_DB = previousDb;
      trace.resetTraceDbForTests();
    }
  });

  it('will not claim a run whose retry time has not come', () => {
    // This is why letting an answered task past the heartbeat filter is not
    // enough on its own: it would be selected every cycle and then fail to claim.
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'AGT-1');
    ledger.deferUnclaimedRun('AGT-1', 5_000, 'parked on the operator', 1_000);

    expect(ledger.claimRun('AGT-1', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, maxActiveForProject: 1, now: 2_000,
    })).toBeNull();

    ledger.close();
  });

  it('claims it once the answer brings it forward', () => {
    // `markReady` is the transition the runner uses when the board shows the
    // operator replied — the backoff was only ever a poll for that reply.
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'AGT-2');
    ledger.deferUnclaimedRun('AGT-2', 5_000, 'parked on the operator', 1_000);

    expect(ledger.markReady('AGT-2', 2_000)).toBe(true);
    expect(ledger.getRun('AGT-2')?.state).toBe('READY');
    expect(ledger.claimRun('AGT-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, maxActiveForProject: 1, now: 2_000,
    })).not.toBeNull();

    ledger.close();
  });

  it('does not let a park outlive the attempt that caused it', () => {
    // The runner reads `lastErrorCode` to decide whether an operator's answer may
    // cut a backoff short, so the park has to expire with its own attempt. If a
    // transition preserved the previous code the way this UPDATE preserves a
    // branch or a PR url, a task that waited out its backoff and then failed for
    // its own reasons would be pulled forward on every heartbeat by an answer
    // from a park it has long since left.
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'AGT-3');

    const parked = claim(ledger, 'AGT-3', 'daemon');
    expect(ledger.transition(parked, 'RETRY_AT', {
      retryAt: 9_000,
      errorCode: 'waiting_on_operator',
    }, 2_100)).toBe(true);
    expect(ledger.getRun('AGT-3')?.lastErrorCode).toBe('waiting_on_operator');

    // The next attempt ends without naming a reason at all — the weakest case,
    // and the one a `COALESCE` would silently turn back into a park.
    expect(ledger.markReady('AGT-3', 2_200)).toBe(true);
    const retried = claim(ledger, 'AGT-3', 'daemon', 2_300);
    expect(ledger.transition(retried, 'RETRY_AT', { retryAt: 9_000 }, 2_400)).toBe(true);

    expect(ledger.getRun('AGT-3')?.lastErrorCode).toBeUndefined();

    ledger.close();
  });

  it('promotes only a run that is still parked when the promotion runs', () => {
    // The caller reads the park on one heartbeat and promotes on the next
    // statement. In between, a second daemon can end the parked attempt and back
    // the run off again for its own reasons — so the park is re-read here, under
    // this transaction's write lock, instead of trusted from the caller.
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'AGT-4');
    const parked = claim(ledger, 'AGT-4', 'daemon');
    ledger.transition(parked, 'RETRY_AT', { retryAt: 9_000, errorCode: 'waiting_on_operator' }, 2_100);

    expect(ledger.readmitParkedRun('AGT-4', 'waiting_on_operator', 2_200)).toBe(true);
    expect(ledger.getRun('AGT-4')?.state).toBe('READY');

    // That attempt now fails on its own account.
    const retried = claim(ledger, 'AGT-4', 'daemon', 2_300);
    ledger.transition(retried, 'RETRY_AT', { retryAt: 9_000, errorCode: 'failed' }, 2_400);

    expect(ledger.readmitParkedRun('AGT-4', 'waiting_on_operator', 2_500)).toBe(false);
    expect(ledger.getRun('AGT-4')?.state).toBe('RETRY_AT');

    ledger.close();
  });
});

describe('RunLedger claim and fencing races', () => {
  it('allows exactly one winner when two daemon connections claim one issue', async () => {
    const dbPath = createDbPath();
    const first = new RunLedger(dbPath);
    const second = new RunLedger(dbPath);
    register(first, 'RACE-1');

    // Promise.all models two independent heartbeat callbacks. The correctness
    // comes from the SQLite CAS, not from process-local queue inspection.
    const results = await Promise.all([
      Promise.resolve().then(() => first.claimRun('RACE-1', { ownerInstanceId: 'a', leaseMs: 1_000, now: 2_000 })),
      Promise.resolve().then(() => second.claimRun('RACE-1', { ownerInstanceId: 'b', leaseMs: 1_000, now: 2_000 })),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(first.getRun('RACE-1')).toMatchObject({ state: 'CLAIMED', attemptNo: 1, leaseEpoch: 1 });
    first.close();
    second.close();
  });

  it('backs off an unclaimed candidate without mutating a concurrent winner', () => {
    const dbPath = createDbPath();
    const first = new RunLedger(dbPath);
    const second = new RunLedger(dbPath);
    register(first, 'DEFER-FREE');
    register(first, 'DEFER-OWNED');
    const owned = claim(first, 'DEFER-OWNED', 'winner');

    expect(second.deferUnclaimedRun('DEFER-FREE', 5_000, 'repo busy', 2_000)).toBe(true);
    expect(second.getRun('DEFER-FREE')).toMatchObject({ state: 'RETRY_AT', retryAt: 5_000 });
    expect(second.deferUnclaimedRun('DEFER-OWNED', 5_000, 'lost race', 2_000)).toBe(false);
    expect(second.getRun('DEFER-OWNED')).toMatchObject({
      state: 'CLAIMED', leaseToken: owned.leaseToken, leaseEpoch: owned.leaseEpoch,
    });
    first.close();
    second.close();
  });

  it('enforces repository admission atomically across daemon connections', async () => {
    const dbPath = createDbPath();
    const first = new RunLedger(dbPath);
    const second = new RunLedger(dbPath);
    register(first, 'RACE-2A', '/same-repo');
    register(first, 'RACE-2B', '/same-repo');

    const results = await Promise.all([
      Promise.resolve().then(() => first.claimRun('RACE-2A', { ownerInstanceId: 'a', leaseMs: 1_000, now: 2_000 })),
      Promise.resolve().then(() => second.claimRun('RACE-2B', { ownerInstanceId: 'b', leaseMs: 1_000, now: 2_000 })),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(first.listRuns(['CLAIMED'])).toHaveLength(1);
    first.close();
    second.close();
  });

  it('makes a sibling integration reservation mutually exclusive with worker claim', () => {
    const dbPath = createDbPath();
    const integration = new RunLedger(dbPath);
    const worker = new RunLedger(dbPath);
    register(integration, 'AGT-4078', '/same-repo');

    const reservation = integration.acquireIntegrationReservation(
      '/same-repo',
      'swarm/AGT-4078',
      'AGT-4078',
      { ownerInstanceId: 'integration', leaseMs: 1_000, now: 2_000 },
    );
    expect(reservation).not.toBeNull();
    expect(worker.claimRun('AGT-4078', {
      ownerInstanceId: 'worker', leaseMs: 1_000, now: 2_001,
    })).toBeNull();

    expect(integration.releaseIntegrationReservation(reservation!)).toBe(true);
    expect(worker.claimRun('AGT-4078', {
      ownerInstanceId: 'worker', leaseMs: 1_000, now: 2_002,
    })).not.toBeNull();
    integration.close();
    worker.close();
  });

  it('admits disjoint same-repository scopes and rejects an overlapping scope atomically', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'SCOPE-A', '/same-repo', ['src/a.ts']);
    register(ledger, 'SCOPE-B', '/same-repo', ['src/b.ts']);
    register(ledger, 'SCOPE-OVERLAP', '/same-repo', ['./SRC/A.ts']);

    expect(ledger.claimRun('SCOPE-A', {
      ownerInstanceId: 'a', leaseMs: 1_000, now: 2_000,
      maxActiveForProject: 3, conflictScope: ['src/a.ts'],
    })).not.toBeNull();
    expect(ledger.claimRun('SCOPE-B', {
      ownerInstanceId: 'b', leaseMs: 1_000, now: 2_001,
      maxActiveForProject: 3, conflictScope: ['src/b.ts'],
    })).not.toBeNull();
    expect(ledger.claimRun('SCOPE-OVERLAP', {
      ownerInstanceId: 'c', leaseMs: 1_000, now: 2_002,
      maxActiveForProject: 3, conflictScope: ['./SRC/A.ts'],
    })).toBeNull();
    expect(ledger.listRuns(['CLAIMED'])).toHaveLength(2);
    ledger.close();
  });

  it('bypasses scope serialization only when the caller explicitly omits conflictScope', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'KNOWN', '/same-repo', ['src/known.ts']);
    register(ledger, 'UNKNOWN', '/same-repo');
    const known = ledger.claimRun('KNOWN', {
      ownerInstanceId: 'known', leaseMs: 1_000, now: 2_000,
      maxActiveForProject: 2, conflictScope: ['src/known.ts'],
    });
    expect(known).not.toBeNull();
    expect(ledger.claimRun('UNKNOWN', {
      ownerInstanceId: 'unknown', leaseMs: 1_000, now: 2_001,
      maxActiveForProject: 2,
    })).not.toBeNull();
    ledger.close();
  });

  it('fails closed when a parallel claim explicitly supplies an unknown scope', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'KNOWN', '/same-repo', ['src/known.ts']);
    register(ledger, 'UNKNOWN', '/same-repo');
    expect(ledger.claimRun('KNOWN', {
      ownerInstanceId: 'known', leaseMs: 1_000, now: 2_000,
      maxActiveForProject: 2, conflictScope: ['src/known.ts'],
    })).not.toBeNull();
    expect(ledger.claimRun('UNKNOWN', {
      ownerInstanceId: 'unknown', leaseMs: 1_000, now: 2_001,
      maxActiveForProject: 2, conflictScope: [],
    })).toBeNull();
    ledger.close();
  });

  // vela 2026-09-02: 9 of 12 slots idle because every repository serialized
  // to one unscoped run. The operator can now choose to rely on isolated
  // worktrees and post-merge integration requeue instead.
  it('admits unknown scopes on either side under unknownScopeAdmission=admit, still refusing a known overlap', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'UNKNOWN-1', '/same-repo');
    register(ledger, 'UNKNOWN-2', '/same-repo');
    register(ledger, 'KNOWN-A', '/same-repo', ['src/a.ts']);
    register(ledger, 'KNOWN-A2', '/same-repo', ['src/a.ts']);
    const admit = { leaseMs: 1_000, maxActiveForProject: 4, unknownScopeAdmission: 'admit' as const };

    expect(ledger.claimRun('UNKNOWN-1', { ...admit, ownerInstanceId: 'u1', now: 2_000, conflictScope: [] })).not.toBeNull();
    // Unknown next to unknown.
    expect(ledger.claimRun('UNKNOWN-2', { ...admit, ownerInstanceId: 'u2', now: 2_001, conflictScope: [] })).not.toBeNull();
    // Known next to unknown actives.
    expect(ledger.claimRun('KNOWN-A', { ...admit, ownerInstanceId: 'a', now: 2_002, conflictScope: ['src/a.ts'] })).not.toBeNull();
    // Known overlap is still a conflict.
    expect(ledger.claimRun('KNOWN-A2', { ...admit, ownerInstanceId: 'a2', now: 2_003, conflictScope: ['src/a.ts'] })).toBeNull();
    expect(ledger.listRuns(['CLAIMED'])).toHaveLength(3);
    ledger.close();
  });

  it('rejects a late callback after lease expiry and replacement', () => {
    const dbPath = createDbPath();
    const oldDaemon = new RunLedger(dbPath);
    const newDaemon = new RunLedger(dbPath);
    register(oldDaemon, 'RACE-3');
    const stale = claim(oldDaemon, 'RACE-3', 'old', 2_000);
    expect(oldDaemon.transition(stale, 'EXECUTING', {}, 2_100)).toBe(true);

    expect(newDaemon.reconcileExpiredLeases(3_001)).toHaveLength(1);
    expect(newDaemon.claimRun('RACE-3', {
      ownerInstanceId: 'new', leaseMs: 1_000, now: 3_002,
    })).toBeNull(); // artifact reconciliation must explicitly return it to READY
    expect(newDaemon.markReady('RACE-3', 3_002)).toBe(false); // executor exit is still unconfirmed
    expect(newDaemon.confirmExecutorExit(stale, 3_002)).toBe(true);
    expect(newDaemon.markReady('RACE-3', 3_002)).toBe(true);
    const replacement = claim(newDaemon, 'RACE-3', 'new', 3_002);

    expect(oldDaemon.transition(stale, 'VERIFYING', {}, 3_003)).toBe(false);
    expect(newDaemon.transition(replacement, 'EXECUTING', {}, 3_003)).toBe(true);
    expect(newDaemon.getRun('RACE-3')).toMatchObject({
      ownerInstanceId: 'new', leaseEpoch: 2, attemptNo: 2, state: 'EXECUTING',
    });
    oldDaemon.close();
    newDaemon.close();
  });

  it('reconciles a proven-dead owner before its lease expires using the full ownership fence', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'DEAD-OWNER');
    const stale = claim(ledger, 'DEAD-OWNER', '1234-old-generation', 2_000);
    expect(ledger.transition(stale, 'EXECUTING', {}, 2_100)).toBe(true);

    expect(ledger.reconcileDeadOwner({ ...stale, leaseToken: 'wrong-token' }, 2_200)).toBe(false);
    expect(ledger.getRun('DEAD-OWNER')?.state).toBe('EXECUTING');
    expect(ledger.reconcileDeadOwner(stale, 2_200)).toBe(true);
    expect(ledger.getRun('DEAD-OWNER')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      lastErrorCode: 'owner_process_exited',
    });
    expect(ledger.markAttemptRemediated('DEAD-OWNER', 1, 'owner exit handling fixed', 2_200)).toBe(true);
    expect(ledger.confirmExecutorExit(stale, 2_201)).toBe(true);
    expect(ledger.markReady('DEAD-OWNER', 2_202)).toBe(true);
    ledger.close();
  });

  it('does not resurrect an already-expired lease through renewal', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'RACE-4');
    const stale = claim(ledger, 'RACE-4', 'daemon-a', 2_000);

    expect(ledger.renewLease(stale, 1_000, 3_001)).toBeNull();
    expect(ledger.reconcileExpiredLeases(3_001)).toHaveLength(1);
    expect(ledger.getRun('RACE-4')?.state).toBe('NEEDS_RECONCILE');
    ledger.close();
  });

  it('atomically parks an expired owner and blocks overlap until reconciliation clears it', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'RACE-EXPIRED-A', '/same-repo');
    register(ledger, 'RACE-EXPIRED-B', '/same-repo');
    const stale = claim(ledger, 'RACE-EXPIRED-A', 'old', 2_000);

    expect(ledger.claimRun('RACE-EXPIRED-B', {
      ownerInstanceId: 'new', leaseMs: 1_000, now: 3_001,
    })).toBeNull();
    expect(ledger.getRun('RACE-EXPIRED-A')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      lastErrorCode: 'lease_expired',
    });
    expect(ledger.claimRun('RACE-EXPIRED-B', {
      ownerInstanceId: 'new', leaseMs: 1_000, now: 3_002,
    })).toBeNull();

    expect(ledger.markReady('RACE-EXPIRED-A', 3_003)).toBe(false);
    expect(ledger.confirmExecutorExit(stale, 3_003)).toBe(true);
    expect(ledger.markReady('RACE-EXPIRED-A', 3_003)).toBe(true);
    expect(ledger.claimRun('RACE-EXPIRED-B', {
      ownerInstanceId: 'new', leaseMs: 1_000, now: 3_004,
    })).not.toBeNull();
    ledger.close();
  });

  it('atomically reconciles and releases an expired owner when its executor exit is confirmed', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'RACE-CONFIRM-EXPIRED');
    const stale = claim(ledger, 'RACE-CONFIRM-EXPIRED', 'old-owner', 2_000);
    expect(ledger.transition(stale, 'EXECUTING', {}, 2_100)).toBe(true);

    // The exit callback may win the race with the periodic reconciliation pass.
    // It must park the expired generation before clearing its ownership token.
    expect(ledger.confirmExecutorExit(stale, 3_001)).toBe(true);
    expect(ledger.getRun('RACE-CONFIRM-EXPIRED')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      ownerInstanceId: undefined,
      leaseToken: undefined,
      lastErrorCode: 'lease_expired',
    });
    ledger.close();
  });

  it('lets explicit same-repository parallel capacity account for a reconciliation slot', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'RECONCILE-SLOT', '/parallel-repo');
    register(ledger, 'PARALLEL-WORK', '/parallel-repo');
    const stale = claim(ledger, 'RECONCILE-SLOT', 'old', 2_000);
    expect(ledger.transition(stale, 'NEEDS_RECONCILE', {}, 2_100)).toBe(true);

    expect(ledger.claimRun('PARALLEL-WORK', {
      ownerInstanceId: 'new', leaseMs: 1_000, now: 2_200,
      maxActiveForProject: 2,
    })).not.toBeNull();
    ledger.close();
  });

  it('records an attempt result only once for a lease generation', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'RACE-RESULT');
    const runClaim = claim(ledger, 'RACE-RESULT', 'daemon');
    expect(ledger.recordAttemptResult(runClaim, { success: true, finalStatus: 'approved' }, 2_100)).toBe(true);
    expect(ledger.recordAttemptResult(runClaim, { success: false, finalStatus: 'failed' }, 2_101)).toBe(false);
    ledger.close();
  });

  it('serializes admission across real OS processes sharing one database', async () => {
    const path = createDbPath();
    const issueIds = Array.from({ length: 8 }, (_, index) => `PROC-${index}`);

    const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
    const fixture = resolve('src/automation/runLedgerClaimProcess.fixture.ts');
    const results = await Promise.all(issueIds.map((issueId, index) =>
      execFileAsync(process.execPath, [tsxCli, fixture, path, issueId, `owner-${index}`, '2000']),
    ));

    expect(results.filter(({ stdout }) => stdout.trim() === 'claimed')).toHaveLength(1);
    const verify = new RunLedger(path);
    expect(verify.listRuns(['CLAIMED'])).toHaveLength(1);
    verify.close();
  }, 30_000);

  it('atomically separates disjoint and overlapping scopes across real OS processes', async () => {
    const tsxCli = resolve('node_modules/tsx/dist/cli.mjs');
    const fixture = resolve('src/automation/runLedgerClaimProcess.fixture.ts');

    const disjointPath = createDbPath();
    const disjoint = await Promise.all(['a', 'b', 'c'].map((scope, index) =>
      execFileAsync(process.execPath, [
        tsxCli, fixture, disjointPath, `DISJOINT-${index}`, `owner-${index}`,
        '2000', '3', `src/${scope}.ts`,
      ]),
    ));
    expect(disjoint.filter(({ stdout }) => stdout.trim() === 'claimed')).toHaveLength(3);

    const overlapPath = createDbPath();
    const overlapping = await Promise.all(Array.from({ length: 3 }, (_, index) =>
      execFileAsync(process.execPath, [
        tsxCli, fixture, overlapPath, `OVERLAP-${index}`, `owner-${index}`,
        '2000', '3', 'src/shared.ts',
      ]),
    ));
    expect(overlapping.filter(({ stdout }) => stdout.trim() === 'claimed')).toHaveLength(1);

    const ancestorPath = createDbPath();
    const ancestorOverlap = await Promise.all([
      ['DIRECTORY', 'owner-directory', 'src/coordination'],
      ['CHILD', 'owner-child', 'src/coordination/store.ts'],
    ].map(([issueId, owner, scope]) => execFileAsync(process.execPath, [
      tsxCli, fixture, ancestorPath, issueId, owner, '2000', '2', scope,
    ])));
    expect(ancestorOverlap.filter(({ stdout }) => stdout.trim() === 'claimed')).toHaveLength(1);
  }, 30_000);

  it('fails closed without a partial claim when the SQLite writer is busy', () => {
    const path = createDbPath();
    const owner = new RunLedger(path);
    const contender = new RunLedger(path, { busyTimeoutMs: 10 });
    register(owner, 'BUSY-1');
    const blocker = new Database(path);
    blocker.exec('BEGIN IMMEDIATE');
    try {
      expect(() => contender.claimRun('BUSY-1', {
        ownerInstanceId: 'contender', leaseMs: 1_000, now: 2_000,
      })).toThrow(/busy|locked/i);
    } finally {
      blocker.exec('ROLLBACK');
      blocker.close();
    }
    expect(owner.getRun('BUSY-1')).toMatchObject({ state: 'READY', attemptNo: 0, leaseEpoch: 0 });
    owner.close();
    contender.close();
  });

  it.each(['CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING'] as const)(
    'recovers a process kill at %s without making it directly claimable',
    (crashState) => {
      const path = createDbPath();
      const beforeCrash = new RunLedger(path);
      register(beforeCrash, `KILL-${crashState}`);
      const runClaim = claim(beforeCrash, `KILL-${crashState}`, 'dead-process', 2_000);
      if (crashState !== 'CLAIMED') expect(beforeCrash.transition(runClaim, 'EXECUTING', {}, 2_100)).toBe(true);
      if (crashState === 'VERIFYING') expect(beforeCrash.transition(runClaim, 'VERIFYING', {}, 2_200)).toBe(true);
      if (crashState === 'PUBLISHING') expect(beforeCrash.transition(runClaim, 'PUBLISHING', {}, 2_200)).toBe(true);
      beforeCrash.close();

      const afterRestart = new RunLedger(path);
      expect(afterRestart.reconcileExpiredLeases(3_001)).toHaveLength(1);
      expect(afterRestart.getRun(`KILL-${crashState}`)?.state).toBe('NEEDS_RECONCILE');
      expect(afterRestart.claimRun(`KILL-${crashState}`, {
        ownerInstanceId: 'replacement', leaseMs: 1_000, now: 3_002,
      })).toBeNull();
      afterRestart.close();
    },
  );

  it('opens a repository circuit when the rolling attempt budget is exhausted', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'BUDGET-1', '/budget-repo');
    register(ledger, 'BUDGET-2', '/budget-repo');
    const first = ledger.claimRun('BUDGET-1', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_000,
      maxAttemptsPerHour: 1, circuitCooldownMs: 60_000,
    });
    expect(first).not.toBeNull();
    expect(ledger.transition(first!, 'RETRY_AT', { retryAt: 9_000 }, 2_100)).toBe(true);

    expect(ledger.claimRun('BUDGET-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxAttemptsPerHour: 1, circuitCooldownMs: 60_000,
    })).toBeNull();
    expect(ledger.getCircuitOpenUntil('BUDGET-2', 2_200)).toBe(62_200);
    expect(ledger.getCircuitOpenUntil('BUDGET-2', 62_200)).toBeUndefined();
    expect(ledger.getMetrics(2_200).openCircuits).toBe(1);
    ledger.close();
  });

  it('opens a failure circuit as soon as the threshold result is recorded', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'FAIL-1', '/failure-repo');
    register(ledger, 'FAIL-2', '/failure-repo');
    const first = claim(ledger, 'FAIL-1', 'daemon', 2_000);
    expect(ledger.recordAttemptResult(first, {
      success: false,
      finalStatus: 'infra_error',
      repositoryInfra: true, // a failed git worktree add — the repository's own fault (AGT-4038)
      maxFailuresPerHour: 1,
      circuitCooldownMs: 60_000,
    }, 2_100)).toBe(true);
    expect(ledger.transition(first, 'RETRY_AT', { retryAt: 9_000 }, 2_101)).toBe(true);

    expect(ledger.claimRun('FAIL-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxFailuresPerHour: 1,
    })).toBeNull();
    expect(ledger.getMetrics(2_200).openCircuits).toBe(1);
    ledger.close();
  });

  it('opens a repository circuit when the daily cost budget is exhausted', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'COST-1', '/cost-repo');
    register(ledger, 'COST-2', '/cost-repo');
    const first = claim(ledger, 'COST-1', 'daemon', 2_000);
    expect(ledger.recordAttemptResult(first, {
      success: true,
      finalStatus: 'approved',
      costUsd: 1.25,
    }, 2_100)).toBe(true);
    expect(ledger.transition(first, 'CANCELLED', {}, 2_101)).toBe(true);

    expect(ledger.claimRun('COST-2', {
      ownerInstanceId: 'daemon',
      leaseMs: 1_000,
      now: 2_200,
      maxCostUsdPerDay: 1,
      circuitCooldownMs: 60_000,
    })).toBeNull();
    expect(ledger.getMetrics(2_200).openCircuits).toBe(1);

    // Expired circuits are removed in the same admission transaction, so a
    // stale budget row cannot permanently stop unrelated future work.
    register(ledger, 'COST-3', '/cost-repo');
    expect(ledger.claimRun('COST-3', {
      ownerInstanceId: 'daemon',
      leaseMs: 1_000,
      now: 62_201,
    })).not.toBeNull();
    expect(ledger.getMetrics(62_201).openCircuits).toBe(0);
    ledger.close();
  });

  it('rebuilds a failure circuit from durable attempts after a coordinator restart', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'FAIL-REBUILD-1', '/failure-rebuild-repo');
    register(ledger, 'FAIL-REBUILD-2', '/failure-rebuild-repo');
    const first = claim(ledger, 'FAIL-REBUILD-1', 'old-daemon', 2_000);
    expect(ledger.recordAttemptResult(first, {
      success: false,
      finalStatus: 'infra_error',
      repositoryInfra: true, // a failed git worktree add — the repository's own fault (AGT-4038)
    }, 2_100)).toBe(true);
    expect(ledger.transition(first, 'RETRY_AT', { retryAt: 9_000 }, 2_101)).toBe(true);

    expect(ledger.claimRun('FAIL-REBUILD-2', {
      ownerInstanceId: 'new-daemon',
      leaseMs: 1_000,
      now: 2_200,
      maxFailuresPerHour: 1,
    })).toBeNull();
    expect(ledger.getMetrics(2_200).openCircuits).toBe(1);
    ledger.close();
  });

  it('does not let an agent asking the operator a question close the repository', () => {
    // A run that stops on `ask_human` has not broken anything — it is waiting on
    // a human. Counting it as a repository failure means a handful of polite
    // questions shuts every other task out: measured on vela, six questions and
    // one real failure opened the circuit at 7/6 and idled the daemon for an
    // hour, which is the opposite of what a working human-in-the-loop should do.
    const ledger = new RunLedger(createDbPath());
    for (const id of ['ASK-1', 'ASK-2', 'ASK-3']) register(ledger, id, '/asking-repo');

    for (const [index, id] of ['ASK-1', 'ASK-2'].entries()) {
      const held = claim(ledger, id, 'daemon', 2_000 + index, 3);
      expect(ledger.recordAttemptResult(held, {
        success: false,
        finalStatus: 'waiting_on_operator',
        maxFailuresPerHour: 1,
        circuitCooldownMs: 60_000,
      }, 2_100 + index)).toBe(true);
    }

    expect(ledger.getMetrics(2_200).openCircuits).toBe(0);
    // And the next task on that repository can still start.
    expect(ledger.claimRun('ASK-3', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_300,
      maxActiveForProject: 3, maxFailuresPerHour: 1,
    })).not.toBeNull();
    ledger.close();
  });

  it('still opens the circuit for failures that are the repository\'s own', () => {
    // The guard is about what a question means, not about disabling the circuit.
    const ledger = new RunLedger(createDbPath());
    for (const id of ['REAL-1', 'REAL-2']) register(ledger, id, '/breaking-repo');
    const held = claim(ledger, 'REAL-1', 'daemon', 2_000, 2);
    expect(ledger.recordAttemptResult(held, {
      success: false,
      finalStatus: 'failed',
      maxFailuresPerHour: 1,
      circuitCooldownMs: 60_000,
    }, 2_100)).toBe(true);

    expect(ledger.claimRun('REAL-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxActiveForProject: 2, maxFailuresPerHour: 1,
    })).toBeNull();
    ledger.close();
  });

  it('does not let an adapter timeout, tooling failure, or network blip close the repository (AGT-4038)', () => {
    // infra_error is overloaded: a failed git worktree add (disk full, a stale
    // .git lock, a corrupt repo) is the repository's own fault and should trip
    // the circuit, but an adapter timeout or CodeQL/network failure is not —
    // measured on vela, 5 adapter timeouts plus 1 real failure and 1
    // executor_throw opened the circuit at 7/6 for a healthy repository.
    const ledger = new RunLedger(createDbPath());
    for (const id of ['ADAPTER-1', 'ADAPTER-2']) register(ledger, id, '/adapter-flaky-repo');
    const held = claim(ledger, 'ADAPTER-1', 'daemon', 2_000, 2);
    expect(ledger.recordAttemptResult(held, {
      success: false,
      finalStatus: 'infra_error', // codex-responses timeout after 360000ms — not repositoryInfra
      maxFailuresPerHour: 1,
      circuitCooldownMs: 60_000,
    }, 2_100)).toBe(true);

    expect(ledger.getMetrics(2_100).openCircuits).toBe(0);
    expect(ledger.claimRun('ADAPTER-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxActiveForProject: 2, maxFailuresPerHour: 1,
    })).not.toBeNull();
    ledger.close();
  });

  it('does not count a transient admission deferral as a repository failure', () => {
    const ledger = new RunLedger(createDbPath());
    for (const id of ['DEFERRED-1', 'DEFERRED-2']) register(ledger, id, '/busy-repo');
    const held = claim(ledger, 'DEFERRED-1', 'daemon', 2_000, 2);
    expect(ledger.recordAttemptResult(held, {
      success: false,
      finalStatus: 'deferred',
      maxFailuresPerHour: 1,
      circuitCooldownMs: 60_000,
    }, 2_100)).toBe(true);

    expect(ledger.getMetrics(2_100).openCircuits).toBe(0);
    expect(ledger.claimRun('DEFERRED-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxActiveForProject: 2, maxFailuresPerHour: 1,
    })).not.toBeNull();
    ledger.close();
  });

  it('opens the circuit for a git worktree add failure regardless of admission-check timing (AGT-4038)', () => {
    // The two circuit checks — inline in claimRun's own budget check, and in
    // recordAttemptResult right after the attempt that trips it — must agree
    // on the same repositoryInfra distinction, or one path silently ignores
    // what the other enforces.
    const ledger = new RunLedger(createDbPath());
    for (const id of ['WT-1', 'WT-2']) register(ledger, id, '/worktree-broken-repo');
    const held = claim(ledger, 'WT-1', 'daemon', 2_000, 2);
    expect(ledger.recordAttemptResult(held, {
      success: false,
      finalStatus: 'infra_error',
      repositoryInfra: true, // disk full / .git lock / corrupt repo
      maxFailuresPerHour: 1,
      circuitCooldownMs: 60_000,
    }, 2_100)).toBe(true);

    expect(ledger.getMetrics(2_100).openCircuits).toBe(1);
    expect(ledger.claimRun('WT-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxActiveForProject: 2, maxFailuresPerHour: 1,
    })).toBeNull();
    ledger.close();
  });

  it('preserves remediated attempts while excluding them from the failure circuit', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'FIXED-1', '/fixed-repo');
    register(ledger, 'FIXED-2', '/fixed-repo');
    const first = claim(ledger, 'FIXED-1', 'daemon', 2_000);
    expect(ledger.recordAttemptResult(first, {
      success: false,
      finalStatus: 'infra_error',
      repositoryInfra: true, // a failed git worktree add — would open the circuit if not remediated
      maxFailuresPerHour: 1,
      circuitCooldownMs: 60_000,
    }, 2_100)).toBe(true);
    expect(ledger.transition(first, 'RETRY_AT', { retryAt: 9_000 }, 2_101)).toBe(true);

    expect(ledger.markAttemptRemediated('FIXED-1', 1, 'provider model routing fixed', 2_150)).toBe(true);
    expect(ledger.getMetrics(2_150).openCircuits).toBe(0);
    expect(ledger.claimRun('FIXED-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxAttemptsPerHour: 1, maxFailuresPerHour: 1,
    })).not.toBeNull();
    ledger.close();
  });
});

describe('RunLedger schema migration', () => {
  it('imports legacy state once and never lets a later import overwrite durable truth', () => {
    const ledger = new RunLedger(createDbPath());
    const first = ledger.importRun({
      issueId: 'MIGRATE-LEGACY', source: 'linear', identifier: 'INT-LEGACY',
      title: 'legacy task', projectPath: '/repo', state: 'NEEDS_RECONCILE',
      branchName: 'swarm/legacy', errorMessage: 'ambiguous legacy completion',
    }, 1_000);
    expect(first.imported).toBe(true);
    expect(first.record).toMatchObject({ state: 'NEEDS_RECONCILE', branchName: 'swarm/legacy' });

    expect(ledger.markReady('MIGRATE-LEGACY', 1_100)).toBe(true);
    const second = ledger.importRun({
      issueId: 'MIGRATE-LEGACY', source: 'linear', projectPath: '/other', state: 'DONE',
    }, 1_200);
    expect(second.imported).toBe(false);
    expect(second.record).toMatchObject({ state: 'READY', projectPath: '/repo' });
    ledger.close();
  });

  it('upgrades a v1 attempts table additively and remains writable', () => {
    const path = createDbPath();
    const old = new Database(path);
    old.exec(`
      CREATE TABLE automation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO automation_meta(key, value) VALUES ('schema_version', '1');
      CREATE TABLE automation_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        issue_id TEXT NOT NULL,
        attempt_no INTEGER NOT NULL,
        lease_epoch INTEGER NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        result_json TEXT,
        error_code TEXT,
        error_message TEXT,
        UNIQUE(issue_id, attempt_no)
      );
    `);
    old.close();

    const ledger = new RunLedger(path);
    register(ledger, 'MIGRATE-1');
    const migratedClaim = claim(ledger, 'MIGRATE-1', 'daemon');
    expect(ledger.recordAttemptResult(migratedClaim, {
      success: true, finalStatus: 'approved', costUsd: 0.25,
    }, 2_100)).toBe(true);
    ledger.close();

    const verify = new Database(path, { readonly: true });
    const attemptColumns = (verify.pragma('table_info(automation_attempts)') as Array<{ name: string }>).map((row) => row.name);
    const runColumns = (verify.pragma('table_info(automation_runs)') as Array<{ name: string }>).map((row) => row.name);
    expect(attemptColumns).toEqual(expect.arrayContaining(['result_status', 'success', 'cost_usd']));
    expect(runColumns).toEqual(expect.arrayContaining(['tracker_state', 'tracker_state_type', 'tracker_checked_at']));
    expect((verify.prepare("SELECT value FROM automation_meta WHERE key = 'schema_version'").get() as { value: string }).value).toBe('4');
    verify.close();
  });
});

describe('RunLedger durable outbox races', () => {
  function prepareSyncRun(ledger: RunLedger, issueId: string): RunClaim {
    register(ledger, issueId);
    const runClaim = claim(ledger, issueId, 'executor', 2_000);
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_100)).toBe(true);
    const effect = ledger.enqueueEffect(runClaim, {
      kind: 'linear.state.done',
      dedupeKey: `linear:${issueId}:done:attempt-1`,
      payload: { issueId, state: 'Done', marker: `openswarm-effect:${issueId}:1` },
    }, 2_200);
    expect(effect).not.toBeNull();
    expect(ledger.transition(runClaim, 'SYNC_PENDING', {}, 2_300)).toBe(true);
    return runClaim;
  }

  it('deduplicates effect creation and rejects a key collision', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OUT-1');
    const runClaim = claim(ledger, 'OUT-1', 'executor');
    const input = { kind: 'linear.comment', dedupeKey: 'effect-1', payload: { text: 'done' } };

    const first = ledger.enqueueEffect(runClaim, input, 2_100);
    const second = ledger.enqueueEffect(runClaim, input, 2_101);
    expect(second?.id).toBe(first?.id);
    expect(() => ledger.enqueueEffect(runClaim, {
      kind: 'github.pr', dedupeKey: 'effect-1', payload: { branch: 'different' },
    }, 2_102)).toThrow(/dedupe key collision/i);
    expect(() => ledger.enqueueEffect(runClaim, {
      kind: 'linear.comment', dedupeKey: 'effect-1', payload: { text: 'changed' },
    }, 2_103)).toThrow(/dedupe key collision/i);
    ledger.close();
  });

  it('does not expose an outbox effect before its run reaches SYNC_PENDING', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OUT-HIDDEN');
    const runClaim = claim(ledger, 'OUT-HIDDEN', 'executor');
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_050)).toBe(true);
    expect(ledger.enqueueEffect(runClaim, {
      kind: 'tracker.complete', dedupeKey: 'OUT-HIDDEN:1', payload: {},
    }, 2_100)).not.toBeNull();

    expect(ledger.claimNextEffect('sender', 1_000, 2_200)).toBeNull();
    expect(ledger.transition(runClaim, 'SYNC_PENDING', {}, 2_300)).toBe(true);
    expect(ledger.claimNextEffect('sender', 1_000, 2_400)).not.toBeNull();
    ledger.close();
  });

  it('commits success state and its outbox effect atomically', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OUT-ATOMIC');
    const runClaim = claim(ledger, 'OUT-ATOMIC', 'executor');
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_050)).toBe(true);

    expect(ledger.commitRunForSync(runClaim, {
      kind: 'tracker.complete', dedupeKey: 'OUT-ATOMIC:1', payload: { done: true },
    }, { prUrl: 'https://github.test/pull/atomic' }, 2_100)).toBe(true);
    expect(ledger.getRun('OUT-ATOMIC')).toMatchObject({
      state: 'SYNC_PENDING', prUrl: 'https://github.test/pull/atomic',
    });
    expect(ledger.claimNextEffect('sender', 1_000, 2_200)?.dedupeKey).toBe('OUT-ATOMIC:1');
    ledger.close();
  });

  it('rejects transition and outbox publication after the execution lease expires', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OUT-STALE-COMMIT');
    const stale = claim(ledger, 'OUT-STALE-COMMIT', 'executor', 2_000);
    expect(ledger.transition(stale, 'EXECUTING', {}, 2_050)).toBe(true);

    expect(ledger.transition(stale, 'VERIFYING', {}, 3_001)).toBe(false);
    expect(ledger.commitRunForSync(stale, {
      kind: 'tracker.complete',
      dedupeKey: 'OUT-STALE-COMMIT:1',
      payload: { shouldNotExist: true },
    }, {}, 3_001)).toBe(false);
    expect(ledger.getEffectByDedupeKey('OUT-STALE-COMMIT:1')).toBeNull();
    expect(ledger.getRun('OUT-STALE-COMMIT')?.state).toBe('EXECUTING');
    ledger.close();
  });

  it('finalizes a cancellation only after the current-attempt effect is acknowledged', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OUT-CANCEL');
    const runClaim = claim(ledger, 'OUT-CANCEL', 'executor');
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_050)).toBe(true);

    expect(ledger.commitRunForSync(runClaim, {
      kind: 'tracker.cancel', dedupeKey: 'OUT-CANCEL:1', payload: { cancelled: true },
    }, {}, 2_100)).toBe(true);
    expect(ledger.getRun('OUT-CANCEL')?.state).toBe('SYNC_PENDING');

    const effect = ledger.claimNextEffect('sender', 1_000, 2_200)!;
    expect(ledger.getRun('OUT-CANCEL')?.state).toBe('SYNC_PENDING');
    expect(ledger.ackEffectAndFinalizeRun(effect, 2_300)).toEqual({
      acknowledged: true,
      finalized: true,
      issueId: 'OUT-CANCEL',
    });
    expect(ledger.getRun('OUT-CANCEL')?.state).toBe('CANCELLED');
    ledger.close();
  });

  it('allows only one outbox consumer to claim a delivery', async () => {
    const dbPath = createDbPath();
    const first = new RunLedger(dbPath);
    const second = new RunLedger(dbPath);
    prepareSyncRun(first, 'OUT-2');

    const results = await Promise.all([
      Promise.resolve().then(() => first.claimNextEffect('sender-a', 1_000, 3_000)),
      Promise.resolve().then(() => second.claimNextEffect('sender-b', 1_000, 3_000)),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    first.close();
    second.close();
  });

  it('recovers remote-success/local-crash without duplicating the remote effect', () => {
    const dbPath = createDbPath();
    const beforeCrash = new RunLedger(dbPath);
    prepareSyncRun(beforeCrash, 'OUT-3');
    const firstDelivery = beforeCrash.claimNextEffect('sender-old', 100, 3_000)!;

    // Simulated remote API: an idempotency marker makes repeated delivery a no-op.
    const remoteMarkers = new Set<string>();
    const applyRemote = (dedupeKey: string) => {
      const wasNew = !remoteMarkers.has(dedupeKey);
      remoteMarkers.add(dedupeKey);
      return wasNew;
    };
    expect(applyRemote(firstDelivery.dedupeKey)).toBe(true);
    // Process dies here: no local ack.
    beforeCrash.close();

    const afterRestart = new RunLedger(dbPath);
    const replacement = afterRestart.claimNextEffect('sender-new', 100, 3_101)!;
    expect(replacement.leaseEpoch).toBe(firstDelivery.leaseEpoch + 1);
    expect(applyRemote(replacement.dedupeKey)).toBe(false);

    // A delayed old ack is fenced; only the replacement delivery may commit.
    expect(afterRestart.ackEffect(firstDelivery, 3_102)).toBe(false);
    expect(afterRestart.ackEffect(replacement, 3_102)).toBe(true);
    expect(afterRestart.finalizeSyncedRun('OUT-3', 3_103)).toBe(true);
    expect(afterRestart.getRun('OUT-3')?.state).toBe('DONE');
    expect(remoteMarkers.size).toBe(1);
    afterRestart.close();
  });

  it('atomically acknowledges the final effect and completes its run', () => {
    const ledger = new RunLedger(createDbPath());
    prepareSyncRun(ledger, 'OUT-ATOMIC-ACK');
    const delivery = ledger.claimNextEffect('sender', 1_000, 3_000)!;

    expect(ledger.ackEffectAndFinalizeRun(delivery, 3_100)).toEqual({
      acknowledged: true,
      finalized: true,
      issueId: 'OUT-ATOMIC-ACK',
    });
    expect(ledger.getRun('OUT-ATOMIC-ACK')?.state).toBe('DONE');
    expect(ledger.getEffectByDedupeKey('linear:OUT-ATOMIC-ACK:done:attempt-1')?.status).toBe('applied');
    expect(ledger.ackEffectAndFinalizeRun(delivery, 3_101)).toMatchObject({
      acknowledged: false,
      finalized: false,
    });
    ledger.close();
  });

  it('repairs a legacy crash after effect ACK but before DONE transition', () => {
    const dbPath = createDbPath();
    const beforeCrash = new RunLedger(dbPath);
    prepareSyncRun(beforeCrash, 'OUT-ACK-GAP');
    const delivery = beforeCrash.claimNextEffect('sender', 1_000, 3_000)!;
    expect(beforeCrash.ackEffect(delivery, 3_100)).toBe(true);
    expect(beforeCrash.getRun('OUT-ACK-GAP')?.state).toBe('SYNC_PENDING');
    beforeCrash.close();

    const afterRestart = new RunLedger(dbPath);
    expect(afterRestart.finalizeReadySyncedRuns(3_200)).toEqual(['OUT-ACK-GAP']);
    expect(afterRestart.getRun('OUT-ACK-GAP')?.state).toBe('DONE');
    expect(afterRestart.finalizeReadySyncedRuns(3_201)).toEqual([]);
    afterRestart.close();
  });

  it('rejects outbox ack and retry after delivery lease expiry', () => {
    const ledger = new RunLedger(createDbPath());
    prepareSyncRun(ledger, 'OUT-EXPIRED');
    const stale = ledger.claimNextEffect('sender-old', 100, 3_000)!;

    expect(ledger.ackEffect(stale, 3_101)).toBe(false);
    expect(ledger.retryEffect(stale, 'late failure', 4_000, {}, 3_101)).toBe(false);
    const replacement = ledger.claimNextEffect('sender-new', 100, 3_101)!;
    expect(replacement.leaseEpoch).toBe(stale.leaseEpoch + 1);
    expect(ledger.ackEffect(stale, 3_102)).toBe(false);
    expect(ledger.ackEffect(replacement, 3_102)).toBe(true);
    ledger.close();
  });

  it('renews only the current outbox delivery generation', () => {
    const ledger = new RunLedger(createDbPath());
    prepareSyncRun(ledger, 'OUT-RENEW');
    const delivery = ledger.claimNextEffect('sender', 100, 3_000)!;

    const renewed = ledger.renewEffectLease(delivery, 500, 3_050);
    expect(renewed).toMatchObject({
      id: delivery.id,
      leaseEpoch: delivery.leaseEpoch,
      leaseExpiresAt: 3_550,
      updatedAt: 3_050,
    });
    expect(ledger.renewEffectLease(delivery, 500, 3_551)).toBeNull();
    expect(ledger.ackEffect(delivery, 3_552)).toBe(false);
    ledger.close();
  });

  it('does not finalize while an effect is pending or dead', () => {
    const ledger = new RunLedger(createDbPath());
    prepareSyncRun(ledger, 'OUT-4');
    expect(ledger.finalizeSyncedRun('OUT-4', 3_000)).toBe(false);

    const delivery = ledger.claimNextEffect('sender', 1_000, 3_000)!;
    expect(ledger.retryEffect(delivery, 'permission denied', 9_000, { dead: true }, 3_100)).toBe(true);
    expect(ledger.finalizeSyncedRun('OUT-4', 3_101)).toBe(false);
    expect(ledger.getMetrics(3_101).effectsByStatus.dead).toBe(1);
    ledger.close();
  });

  it('recovers a PR published immediately before executor crash without rerunning', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'OUT-5');
    const runClaim = claim(ledger, 'OUT-5', 'executor', 2_000);
    expect(ledger.transition(runClaim, 'EXECUTING', {}, 2_100)).toBe(true);
    expect(ledger.transition(runClaim, 'PUBLISHING', {}, 2_200)).toBe(true);
    expect(ledger.reconcileExpiredLeases(3_001)).toHaveLength(1);
    expect(ledger.recoverPublishedRun(
      'OUT-5',
      { prUrl: 'https://github.test/pull/5', headSha: 'abc' },
      { kind: 'tracker.complete', dedupeKey: 'OUT-5:too-early', payload: {} },
      3_001,
    )).toBe(false);
    expect(ledger.confirmExecutorExit(runClaim, 3_002)).toBe(true);

    expect(ledger.recoverPublishedRun(
      'OUT-5',
      { prUrl: 'https://github.test/pull/5', headSha: 'abc' },
      { kind: 'tracker.complete', dedupeKey: 'OUT-5:recovered', payload: { marker: 'OUT-5' } },
      3_002,
    )).toBe(true);
    expect(ledger.getRun('OUT-5')).toMatchObject({
      state: 'SYNC_PENDING', prUrl: 'https://github.test/pull/5', headSha: 'abc',
    });
    expect(ledger.claimRun('OUT-5', { ownerInstanceId: 'replacement', leaseMs: 1_000, now: 3_003 })).toBeNull();
    ledger.close();
  });
});

// Switching a fresh database to WAL takes a brief exclusive lock, and
// busy_timeout does not rescue it — measured here, a connection holding a read
// transaction makes `PRAGMA journal_mode = WAL` wait out the whole timeout and
// then throw SQLITE_BUSY. With a single attempt that turned "another process
// opened the ledger at the same moment" into a hard startup crash, which is
// routine for OpenSwarm: the daemon and the CLI both open this file, under
// agent load, and the multi-process cases above failed 6/6 runs at load ~11
// before the retry loop and 0/6 after it.
describe('RunLedger WAL negotiation', () => {
  // Deliberately named for what it checks: the already-WAL fast path. `first`
  // finishes the conversion before `second` is constructed, so there is no busy
  // contention here — the real contention is covered by the multi-process cases
  // above and by the held-lock case below.
  it('takes the no-op fast path when the database is already in WAL', () => {
    const dbPath = createDbPath();
    const first = new RunLedger(dbPath);
    const second = new RunLedger(dbPath);
    register(second, 'WAL-1');
    expect(second.getRun('WAL-1')).toMatchObject({ issueId: 'WAL-1' });
    second.close();
    first.close();
  });

  it('restores the caller busy_timeout once the conversion is done', () => {
    const dbPath = createDbPath();
    const ledger = new RunLedger(dbPath, { busyTimeoutMs: 7_321 });
    const probe = new Database(dbPath);
    try {
      // The conversion runs at a deliberately short timeout so the retry loop
      // gets many attempts; leaving it there would silently apply a 100ms wait
      // policy to every later statement.
      const [row] = (ledger as unknown as { db: Database.Database }).db.pragma('busy_timeout') as Array<{ timeout: number }>;
      expect(row.timeout).toBe(7_321);
    } finally {
      probe.close();
      ledger.close();
    }
  });

  it('gives a bounded, explicit failure when the conversion can never succeed', () => {
    const dbPath = createDbPath();
    // Force the database into delete mode, then pin a read transaction open so
    // the exclusive lock the conversion needs is permanently unavailable.
    const holder = new Database(dbPath);
    holder.pragma('journal_mode = DELETE');
    holder.exec('CREATE TABLE probe(x)');
    holder.exec('BEGIN');
    holder.prepare('SELECT * FROM probe').all();

    const started = Date.now();
    try {
      expect(() => new RunLedger(dbPath, { busyTimeoutMs: 1_000 })).toThrow(/WAL within \d+ms/);
      // Bounded: it must give up near its budget rather than retry forever.
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
  });
});

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { RunLedger } from './runLedger.js';
import Database from 'better-sqlite3';
import { claim, createDbPath, execFileAsync, register } from './runLedgerTestHelpers.js';

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

  it('fails closed when a parallel claim supplies an unknown scope under serialize', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'KNOWN', '/same-repo', ['src/known.ts']);
    register(ledger, 'UNKNOWN', '/same-repo');
    expect(ledger.claimRun('KNOWN', {
      ownerInstanceId: 'known', leaseMs: 1_000, now: 2_000,
      maxActiveForProject: 2, conflictScope: ['src/known.ts'],
    })).not.toBeNull();
    expect(ledger.claimRun('UNKNOWN', {
      ownerInstanceId: 'unknown', leaseMs: 1_000, now: 2_001,
      maxActiveForProject: 2, conflictScope: [], unknownScopeAdmission: 'serialize',
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

  it('does not open the attempt budget on superseded claim churn (AGT-4260)', () => {
    const ledger = new RunLedger(createDbPath());
    register(ledger, 'SUP-1', '/sup-budget-repo');
    register(ledger, 'SUP-2', '/sup-budget-repo');
    const first = ledger.claimRun('SUP-1', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_000,
      maxAttemptsPerHour: 1, circuitCooldownMs: 60_000,
    });
    expect(first).not.toBeNull();
    expect(ledger.recordAttemptResult(first!, {
      success: true,
      finalStatus: 'superseded',
    }, 2_100)).toBe(true);
    expect(ledger.transition(first!, 'RETRY_AT', { retryAt: 9_000 }, 2_150)).toBe(true);

    const second = ledger.claimRun('SUP-2', {
      ownerInstanceId: 'daemon', leaseMs: 1_000, now: 2_200,
      maxAttemptsPerHour: 1, circuitCooldownMs: 60_000,
    });
    expect(second).not.toBeNull();
    expect(ledger.getMetrics(2_200).openCircuits).toBe(0);
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


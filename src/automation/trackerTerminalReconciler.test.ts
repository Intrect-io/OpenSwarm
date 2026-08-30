import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { ITaskSource } from './taskSource.js';
import { reconcileTrackerTerminalRuns } from './trackerTerminalReconciler.js';

const roots: string[] = [];

function coordinator(): DurableRunCoordinator {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-tracker-reconcile-'));
  roots.push(root);
  return new DurableRunCoordinator({
    mode: 'primary',
    dbPath: join(root, 'automation.db'),
    instanceId: 'test-reconciler',
    leaseMs: 3_000,
  });
}

function source(lookupIssueState: ITaskSource['lookupIssueState']): ITaskSource {
  return {
    kind: 'linear',
    lookupIssueState,
  } as unknown as ITaskSource;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('tracker terminal reconciliation', () => {
  it('closes a Done issue, caches an open issue, and never looks outside dispatch scope', async () => {
    const durableRuns = coordinator();
    const old = 1_000;
    durableRuns.importLegacyRun({
      issueId: 'done-id', source: 'linear', identifier: 'AX-DONE', title: 'done',
      projectPath: '/repo', state: 'RETRY_AT', retryAt: old,
    }, old);
    durableRuns.importLegacyRun({
      issueId: 'open-id', source: 'linear', identifier: 'AX-OPEN', title: 'open',
      projectPath: '/repo', state: 'RETRY_AT', retryAt: old,
    }, old);
    durableRuns.importLegacyRun({
      issueId: 'outside-id', source: 'linear', identifier: 'AX-OUT', title: 'outside',
      projectPath: '/disabled', state: 'RETRY_AT', retryAt: old,
    }, old);
    const lookup = vi.fn<ITaskSource['lookupIssueState']>(async (key) => ({
      ok: true,
      issue: key === 'AX-OPEN'
        ? { state: 'Todo', stateType: 'unstarted' }
        : { state: 'Done', stateType: 'completed' },
    }));
    const now = old + 8 * 60 * 60_000;
    const knownOpen: TaskItem = {
      id: 'open-id', issueId: 'open-id', issueIdentifier: 'AX-OPEN', source: 'linear',
      title: 'open', priority: 2, createdAt: old, linearState: 'Todo',
    };

    const first = await reconcileTrackerTerminalRuns({
      durableRuns,
      source: source(lookup),
      inScope: (path) => path === '/repo',
      knownTasks: [knownOpen],
      now,
    });
    expect(first).toMatchObject({
      eligible: 2, lookedUp: 1, fromFetch: 1, cached: 2, terminal: 1, failed: 0,
    });
    expect(lookup.mock.calls.map(([key]) => key)).toEqual(['AX-DONE']);
    expect(durableRuns.getRun('done-id')).toMatchObject({
      state: 'DONE', trackerState: 'Done', trackerStateType: 'completed',
    });
    expect(durableRuns.getRun('open-id')).toMatchObject({
      state: 'RETRY_AT', trackerState: 'Todo', trackerCheckedAt: now,
    });
    expect(durableRuns.getRun('outside-id')?.trackerCheckedAt).toBeUndefined();

    const cached = await reconcileTrackerTerminalRuns({
      durableRuns,
      source: source(lookup),
      inScope: (path) => path === '/repo',
      now: now + 5 * 60 * 60_000,
    });
    expect(cached.lookedUp).toBe(0);
    expect(lookup).toHaveBeenCalledTimes(1);
    durableRuns.close();
  });

  it('stores lookup failures in the ledger and retries them on the shorter cache interval', async () => {
    const durableRuns = coordinator();
    durableRuns.importLegacyRun({
      issueId: 'error-id', source: 'linear', identifier: 'AX-ERROR', title: 'error',
      projectPath: '/repo', state: 'RETRY_AT', retryAt: 1_000,
    }, 1_000);
    const lookup = vi.fn<ITaskSource['lookupIssueState']>(async () => ({ ok: false, error: 'offline' }));
    const now = 2 * 60 * 60_000;

    expect((await reconcileTrackerTerminalRuns({
      durableRuns, source: source(lookup), now,
    })).failed).toBe(1);
    expect(durableRuns.getRun('error-id')).toMatchObject({
      state: 'RETRY_AT', trackerState: 'lookup_error', trackerCheckedAt: now,
    });
    expect((await reconcileTrackerTerminalRuns({
      durableRuns, source: source(lookup), now: now + 14 * 60_000,
    })).lookedUp).toBe(0);
    expect((await reconcileTrackerTerminalRuns({
      durableRuns, source: source(lookup), now: now + 15 * 60_000,
    })).lookedUp).toBe(1);
    expect(lookup).toHaveBeenCalledTimes(2);
    durableRuns.close();
  });
});

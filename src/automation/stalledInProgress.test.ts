import { describe, expect, it } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { planStalledInProgress } from './stalledInProgress.js';

const HOUR = 60 * 60_000;

function task(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: 'uuid-1',
    issueId: 'uuid-1',
    issueIdentifier: 'AGT-1',
    source: 'linear',
    title: 'stale work',
    priority: 2,
    createdAt: 0,
    trackerUpdatedAt: 4 * HOUR,
    linearState: 'In Progress',
    ...overrides,
  };
}

function plan(overrides: Partial<Parameters<typeof planStalledInProgress>[1]> = {}, tasks = [task()]) {
  return planStalledInProgress(tasks, {
    now: 10 * HOUR,
    staleAfterMs: 6 * HOUR,
    isSchedulerOwned: () => false,
    hasLiveLease: () => false,
    hasPublishedArtifact: () => false,
    ...overrides,
  });
}

describe('planStalledInProgress', () => {
  it('moves an unowned issue at the idle threshold back to Backlog', () => {
    expect(plan()).toEqual([{ task: expect.objectContaining({ issueIdentifier: 'AGT-1' }), targetState: 'Backlog' }]);
  });

  it('leaves recent, queued, and live-leased work alone', () => {
    expect(plan({}, [task({ trackerUpdatedAt: 4 * HOUR + 1 })])).toEqual([]);
    expect(plan({ isSchedulerOwned: () => true })).toEqual([]);
    expect(plan({ hasLiveLease: () => true })).toEqual([]);
  });

  it('moves a published artifact to In Review instead of discarding it', () => {
    expect(plan({ hasPublishedArtifact: () => true })[0]?.targetState).toBe('In Review');
  });

  it('fails closed for missing, invalid, or future tracker timestamps', () => {
    expect(plan({}, [task({ trackerUpdatedAt: undefined })])).toEqual([]);
    expect(plan({}, [task({ trackerUpdatedAt: Number.NaN })])).toEqual([]);
    expect(plan({}, [task({ trackerUpdatedAt: 11 * HOUR })])).toEqual([]);
  });

  it('ignores non-In Progress tasks and invalid policy values', () => {
    expect(plan({}, [task({ linearState: 'Todo' })])).toEqual([]);
    expect(plan({ staleAfterMs: 0 })).toEqual([]);
  });
});

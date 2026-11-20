// AGT-4817 B: a dependent released locally must survive the next fetch-sync while the tracker
// still reports Backlog, and the release marker must clear once the tracker catches up.
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildTaskStateSyncComment,
  getTaskState,
  releaseDependentTasks,
  resetTaskStateStoreForTests,
  syncTaskStatesFromIssues,
  updateTaskLinearState,
  upsertTaskState,
} from './store.js';

describe('released dependents and fetch-sync (AGT-4817)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-task-release-'));
    process.env.OPENSWARM_TASK_STATE_FILE = join(stateDir, 'state.json');
    resetTaskStateStoreForTests();
  });

  afterEach(() => {
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    resetTaskStateStoreForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function blockedChild(): void {
    upsertTaskState('DEP', { linearState: 'In Progress', execution: { status: 'in_progress', retryCount: 0 } });
    upsertTaskState('CHILD', {
      dependencyIssueIds: ['DEP'],
      linearState: 'Backlog',
      execution: { status: 'blocked', blockedReason: 'Waiting on dependencies: DEP', retryCount: 0 },
    });
    upsertTaskState('DEP', { linearState: 'Done', execution: { status: 'done', retryCount: 0 } });
  }

  it('fetch-sync does not revert a released child back to Backlog', () => {
    blockedChild();
    // The blocked snapshot posted at decomposition is the newest sync comment the tracker has.
    const blockedSnapshot = buildTaskStateSyncComment(getTaskState('CHILD')!, 'Task blocked by decomposition dependency');
    expect(releaseDependentTasks('DEP').map((s) => s.issueId)).toEqual(['CHILD']);
    expect(getTaskState('CHILD')?.releasedAt).toEqual(expect.any(String));

    // The tracker has not caught up: it still says Backlog, and the only sync comment is the blocked one.
    syncTaskStatesFromIssues([{ issueId: 'CHILD', linearState: 'Backlog', comments: [{ body: blockedSnapshot, createdAt: '2026-11-21T00:00:00.000Z', source: 'openswarm' }] }]);
    updateTaskLinearState('CHILD', 'Backlog');
    expect(getTaskState('CHILD')).toMatchObject({ linearState: 'Todo', execution: { status: 'todo' } });

    // Once the tracker reports Todo the marker clears, and a later Backlog (a person parking it) is honoured.
    syncTaskStatesFromIssues([{ issueId: 'CHILD', linearState: 'Todo' }]);
    expect(getTaskState('CHILD')?.releasedAt).toBeNull();
    expect(syncTaskStatesFromIssues([{ issueId: 'CHILD', linearState: 'Todo' }])).toBe(0);
    syncTaskStatesFromIssues([{ issueId: 'CHILD', linearState: 'Backlog' }]);
    expect(getTaskState('CHILD')?.linearState).toBe('Backlog');
  });
});

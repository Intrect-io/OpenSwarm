// Created: 2026-11-21
// Purpose: AGT-4784 GAP 3: a released dependent goes to Todo only when it is a daemon child still in Backlog.
// Dependencies: vitest, taskState/store (real, temp state file), dependentRelease
// Test Status: passing
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTaskState, resetTaskStateStoreForTests, upsertTaskState } from '../taskState/store.js';
import type { TrackerIssueLookup } from './taskSource.js';
import { releaseDependentsInTracker, type DependentReleaseSource } from './dependentRelease.js';

type Lookup = (issueId: string) => Promise<TrackerIssueLookup>;

function makeSource(lookup?: Lookup): DependentReleaseSource & { updateState: ReturnType<typeof vi.fn> } {
  return {
    addComment: vi.fn(async () => {}),
    updateState: vi.fn(async () => true),
    ...(lookup ? { lookupIssueState: vi.fn(lookup) } : {}),
  };
}

function waiter(issueId: string, parentIssueId?: string, listedByParent = true): void {
  if (parentIssueId && listedByParent) {
    const siblings = getTaskState(parentIssueId)?.childIssueIds ?? [];
    upsertTaskState(parentIssueId, { childIssueIds: [...siblings, issueId] });
  }
  upsertTaskState(issueId, {
    ...(parentIssueId ? { parentIssueId } : {}),
    dependencyIssueIds: ['DEP'],
    linearState: 'Backlog',
    execution: { status: 'blocked', blockedReason: 'Waiting on dependencies: DEP', retryCount: 0 },
  });
}

describe('releaseDependentsInTracker live-state guard (AGT-4784)', () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-dependent-release-'));
    process.env.OPENSWARM_TASK_STATE_FILE = join(stateDir, 'state.json');
    resetTaskStateStoreForTests();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    upsertTaskState('DEP', { linearState: 'In Progress', execution: { status: 'in_progress', retryCount: 0 } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    resetTaskStateStoreForTests();
    rmSync(stateDir, { recursive: true, force: true });
  });

  function completeDep(): void {
    upsertTaskState('DEP', { linearState: 'Done', execution: { status: 'done', retryCount: 0 } });
  }

  it('releases only a daemon-decomposed child whose live state is Backlog', async () => {
    waiter('IN-BACKLOG', 'GOAL');
    waiter('BACKLOG-TYPE', 'GOAL');
    waiter('IN-TODO', 'GOAL');
    waiter('IN-PROGRESS', 'GOAL');
    completeDep();
    const live: Record<string, { state: string; stateType?: string }> = {
      'IN-BACKLOG': { state: 'backlog ' },
      'BACKLOG-TYPE': { state: 'Icebox', stateType: 'backlog' },
      'IN-TODO': { state: 'Todo', stateType: 'unstarted' },
      'IN-PROGRESS': { state: 'In Progress', stateType: 'started' },
    };
    const source = makeSource(async (id) => ({ ok: true, issue: live[id] ?? null }));

    const released = await releaseDependentsInTracker(source, 'DEP');

    expect(released.map((s) => s.issueId).sort()).toEqual(['BACKLOG-TYPE', 'IN-BACKLOG', 'IN-PROGRESS', 'IN-TODO']);
    expect(source.updateState.mock.calls.map((c) => c[0]).sort()).toEqual(['BACKLOG-TYPE', 'IN-BACKLOG']);
    expect(source.updateState).not.toHaveBeenCalledWith('IN-TODO', 'Todo');
    expect(source.updateState).not.toHaveBeenCalledWith('IN-PROGRESS', 'Todo');
    expect(source.addComment).toHaveBeenCalledTimes(2);
    // The local release is unchanged for every dependent.
    expect(getTaskState('IN-TODO')).toMatchObject({ linearState: 'Todo', execution: { status: 'todo' } });
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('IN-PROGRESS to Todo: its live state is In Progress'));
  });

  it('does not move a released dependent that has no decomposition parent or whose lookup fails', async () => {
    waiter('HUMAN');
    waiter('LOOKUP-FAILS', 'GOAL');
    waiter('LOOKUP-THROWS', 'GOAL');
    waiter('NOT-FOUND', 'GOAL');
    waiter('UNLISTED', 'GOAL', false);
    completeDep();
    const lookup = vi.fn<Lookup>(async (id) => {
      if (id === 'LOOKUP-THROWS') throw new Error('linear down');
      if (id === 'LOOKUP-FAILS') return { ok: false, error: 'rate limited' };
      if (id === 'NOT-FOUND') return { ok: true, issue: null };
      return { ok: true, issue: { state: 'Backlog', stateType: 'backlog' } };
    });
    const source = makeSource(lookup);

    const released = await releaseDependentsInTracker(source, 'DEP');

    expect(released).toHaveLength(5);
    expect(source.updateState).not.toHaveBeenCalled();
    expect(source.addComment).not.toHaveBeenCalled();
    // A person's issue is never even looked up: it is skipped before the tracker is asked.
    expect(lookup).not.toHaveBeenCalledWith('HUMAN');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('HUMAN to Todo: it has no decomposition parent'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('LOOKUP-FAILS to Todo: the live state lookup failed: rate limited'));
    // A person's issue the daemon decomposed has a parentIssueId, but its parent never listed it as a child.
    expect(lookup).not.toHaveBeenCalledWith('UNLISTED');
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('UNLISTED to Todo: its parent does not list it as a daemon-created child'));
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to release dependent task LOOKUP-THROWS'), expect.any(Error));

    // A source without lookupIssueState fails closed too.
    upsertTaskState('DEP2', { linearState: 'In Progress', execution: { status: 'in_progress', retryCount: 0 } });
    upsertTaskState('GOAL', { childIssueIds: [...(getTaskState('GOAL')?.childIssueIds ?? []), 'NO-LOOKUP'] });
    upsertTaskState('NO-LOOKUP', {
      parentIssueId: 'GOAL',
      dependencyIssueIds: ['DEP2'],
      linearState: 'Backlog',
      execution: { status: 'blocked', blockedReason: 'Waiting on dependencies: DEP2', retryCount: 0 },
    });
    upsertTaskState('DEP2', { linearState: 'Done', execution: { status: 'done', retryCount: 0 } });
    const noLookup = makeSource();
    expect((await releaseDependentsInTracker(noLookup, 'DEP2')).map((s) => s.issueId)).toEqual(['NO-LOOKUP']);
    expect(noLookup.updateState).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('NO-LOOKUP to Todo: the task source cannot look up its live state'));
  });
});

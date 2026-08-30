import { beforeEach, describe, expect, it, vi } from 'vitest';
import { homedir } from 'node:os';
import type { AutonomousRunner } from './autonomousRunner.js';

const linear = vi.hoisted(() => {
  const getIssue = vi.fn(async (_id: string): Promise<Record<string, unknown> | null> => null);
  return {
  isLinearInitialized: vi.fn(() => true),
  getIssue,
  // Dispatch resolves issues through `lookupIssue` so a failed lookup is
  // reported as such rather than as a missing issue. These cases all exercise
  // successful lookups, so delegate and keep asserting on `getIssue`; the
  // failure branch has its own suite.
  lookupIssue: vi.fn(async (id: string) => ({ ok: true as const, issue: await getIssue(id) })),
  updateIssueState: vi.fn(async () => true),
  fetchIssuesForStates: vi.fn(async () => ({ nodes: [] as Array<Record<string, unknown>> })),
  getClient: vi.fn(() => ({}) as never),
  };
});
vi.mock('../linear/linear.js', () => linear);

const { loadRepoMetadataImpl } = vi.hoisted(() => ({
  loadRepoMetadataImpl: vi.fn(async (): Promise<Record<string, unknown> | null> => ({
    schemaVersion: 1,
    linear: { projectId: 'proj-1' },
  })),
}));
vi.mock('../support/repoMetadata.js', () => ({ loadRepoMetadata: loadRepoMetadataImpl }));

const { broadcastEventImpl } = vi.hoisted(() => ({ broadcastEventImpl: vi.fn() }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: broadcastEventImpl }));

// enrichTaskFromState reads ~/.openswarm/task-state.json via the REAL statSync
// while this file mocks node:fs existsSync to true — on a CI runner with no
// such file that contradiction throws ENOENT. The enrichment is irrelevant to
// dispatch logic, so mock it to identity.
vi.mock('../taskState/store.js', () => ({ enrichTaskFromState: (task: unknown) => task }));

const { existsSyncImpl } = vi.hoisted(() => ({ existsSyncImpl: vi.fn(() => true) }));
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return { ...actual, existsSync: existsSyncImpl };
});

import { dispatchWork, listWorkIssues, isDispatchableState, WorkDispatchError } from './workRunner.js';

const todoIssue = (id: string, identifier: string, state = 'Todo') => ({
  id,
  identifier,
  title: `Issue ${identifier}`,
  description: 'body',
  state,
  priority: 2,
  labels: [],
  comments: [],
  project: { id: 'proj-1', name: 'OpenSwarm' },
});

function mkRunner(over: Partial<Record<'enqueueIssues' | 'getAllowedProjects', unknown>> = {}): AutonomousRunner {
  return {
    enqueueIssues: vi.fn(async (tasks: Array<{ id: string }>) => ({
      queued: tasks.map((t) => t.id),
      rejected: [],
    })),
    getAllowedProjects: vi.fn(() => ['/tmp/repo']),
    ...over,
  } as unknown as AutonomousRunner;
}

beforeEach(() => {
  vi.clearAllMocks();
  linear.isLinearInitialized.mockReturnValue(true);
  linear.updateIssueState.mockResolvedValue(true);
  existsSyncImpl.mockReturnValue(true);
  loadRepoMetadataImpl.mockResolvedValue({ schemaVersion: 1, linear: { projectId: 'proj-1' } });
});

describe('isDispatchableState', () => {
  it('accepts Todo/Backlog/In Progress case-insensitively, rejects the rest', () => {
    expect(isDispatchableState('Todo')).toBe(true);
    expect(isDispatchableState('backlog')).toBe(true);
    expect(isDispatchableState('In Progress')).toBe(true);
    expect(isDispatchableState('Done')).toBe(false);
    expect(isDispatchableState('In Review')).toBe(false);
    expect(isDispatchableState(undefined)).toBe(false);
  });
});

describe('listWorkIssues', () => {
  it('maps the repo to its Linear project and returns priority-sorted issues', async () => {
    linear.fetchIssuesForStates.mockResolvedValue({
      nodes: [
        { id: 'b', identifier: 'INT-2', title: 'Low', priority: 4, state: { name: 'Todo' }, labels: { nodes: [] } },
        { id: 'a', identifier: 'INT-1', title: 'Urgent', priority: 1, state: { name: 'Backlog' }, labels: { nodes: [{ name: 'bug' }] } },
      ],
    });
    const result = await listWorkIssues('/tmp/repo');
    expect(linear.fetchIssuesForStates).toHaveBeenCalledWith(
      expect.anything(),
      ['Todo', 'Backlog', 'In Progress'],
      { project: { id: { eq: 'proj-1' } } },
    );
    expect(result.issues.map((i) => i.identifier)).toEqual(['INT-1', 'INT-2']);
    expect(result.issues[0].labels).toEqual(['bug']);
  });

  it('fails with 404 when the repo has no Linear mapping', async () => {
    loadRepoMetadataImpl.mockResolvedValue(null);
    await expect(listWorkIssues('/tmp/repo')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('fails with 503 when Linear is not configured', async () => {
    linear.isLinearInitialized.mockReturnValue(false);
    await expect(listWorkIssues('/tmp/repo')).rejects.toMatchObject({ statusCode: 503 });
  });

  // allowedProjects stores tilde spellings, so the picker sends them verbatim.
  // Neither fs nor resolve() expands '~' — reading './~/dev/repo' reported every
  // such repo as unmapped (INT-3395).
  it('expands a tilde path before reading the repo mapping', async () => {
    linear.fetchIssuesForStates.mockResolvedValue({ nodes: [] });
    await listWorkIssues('~/dev/repo');
    const readPath = loadRepoMetadataImpl.mock.calls[0][0] as unknown as string;
    expect(readPath).toBe(`${homedir()}/dev/repo`);
    expect(readPath).not.toContain('~');
  });

  // A backslash is an ordinary filename character on POSIX, so the expansion
  // must not borrow normalizeProjectPath's comparison-only separator rewrite
  // (review finding) — that would read a different directory entirely.
  // A backslash is an ordinary filename character on POSIX, so the canonical
  // form (which rewrites '\'→'/' as a comparison key) cannot represent such a
  // path. Refuse it rather than read a different directory (review finding).
  it.runIf(process.platform !== 'win32')('refuses a POSIX path containing a backslash', async () => {
    await expect(listWorkIssues('/srv/repos/foo\\bar')).rejects.toMatchObject({ statusCode: 400 });
    expect(loadRepoMetadataImpl).not.toHaveBeenCalled();
  });

  // Windows spells home-relative paths with the native separator; dropping
  // that expansion would strand every '~\dev\repo' entry there.
  it('expands the native Windows home separator when running on win32', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      linear.fetchIssuesForStates.mockResolvedValue({ nodes: [] });
      await listWorkIssues('~\\dev\\repo');
      const readPath = loadRepoMetadataImpl.mock.calls[0][0] as unknown as string;
      expect(readPath.toLowerCase()).toContain(homedir().toLowerCase().replace(/\\/g, '/'));
      expect(readPath).not.toContain('~');
    } finally {
      Object.defineProperty(process, 'platform', original);
    }
  });
});

describe('dispatchWork', () => {
  it('claims each issue as In Progress, queues it, and emits work:queued', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    const runner = mkRunner();
    const result = await dispatchWork(runner, { issueIds: ['1', '2'], projectPath: '/tmp/repo' });

    expect(result.queued).toBe(2);
    expect(result.skipped).toBe(0);
    expect(linear.updateIssueState).toHaveBeenCalledTimes(2);
    expect(linear.updateIssueState).toHaveBeenCalledWith('1', 'In Progress');
    expect(runner.enqueueIssues).toHaveBeenCalledWith(
      expect.arrayContaining([expect.objectContaining({ issueId: '1' }), expect.objectContaining({ issueId: '2' })]),
      expect.stringContaining('/tmp/repo'),
    );
    expect(broadcastEventImpl).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'work:queued' }),
    );
  });

  it('accepts a tilde projectPath against an absolute allow-list entry (INT-3395)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    const expanded = `${homedir()}/dev/repo`;
    const runner = mkRunner({ getAllowedProjects: vi.fn(() => [expanded]) });

    const result = await dispatchWork(runner, { issueIds: ['1'], projectPath: '~/dev/repo' });

    expect(result.queued).toBe(1);
    // Everything downstream (metadata read, worktree creation) needs the real path.
    expect(loadRepoMetadataImpl).toHaveBeenCalledWith(expanded);
    expect(runner.enqueueIssues).toHaveBeenLastCalledWith(expect.anything(), expanded);
  });

  it('does not re-claim an issue already In Progress (resume path)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`, 'In Progress'));
    const runner = mkRunner();
    await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(linear.updateIssueState).not.toHaveBeenCalled();
    expect(runner.enqueueIssues).toHaveBeenCalled();
  });

  it('skips unknown issues and non-dispatchable states without failing the batch', async () => {
    linear.getIssue.mockImplementation(async (id: string) => {
      if (id === 'missing') return null;
      if (id === 'done') return todoIssue(id, 'INT-DONE', 'Done');
      return todoIssue(id, `INT-${id}`);
    });
    const runner = mkRunner();
    const result = await dispatchWork(runner, { issueIds: ['missing', 'done', 'ok'], projectPath: '/tmp/repo' });
    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(2);
    const reasons = result.items.filter((i) => i.status === 'skipped').map((i) => i.reason);
    expect(reasons).toEqual(['not found', 'state is Done']);
  });

  it('scheduler-duplicate rejection keeps the In Progress claim — another dispatch owns the issue (race fix)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    const runner = mkRunner({
      enqueueIssues: vi.fn(async () => ({ queued: [], rejected: [{ id: '1', reason: 'duplicate' as const }] })),
    });
    const result = await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(result.queued).toBe(0);
    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'already queued or running' });
    // CRITICAL: no rollback to Todo — the concurrently-running dispatch that
    // owns this issue on the scheduler relies on the In Progress claim.
    expect(linear.updateIssueState).not.toHaveBeenCalledWith('1', 'Todo');
  });

  it('stopping rejection rolls back the claim this dispatch made (review finding)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    const runner = mkRunner({
      enqueueIssues: vi.fn(async () => ({ queued: [], rejected: [{ id: '1', reason: 'stopping' as const }] })),
    });
    const result = await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(result.items[0]).toMatchObject({ status: 'skipped', reason: 'runner shutting down' });
    expect(linear.updateIssueState).toHaveBeenCalledWith('1', 'Todo');
    expect(runner.enqueueIssues).toHaveBeenCalledWith(
      [expect.objectContaining({ explicitDispatch: true, explicitDispatchPriorState: 'Todo' })],
      '/tmp/repo',
    );
  });

  it('rolls a Backlog-claimed issue back to Backlog, not Todo (review finding)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`, 'Backlog'));
    const runner = mkRunner({
      enqueueIssues: vi.fn(async () => ({ queued: [], rejected: [{ id: '1', reason: 'stopping' as const }] })),
    });
    await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(linear.updateIssueState).toHaveBeenCalledWith('1', 'Backlog');
    expect(linear.updateIssueState).not.toHaveBeenCalledWith('1', 'Todo');
  });

  it('does NOT roll back an issue that was already In Progress before dispatch (resume path)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`, 'In Progress'));
    const runner = mkRunner({
      enqueueIssues: vi.fn(async () => ({ queued: [], rejected: [{ id: '1', reason: 'stopping' as const }] })),
    });
    await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(linear.updateIssueState).not.toHaveBeenCalled();
    expect(runner.enqueueIssues).toHaveBeenCalledWith(
      [expect.objectContaining({ explicitDispatch: true, explicitDispatchPriorState: undefined })],
      '/tmp/repo',
    );
  });

  it('surfaces a failed rollback in the item reason instead of hiding it', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    linear.updateIssueState.mockImplementation(async (_id: string, state: string) => state === 'In Progress');
    const runner = mkRunner({
      enqueueIssues: vi.fn(async () => ({ queued: [], rejected: [{ id: '1', reason: 'stopping' as const }] })),
    });
    const result = await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(result.items[0].reason).toMatch(/manual state reset needed/);
  });

  it('rejects an empty issue list and a missing project path upfront', async () => {
    const runner = mkRunner();
    await expect(dispatchWork(runner, { issueIds: [], projectPath: '/tmp/repo' })).rejects.toBeInstanceOf(WorkDispatchError);
    existsSyncImpl.mockReturnValue(false);
    await expect(dispatchWork(runner, { issueIds: ['1'], projectPath: '/nope' })).rejects.toMatchObject({ statusCode: 400 });
    expect(runner.enqueueIssues).not.toHaveBeenCalled();
  });

  it("refuses a project path outside the runner's allowed projects (review finding)", async () => {
    const runner = mkRunner({ getAllowedProjects: vi.fn(() => ['/somewhere/else']) });
    await expect(
      dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' }),
    ).rejects.toMatchObject({ statusCode: 403 });
    expect(linear.getIssue).not.toHaveBeenCalled();
    expect(runner.enqueueIssues).not.toHaveBeenCalled();
  });

  it("skips an issue that belongs to a different Linear project than the repo's mapping (review finding)", async () => {
    linear.getIssue.mockImplementation(async (id: string) => ({
      ...todoIssue(id, `INT-${id}`),
      project: { id: 'other-project', name: 'Other' },
    }));
    const runner = mkRunner();
    const result = await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(result.queued).toBe(0);
    expect(result.items[0]).toMatchObject({ status: 'skipped' });
    expect(result.items[0].reason).toMatch(/different Linear project/);
    expect(linear.updateIssueState).not.toHaveBeenCalled();
  });

  it('fails upfront when the repo has no Linear mapping instead of dispatching unscoped issues', async () => {
    loadRepoMetadataImpl.mockResolvedValue(null);
    const runner = mkRunner();
    await expect(
      dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('fails on an unexecutable runner config BEFORE claiming anything on Linear (review finding)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    const runner = mkRunner({
      enqueueIssues: vi.fn(async () => {
        throw new Error('Explicit dispatch requires autonomous.pairMode and maxConcurrentTasks in config');
      }),
    });
    await expect(
      dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' }),
    ).rejects.toMatchObject({ statusCode: 409 });
    // The whole point: no issue was moved to In Progress for work that can never run.
    expect(linear.updateIssueState).not.toHaveBeenCalled();
  });

  it('skips an issue whose Linear claim fails instead of queueing unprotected work (review finding)', async () => {
    linear.getIssue.mockImplementation(async (id: string) => todoIssue(id, `INT-${id}`));
    linear.updateIssueState.mockResolvedValue(false);
    const runner = mkRunner();
    const result = await dispatchWork(runner, { issueIds: ['1'], projectPath: '/tmp/repo' });
    expect(result.queued).toBe(0);
    expect(result.items[0]).toMatchObject({ status: 'skipped' });
    expect(result.items[0].reason).toMatch(/failed to claim/);
    // Nothing reached the scheduler beyond the empty config-probe batch.
    const realBatches = vi.mocked(runner.enqueueIssues).mock.calls.filter(([tasks]) => tasks.length > 0);
    expect(realBatches).toHaveLength(0);
  });

  it('reports duplicate issue ids in one request as skipped duplicates, not phantom queues (review finding)', async () => {
    linear.getIssue.mockImplementation(async (_id: string) => todoIssue('same-uuid', 'INT-1'));
    const runner = mkRunner();
    const result = await dispatchWork(runner, { issueIds: ['INT-1', 'same-uuid'], projectPath: '/tmp/repo' });
    expect(result.queued).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.items[1]).toMatchObject({ status: 'skipped', reason: 'duplicate in request' });
    // Only one task was actually handed to the scheduler.
    const realBatches = vi.mocked(runner.enqueueIssues).mock.calls.filter(([tasks]) => tasks.length > 0);
    expect(realBatches).toHaveLength(1);
    expect(realBatches[0][0]).toHaveLength(1);
  });
});

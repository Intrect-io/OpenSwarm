// AGT-4816: the disk gate and preserved worktrees could deadlock — space was low, the
// heartbeat returned before anything that frees space, and RETRY_AT rows kept their
// trees protected from the age sweep. These tests pin the way out.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import { reclaimWorktreesUnderDiskPressure, type DiskPressureReclaimDeps } from './diskPressureReclaim.js';

// Runner harness, as in autonomousRunner.hostHealth.test.ts.
vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({
  recordTaskOutcome: vi.fn(async () => {}),
  promoteStagedMemories: vi.fn(async () => 0),
}));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));
// A passthrough spy: the real reclamation still runs; the wiring test reads how the heartbeat called it.
vi.mock('./diskPressureReclaim.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./diskPressureReclaim.js')>();
  return { ...actual, reclaimWorktreesUnderDiskPressure: vi.fn(actual.reclaimWorktreesUnderDiskPressure) };
});

type Run = ReturnType<DiskPressureReclaimDeps['durableRuns']['listRuns']>[number];

const PROJECT = '/repo';

function run(id: string, overrides: Partial<Run> = {}): Run {
  return {
    issueId: id, identifier: id, projectPath: PROJECT, state: 'RETRY_AT', stateVersion: 1,
    worktreePath: `${PROJECT}/worktree/${id}`, branchName: `swarm/${id}`, updatedAt: 1_000,
    ...overrides,
  };
}

function heads(...branches: string[]): string {
  return branches.map((b, i) => `${String(i).padStart(40, '0')}\trefs/heads/${b}`).join('\n') + '\n';
}

/** Fake ledger + filesystem: `removeWorktree` deletes from `onDisk`, `spaceRecovered` follows `freeAfter`. */
function harness(runs: Run[], options: { remote?: string | Error; recoverAfter?: number; running?: string[] } = {}) {
  const onDisk = new Set(runs.map((r) => r.worktreePath!).filter(Boolean));
  const removed: string[] = [];
  const reconcile = vi.fn<DiskPressureReclaimDeps['durableRuns']['reconcileMissingWorktree']>(() => true);
  const lines: string[] = [];
  const remote = options.remote ?? heads(...runs.map((r) => r.branchName!).filter(Boolean));
  const lsRemoteHeads = vi.fn(async () => { if (remote instanceof Error) throw remote; return remote; });
  const deps: DiskPressureReclaimDeps = {
    durableRuns: {
      isPrimary: true,
      listRuns: (states) => runs.filter((r) => !states || states.includes(r.state)),
      reconcileMissingWorktree: reconcile,
    },
    projects: [PROJECT],
    spaceRecovered: () => options.recoverAfter !== undefined && removed.length >= options.recoverAfter,
    runningWorktreePaths: options.running,
    lsRemoteHeads,
    removeWorktree: async (path) => { removed.push(path); onDisk.delete(path); },
    worktreeExists: (path) => onDisk.has(path),
    log: (line) => lines.push(line),
  };
  return { deps, removed, reconcile, lines, lsRemoteHeads };
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

describe('disk-pressure worktree reclamation (AGT-4816)', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('reclaims a pushed RETRY_AT worktree when free space is under minFreeDiskGiB', async () => {
    // Real git end to end: default origin lookup and the real removal helper.
    root = mkdtempSync(join(tmpdir(), 'openswarm-disk-reclaim-'));
    const origin = join(root, 'origin.git');
    const repo = join(root, 'repo');
    execFileSync('git', ['init', '-q', '--bare', origin]);
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    git(repo, 'config', 'user.email', 't@example.com');
    git(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'README.md'), 'x\n');
    git(repo, 'add', '.');
    git(repo, 'commit', '-q', '-m', 'init');
    git(repo, 'remote', 'add', 'origin', origin);
    git(repo, 'push', '-q', 'origin', 'main');
    mkdirSync(join(repo, 'worktree'));
    const tree = join(repo, 'worktree', 'AGT-1');
    git(repo, 'worktree', 'add', '-q', '-b', 'swarm/AGT-1', tree);
    writeFileSync(join(tree, 'work.txt'), 'partial\n');
    git(tree, 'add', '.');
    git(tree, 'commit', '-q', '-m', 'wip');
    git(tree, 'push', '-q', 'origin', 'swarm/AGT-1');
    writeFileSync(join(tree, 'uncommitted.txt'), 'later\n'); // must survive as a WIP commit on the local branch

    const row = run('AGT-1', { projectPath: repo, worktreePath: tree, lastErrorMessage: 'infra_error: ENOSPC' });
    const reconcile = vi.fn<DiskPressureReclaimDeps['durableRuns']['reconcileMissingWorktree']>(() => true);
    const lines: string[] = [];
    const result = await reclaimWorktreesUnderDiskPressure({
      durableRuns: { isPrimary: true, listRuns: (states) => [row].filter((r) => !states || states.includes(r.state)), reconcileMissingWorktree: reconcile },
      projects: [repo],
      spaceRecovered: () => false, // still under the floor
      log: (line) => lines.push(line),
    });

    expect(result.reclaimed).toEqual([tree]);
    expect(existsSync(tree)).toBe(false);
    expect(git(repo, 'worktree', 'list')).not.toContain(tree);
    // The row is kept; only its pointer is cleared, with the earlier failure still readable.
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ issueId: 'AGT-1', state: 'RETRY_AT', worktreePath: tree }), 'clear',
      expect.stringMatching(/reclaimed under disk pressure.*previous error: infra_error: ENOSPC/), false,
    );
    expect(git(repo, 'ls-tree', '--name-only', 'swarm/AGT-1')).toContain('uncommitted.txt');
    expect(lines.filter((l) => l.startsWith('Reclaimed'))).toHaveLength(1);
  }, 60_000);

  it('never reclaims a worktree whose branch is not on origin', async () => {
    const h = harness([run('AGT-1'), run('AGT-2')], { remote: heads('swarm/AGT-2', 'swarm/AGT-1-other', 'main') });
    const result = await reclaimWorktreesUnderDiskPressure(h.deps);
    expect(h.removed).toEqual(['/repo/worktree/AGT-2']);
    expect(result.reclaimed).toEqual(['/repo/worktree/AGT-2']);
    expect(h.reconcile).toHaveBeenCalledTimes(1);
  });

  it('treats a failed origin lookup as unpushed', async () => {
    const h = harness([run('AGT-1')], { remote: new Error('fatal: Could not resolve host: github.com') });
    const result = await reclaimWorktreesUnderDiskPressure(h.deps);
    expect(h.removed).toEqual([]);
    expect(result.reclaimed).toEqual([]);
    expect(h.lines.some((l) => l.includes('Could not resolve host'))).toBe(true);
  });

  it('reclaims oldest first and stops once space recovers', async () => {
    const h = harness([
      run('NEW', { updatedAt: 3_000 }), run('OLD', { updatedAt: 1_000 }), run('MID', { updatedAt: 2_000 }),
    ], { recoverAfter: 2 });
    const result = await reclaimWorktreesUnderDiskPressure(h.deps);
    expect(h.removed).toEqual(['/repo/worktree/OLD', '/repo/worktree/MID']);
    expect(result.recovered).toBe(true);
    expect(h.lsRemoteHeads).toHaveBeenCalledTimes(1); // one origin lookup per project per pass
  });

  it('stops at the per-heartbeat cap', async () => {
    const runs = Array.from({ length: 8 }, (_, i) => run(`AGT-${i}`, { updatedAt: i }));
    const h = harness(runs);
    const result = await reclaimWorktreesUnderDiskPressure({ ...h.deps, maxPerHeartbeat: 3 });
    expect(result.reclaimed).toHaveLength(3);
  });

  it('skips live leases, running tasks and rows waiting on a person', async () => {
    const h = harness([
      run('LEASED', { ownerInstanceId: 'host:1', leaseToken: 'tok' }),
      run('EXEC', { state: 'EXECUTING', ownerInstanceId: 'host:1', leaseToken: 'tok' }),
      // A RETRY_AT row whose tree an active lease row also points at.
      run('SHARED', { worktreePath: '/repo/worktree/EXEC' }),
      run('RUNNING'),
      run('HUMAN', { state: 'NEEDS_HUMAN' }),
      run('ENV', { state: 'NEEDS_ENV' }),
      run('CANCELLED', { state: 'CANCELLED' }),
    ], { running: ['/repo/worktree/RUNNING'] });
    await reclaimWorktreesUnderDiskPressure(h.deps);
    expect(h.removed).toEqual(['/repo/worktree/CANCELLED']);
  });

  it('refuses paths outside the project worktree root and unconfigured projects', async () => {
    const h = harness([
      run('ESCAPE', { worktreePath: '/repo/worktree/../src' }),
      run('NESTED', { worktreePath: '/repo/worktree/a/b' }),
      run('ELSEWHERE', { projectPath: '/other', worktreePath: '/other/worktree/ELSEWHERE' }),
    ]);
    await reclaimWorktreesUnderDiskPressure(h.deps);
    expect(h.removed).toEqual([]);
  });

  it('keeps the pointer when removal left the tree in place (live owner under the lock)', async () => {
    const h = harness([run('AGT-1')]);
    const result = await reclaimWorktreesUnderDiskPressure({ ...h.deps, removeWorktree: async () => {} });
    expect(result.reclaimed).toEqual([]);
    expect(h.reconcile).not.toHaveBeenCalled();
  });

  it('does nothing when the ledger is not primary', async () => {
    const h = harness([run('AGT-1')]);
    await reclaimWorktreesUnderDiskPressure({ ...h.deps, durableRuns: { ...h.deps.durableRuns, isPrimary: false } });
    expect(h.removed).toEqual([]);
  });
});

type InternalRunner = {
  heartbeatParallel: ReturnType<typeof vi.fn>;
  refreshKnowledgeGraphs(): void;
  durableRuns: DurableRunCoordinator;
};

describe('heartbeat disk gate wiring (AGT-4816)', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST: work window allowed
    root = mkdtempSync(join(tmpdir(), 'openswarm-runner-diskreclaim-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function setup(minFreeDiskGiB: number) {
    const [{ AutonomousRunner }, execution, reclaim] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
      import('./diskPressureReclaim.js'),
    ]);
    const fetchTasks = vi.fn(async () => [] as TaskItem[]);
    const source = {
      kind: 'linear', fetchTasks,
      lookupIssueState: vi.fn(async () => ({ ok: true as const, issue: { state: 'Todo', stateType: 'unstarted' } })),
      updateState: vi.fn(async () => true), addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource;
    execution.setTaskSource(source);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: [root], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true, pairMode: true, maxConcurrentTasks: 4,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'diskreclaim.db'), minFreeDiskGiB,
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.heartbeatParallel = vi.fn(async () => {});
    const reclaimSpy = vi.mocked(reclaim.reclaimWorktreesUnderDiskPressure);
    reclaimSpy.mockClear(); // the unit tests above call through the same spy
    return { runner, internal, fetchTasks, reclaimSpy };
  }

  it('the disk gate runs reclamation instead of only returning', async () => {
    const { runner, internal, fetchTasks, reclaimSpy } = await setup(1e9); // no real volume is this free: always low
    await runner.heartbeat();
    internal.durableRuns.close();
    expect(fetchTasks).not.toHaveBeenCalled(); // the gate still holds dispatch
    expect(reclaimSpy).toHaveBeenCalledTimes(1);
    const deps = reclaimSpy.mock.calls[0][0];
    expect(deps.durableRuns).toBe(internal.durableRuns);
    expect(deps.projects).toContain(root);
    expect(deps.spaceRecovered()).toBe(false); // re-measures against the configured floor
    await expect(reclaimSpy.mock.results[0].value).resolves.toEqual({ reclaimed: [], recovered: false });
  }, 60_000);

  it('does not reclaim when the disk is fine', async () => {
    const { runner, internal, fetchTasks, reclaimSpy } = await setup(0);
    await runner.heartbeat();
    internal.durableRuns.close();
    expect(fetchTasks).toHaveBeenCalled();
    expect(reclaimSpy).not.toHaveBeenCalled();
  }, 60_000);
});

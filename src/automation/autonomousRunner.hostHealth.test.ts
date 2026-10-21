import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';

// AGT-4785: on 2026-10-20 the host ran out of disk and the daemon kept claiming work that could
// only fail with ENOSPC. HostDiskGate is unit-tested in support/hostHealth.test.ts; this proves
// the heartbeat consults it with the configured floor, before anything is fetched.

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({
  recordTaskOutcome: vi.fn(async () => {}),
  promoteStagedMemories: vi.fn(async () => 0),
}));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));

type InternalRunner = {
  heartbeatParallel: ReturnType<typeof vi.fn>;
  refreshKnowledgeGraphs(): void;
  durableRuns: DurableRunCoordinator;
};

// No real volume has this much free space, so a floor this high is always "low".
const UNREACHABLE_FLOOR_GIB = 1e9;

describe('heartbeat holds dispatch when the disk is nearly full (AGT-4785)', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST: work window allowed
    root = mkdtempSync(join(tmpdir(), 'openswarm-runner-hosthealth-'));
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

  async function setup(minFreeDiskGiB: number | undefined) {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
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
      automationLedgerMode: 'primary', automationDbPath: join(root, 'hosthealth.db'),
      ...(minFreeDiskGiB === undefined ? {} : { minFreeDiskGiB }),
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    internal.heartbeatParallel = vi.fn(async () => {});
    return { runner, internal, fetchTasks };
  }

  it('fetches and claims nothing while free space is under the configured floor', async () => {
    const { runner, internal, fetchTasks } = await setup(UNREACHABLE_FLOOR_GIB);
    await runner.heartbeat();
    internal.durableRuns.close();
    expect(fetchTasks).not.toHaveBeenCalled();
    expect(internal.heartbeatParallel).not.toHaveBeenCalled();
  }, 60_000);

  it('says so once per change of state, not once per heartbeat', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { runner, internal } = await setup(UNREACHABLE_FLOOR_GIB);
    await runner.heartbeat();
    await runner.heartbeat();
    await runner.heartbeat();
    internal.durableRuns.close();
    const pauses = warn.mock.calls.filter((c) => String(c[0]).includes('Dispatch paused'));
    expect(pauses).toHaveLength(1);
  }, 60_000);

  it('a floor of 0 switches the check off and the heartbeat proceeds to fetch', async () => {
    const { runner, internal, fetchTasks } = await setup(0);
    await runner.heartbeat();
    internal.durableRuns.close();
    expect(fetchTasks).toHaveBeenCalled();
  }, 60_000);
});

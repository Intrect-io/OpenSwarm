import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { ITaskSource } from './taskSource.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';

// AGT-4682: moving stale human-owned cards to Backlog made the daemon queue them at once. The
// rules are unit-tested in agentEligibility.test.ts; this proves the heartbeat applies them.

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));
vi.mock('../memory/repoKnowledge.js', () => ({
  recordTaskOutcome: vi.fn(async () => {}),
  promoteStagedMemories: vi.fn(async () => 0),
}));
vi.mock('../linear/projectUpdater.js', () => ({ updateProjectAfterTask: vi.fn(async () => {}) }));

type InternalRunner = {
  heartbeatParallel: ReturnType<typeof vi.fn>;
  filterAlreadyProcessed: ReturnType<typeof vi.fn>;
  refreshKnowledgeGraphs(): void;
  durableRuns: DurableRunCoordinator;
};

const task = (id: string, over: Partial<TaskItem> = {}): TaskItem => ({
  id, issueId: id, issueIdentifier: id.toUpperCase(), source: 'linear', title: `[B1] ${id}`,
  priority: 2, createdAt: Date.now(), linearState: 'Backlog', labels: [], ...over,
});

describe('heartbeat skips issues that are not the agent\'s work (AGT-4682)', () => {
  let root: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-21T16:00:00Z')); // 01:00 KST: work window allowed
    root = mkdtempSync(join(tmpdir(), 'openswarm-runner-eligibility-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function runHeartbeat(fetched: TaskItem[], skip?: { labels: string[]; titleTags: string[]; epics: boolean }) {
    const [{ AutonomousRunner }, execution] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runnerExecution.js'),
    ]);
    const source = {
      kind: 'linear',
      fetchTasks: vi.fn(async () => fetched),
      lookupIssueState: vi.fn(async () => ({ ok: true as const, issue: { state: 'Backlog', stateType: 'backlog' } })),
      updateState: vi.fn(async () => true), addComment: vi.fn(async () => {}),
      createTask: vi.fn(), createSubIssue: vi.fn(), logPairStart: vi.fn(),
      logPairComplete: vi.fn(), logBlocked: vi.fn(), logStuck: vi.fn(), unstick: vi.fn(),
      logHalt: vi.fn(), markAsDecomposed: vi.fn(),
    } as unknown as ITaskSource;
    execution.setTaskSource(source);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true, pairMode: true, maxConcurrentTasks: 4,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'eligibility.db'),
      ...(skip ? { skip } : {}),
    });
    const internal = runner as unknown as InternalRunner;
    internal.refreshKnowledgeGraphs = vi.fn();
    // Selection and execution are not under test: capture what reaches them.
    internal.heartbeatParallel = vi.fn(async () => {});
    const processed = vi.spyOn(internal as unknown as { filterAlreadyProcessed: (t: TaskItem[]) => TaskItem[] }, 'filterAlreadyProcessed');
    await runner.heartbeat();
    internal.durableRuns.close();
    return { processed, parallel: internal.heartbeatParallel };
  }

  it('hands only the work the swarm may take to idle fill and selection', async () => {
    const { processed, parallel } = await runHeartbeat([
      task('ax-1'),
      task('ax-2', { labels: ['swarm:skip'] }),
      task('ax-3', { hasChildren: true }),
      task('ax-4', { title: '[인수] CGF 2주 무개입 운영 실증' }),
    ]);
    // idle fill lives inside filterAlreadyProcessed, so a skipped issue must not reach it either
    expect(processed.mock.calls[0][0].map((t) => t.id)).toEqual(['ax-1']);
    // Whatever selection receives afterwards can only be a subset of what idle fill saw.
    const selected = parallel.mock.calls.flatMap((call: [TaskItem[]]) => call[0].map((t) => t.id));
    expect(selected.filter((id: string) => id !== 'ax-1')).toEqual([]);
  }, 60_000);

  it('honours configured labels, and stops everything when nothing is left for the swarm', async () => {
    const { processed, parallel } = await runHeartbeat(
      [task('ax-1', { labels: ['외부 검증·결정 대기'] }), task('ax-2', { title: '[UAT] 10/2 배포 readback' })],
      { labels: ['외부 검증·결정 대기'], titleTags: ['UAT'], epics: true },
    );
    expect(processed).not.toHaveBeenCalled();
    expect(parallel).not.toHaveBeenCalled();
  }, 60_000);
});

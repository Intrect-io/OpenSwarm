import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));

// The board is not what this file is about: every case here fixes whether the
// operator has answered and asks what the park signal does around it.
let answered = false;
vi.mock('../coordination/coordinationStore.js', () => ({
  getCoordinationStore: () => ({ allQuestionsAnswered: () => answered }),
}));

type InternalRunner = {
  scheduler: TaskScheduler;
  filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[];
  failedTaskRetryTimes: Map<string, number>;
  resolveProjectPath(task: TaskItem): Promise<string | null>;
  durableRuns: DurableRunCoordinator;
  readmitAnsweredRun(issueId: string): boolean;
  answerArrivedFor(issueId: string): boolean;
};

const TASK: TaskItem = {
  id: 'AGT-1', issueId: 'AGT-1', issueIdentifier: 'AGT-1',
  source: 'linear', title: 'parked on the operator', priority: 2, createdAt: 0,
  linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
};

describe('operator park without an authoritative ledger (AGT-4033)', () => {
  let root: string;

  beforeEach(() => {
    answered = false;
    root = mkdtempSync(join(tmpdir(), 'openswarm-operator-park-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function makeRunner(opts: { completed?: string[] } = {}): Promise<{
    internal: InternalRunner;
    park: (parked: boolean) => void;
    parkReason: () => string | undefined;
  }> {
    // A backoff already running, as an `ask_human` park leaves one.
    writeFileSync(join(root, 'runner-state.json'), JSON.stringify({
      completed: opts.completed ?? [], failed: {}, retryTimes: { 'AGT-1': Date.now() + 3_600_000 }, lastFailures: {},
    }));
    const [{ AutonomousRunner }, store] = await Promise.all([
      import('./autonomousRunner.js'),
      import('../taskState/store.js'),
    ]);
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true,
      automationLedgerMode: 'off',
    });
    const internal = runner as unknown as InternalRunner;
    internal.resolveProjectPath = vi.fn(async () => '/repo');
    return {
      internal,
      park: (parked) => store.upsertTaskState('AGT-1', {
        execution: { blockedReason: parked ? 'waiting_on_operator' : undefined },
      } as Parameters<typeof store.upsertTaskState>[1]),
      parkReason: () => store.getTaskState('AGT-1')?.execution?.blockedReason,
    };
  }

  it('points the answer store at the same database as the runs', async () => {
    // The ledger is handed its path; the coordination trace resolves its own. If
    // they disagree a deployment that relocates its automation database leaves
    // the answers behind, and a parked run can never learn that its question was
    // answered. Only the runner knows both, so it is the runner that has to say.
    const { defaultAutomationDbPath } = await import('./automationDbPath.js');
    const { getRunner } = await import('./autonomousRunner.js');
    const configured = join(root, 'relocated', 'automation.db');
    delete process.env.OPENSWARM_AUTOMATION_DB;

    // Through the factory the process actually uses, which is where the one
    // automation database a process has is declared.
    getRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true,
      automationLedgerMode: 'off', automationDbPath: configured,
    });

    expect(defaultAutomationDbPath()).toBe(configured);
  });

  it('idle-fills a parked backoff so free slots do not sit empty (AGT-4257)', async () => {
    const { internal, park } = await makeRunner();
    park(true);

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
  });

  it('holds the backoff while the pool is saturated (AGT-4257 idle gate)', async () => {
    // Nothing to fill: with no free slot the backoff keeps its meaning.
    const { internal, park, parkReason } = await makeRunner();
    park(true);
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(0);

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([]);
    expect(parkReason()).toBe('waiting_on_operator');
  });

  it('idle-fills a locally completed issue whose card reopened, on the same budget (AGT-4257)', async () => {
    // Ledger-off: `completed` is this runner's own memory that the card was
    // finished. The card still being open is idle fill, not an operator act —
    // so it waits for a free slot like every other lift.
    const { internal } = await makeRunner({ completed: ['AGT-1'] });
    const reopened: TaskItem = { ...TASK, linearState: 'Backlog' };

    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(0);
    expect(internal.filterAlreadyProcessed([reopened])).toEqual([]);

    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    expect(internal.filterAlreadyProcessed([reopened])).toEqual([reopened]);
  });

  it('still cuts the backoff short on an answer when the pool is saturated', async () => {
    // The answer is the one thing the park was waiting for; it must not queue
    // behind idle capacity the way an ordinary backoff does.
    const { internal, park, parkReason } = await makeRunner();
    park(true);
    answered = true;
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(0);

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(parkReason()).toBeUndefined();
  });

  it('cuts the backoff short once the operator answers, and spends the park doing it', async () => {
    const { internal, park, parkReason } = await makeRunner();
    park(true);
    answered = true;

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(parkReason()).toBeUndefined();
  });

  it('does not let an old answer pull a later ordinary failure forward', async () => {
    // The defect this replaced: the park was only cleared on the early path, so a
    // task that simply waited out its backoff kept it. The next ordinary failure
    // then met a park it had long since left and an answer that is still on the
    // board, and was re-admitted on every heartbeat past the backoff that exists
    // to stop exactly that.
    const { internal, park } = await makeRunner();
    park(true);
    answered = true;

    // The backoff runs out on its own before the heartbeat looks at it.
    internal.failedTaskRetryTimes.set('AGT-1', Date.now() - 1_000);
    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);

    // Now it fails for its own reasons and backs off again.
    internal.failedTaskRetryTimes.set('AGT-1', Date.now() + 3_600_000);
    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
  });
});

describe('operator park on the run ledger (AGT-4033)', () => {
  let root: string;

  beforeEach(() => {
    answered = false;
    root = mkdtempSync(join(tmpdir(), 'openswarm-operator-park-ledger-'));
    vi.stubEnv('OPENSWARM_TASK_STATE_FILE', join(root, 'task-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_TASK_STATE_FILE', join(root, 'runner-state.json'));
    vi.stubEnv('OPENSWARM_RUNNER_REJECTION_STATE_FILE', join(root, 'rejections.json'));
    vi.stubEnv('OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE', join(root, 'history.json'));
    vi.stubEnv('OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE', join(root, 'decomposition.json'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  /**
   * Park the run on `errorCode` and hand back a runner reading the same ledger.
   *
   * The park is written through a second connection because that is the only way
   * to reach a claim from here — and it is the same file the runner reads, which
   * is the point: what the heartbeat sees is the row, not anything beside it.
   */
  async function parkedRunner(errorCode: string, retryAt = Date.now() + 3_600_000): Promise<InternalRunner> {
    const dbPath = join(root, 'runs.db');
    const [{ AutonomousRunner }, { RunLedger }] = await Promise.all([
      import('./autonomousRunner.js'),
      import('./runLedger.js'),
    ]);
    const ledger = new RunLedger(dbPath);
    ledger.registerRun({
      issueId: 'AGT-1', source: 'linear', identifier: 'AGT-1',
      title: 'parked on the operator', projectPath: '/repo',
    }, 1_000);
    const claim = ledger.claimRun('AGT-1', {
      ownerInstanceId: 'daemon', leaseMs: 60_000, maxActiveForProject: 1, now: 2_000,
    });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'RETRY_AT', {
      retryAt, errorCode,
    }, 2_100)).toBe(true);
    ledger.close();

    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: ['/repo'], heartbeatSchedule: '0 * * * *',
      autoExecute: true, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: dbPath,
    });
    const internal = runner as unknown as InternalRunner;
    internal.resolveProjectPath = vi.fn(async () => '/repo');
    return internal;
  }

  it('brings a run parked on the operator forward once the answer lands', async () => {
    const internal = await parkedRunner('waiting_on_operator');
    answered = true;

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('refuses to promote on an observation another daemon has already invalidated', async () => {
    // The park is read on one statement and acted on by the next. A second daemon
    // can end the parked attempt in that gap, and the failure that replaces it has
    // to keep its own backoff — so the promotion re-checks rather than trusting
    // what the heartbeat saw.
    const internal = await parkedRunner('waiting_on_operator');
    const { RunLedger } = await import('./runLedger.js');
    internal.answerArrivedFor = () => true; // the now-stale observation

    const other = new RunLedger(join(root, 'runs.db'));
    expect(other.readmitParkedRun('AGT-1', 'waiting_on_operator')).toBe(true);
    const claim = other.claimRun('AGT-1', {
      ownerInstanceId: 'other-daemon', leaseMs: 60_000, maxActiveForProject: 1,
    });
    expect(claim).not.toBeNull();
    expect(other.transition(claim!, 'RETRY_AT', {
      retryAt: Date.now() + 3_600_000, errorCode: 'failed',
    })).toBe(true);
    other.close();

    expect(internal.readmitAnsweredRun('AGT-1')).toBe(false);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('RETRY_AT');
    internal.durableRuns.close();
  });

  it('idle-fills an ordinary RETRY_AT failure so free slots chew the backoff (AGT-4257)', async () => {
    const internal = await parkedRunner('failed');
    answered = true;

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('leaves an ordinary RETRY_AT failure on its backoff while the pool is saturated (AGT-4257 idle gate)', async () => {
    const internal = await parkedRunner('failed');
    answered = true;
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(0);

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('RETRY_AT');
    internal.durableRuns.close();
  });

  it('passes an elapsed RETRY_AT without spending the idle budget (AGT-4257)', async () => {
    // The backoff ran out on its own and claimRun takes it as it stands.
    // Lifting it would burn the one free slot's budget on a row that needed
    // nothing, and leave a genuinely parked row behind it still parked.
    const internal = await parkedRunner('failed', Date.now() - 1_000);
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('RETRY_AT');
    internal.durableRuns.close();
  });

  it('brings an answered operator park forward even when the pool is saturated', async () => {
    const internal = await parkedRunner('waiting_on_operator');
    answered = true;
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(0);

    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });
});

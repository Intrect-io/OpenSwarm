// ============================================
// OpenSwarm - stop re-dispatching on a repeated, unanswered ask_human (AGT-4042)
// ============================================
//
// A re-dispatch is a fresh worker session, and it is not free: burning a
// worker+reviewer cycle every backoff tick on a question the operator has
// already been paged for once, and has not answered, is exactly the wasted
// spin these tests pin closed.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskScheduler } from '../orchestration/taskScheduler.js';

vi.mock('../core/providerOverride.js', () => ({ writeProviderOverride: vi.fn() }));
vi.mock('../agents/stageModelResolver.js', () => ({ resolveAdapterDefaultModel: vi.fn(async () => 'model') }));

type InternalRunner = {
  scheduler: TaskScheduler;
  durableRuns: DurableRunCoordinator;
  failedTaskRetryTimes: Map<string, number>;
  filterAlreadyProcessed(tasks: TaskItem[]): TaskItem[];
  resolveProjectPath(task: TaskItem): Promise<string | null>;
};

const REPO = '/repo';
const TASK: TaskItem = {
  id: 'AGT-1', issueId: 'AGT-1', issueIdentifier: 'AGT-1',
  source: 'linear', title: 'blocked on Google credentials', priority: 2, createdAt: 0,
  linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
};

function pipelineResult(): PipelineResult {
  return {
    success: false, sessionId: 'session-1', stages: [], finalStatus: 'waiting_on_operator',
    totalDuration: 0, iterations: 1,
  };
}

describe('stop re-dispatching a repeatedly-unanswered ask_human (AGT-4042)', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-operator-question-park-'));
    dbPath = join(root, 'runs.db');
    process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
    process.env.OPENSWARM_TASK_STATE_FILE = join(root, 'task-state.json');
    process.env.OPENSWARM_RUNNER_TASK_STATE_FILE = join(root, 'runner-state.json');
    process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE = join(root, 'rejections.json');
    process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE = join(root, 'history.json');
    process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE = join(root, 'decomposition.json');
    // lastAnsweredAt reads the durable coordination trace, a separate SQLite
    // file keyed off this env var (not `dbPath` above, which is only the
    // ledger's own file) and not reset by resetCoordinationStoreForTests.
    // Every test in this file reuses the same repository/taskId, and without
    // a fresh path per test the trace accumulates across the whole file's
    // run — a later test's answer could otherwise read as an earlier test's.
    process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  });

  afterEach(async () => {
    delete process.env.OPENSWARM_COORDINATION_FILE;
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_TASK_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE;
    delete process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE;
    delete process.env.OPENSWARM_AUTOMATION_DB;
    const store = await import('../coordination/coordinationStore.js');
    store.resetCoordinationStoreForTests();
    const trace = await import('../coordination/coordinationTrace.js');
    trace.resetTraceDbForTests();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function makeRunner(): Promise<InternalRunner> {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: [REPO], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: dbPath,
    });
    const internal = runner as unknown as InternalRunner;
    internal.resolveProjectPath = vi.fn(async () => REPO);
    internal.durableRuns.observeTask(TASK, REPO);
    return internal;
  }

  /**
   * Drive `count` claim→RETRY_AT("waiting_on_operator")→markReady cycles
   * through a second connection to the same database, leaving the run parked
   * in RETRY_AT at the end — the state right after the scheduler's own
   * `waiting_on_operator` handler would have recorded that many outcomes and
   * is about to fire for the latest one.
   *
   * Attempt-based on purpose, not board-based: this is what the stop decision
   * now actually counts on (AGT-4042's second fix), and it stays correct even
   * when every attempt asks with byte-identical wording — a scenario a board
   * correlation-ID count could never distinguish from "asked once".
   */
  async function seedConsecutiveUnansweredAttempts(count: number): Promise<void> {
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    for (let i = 0; i < count; i += 1) {
      const claim = ledger.claimRun('AGT-1', { ownerInstanceId: `seed-${i}`, leaseMs: 60_000, maxActiveForProject: 1 });
      expect(claim).not.toBeNull();
      expect(ledger.transition(claim!, 'RETRY_AT', {
        retryAt: Date.now() + 3_600_000, errorCode: 'waiting_on_operator',
      })).toBe(true);
      if (i < count - 1) expect(ledger.markReady('AGT-1')).toBe(true);
    }
    ledger.close();
  }

  it('parks the run once it has asked twice with no answer, instead of retrying on a clock', async () => {
    const internal = await makeRunner();
    await seedConsecutiveUnansweredAttempts(2);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });

    const run = internal.durableRuns.getRun('AGT-1');
    expect(run?.lastErrorMessage).toMatch(/^\[operator-question\]/);
    expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(false); // no fixed-backoff ladder entry either
    internal.durableRuns.close();
  });

  it('parks even when every attempt asked with byte-identical wording', async () => {
    // The paging gate collapses an exact repeat to one correlation ID on the
    // board, so a count keyed on distinct wordings would never reach 2 no
    // matter how many times this was actually re-dispatched. The stop
    // decision counts ledger attempts instead, which is unaffected by that.
    const internal = await makeRunner();
    await seedConsecutiveUnansweredAttempts(2);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });
    internal.durableRuns.close();
  });

  it('still uses the ordinary backoff on the first unanswered ask', async () => {
    const internal = await makeRunner();
    await seedConsecutiveUnansweredAttempts(1);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(true);
    });

    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('does not resume a parked, unanswered ask just because the Linear card never left Todo', async () => {
    // The bug this pins closed: an ask_human park never touches the Linear
    // card, so the pre-existing Todo/In Progress/In Review resume condition
    // was almost always already true for an actively-worked task — reviving
    // the park on the very next heartbeat regardless of an answer, before it
    // did anything at all.
    const internal = await makeRunner();
    const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
    await getCoordinationStore().publish({
      repository: REPO, taskId: 'AGT-1', actor: 'worker-x', recipient: 'human',
      kind: 'human-question', status: 'running', correlationId: 'hq-still-open', summary: 'ask',
    });
    internal.durableRuns.markNeedsHuman(
      'AGT-1',
      '[operator-question] asked 2 times with no answer — stopped retrying automatically',
    );
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');

    const selected = internal.filterAlreadyProcessed([TASK]); // TASK.linearState === 'Todo'

    expect(selected).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('resumes the moment the outstanding question is answered, with the card still in Todo', async () => {
    const internal = await makeRunner();
    const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
    const store = getCoordinationStore();
    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'worker-x', recipient: 'human',
      kind: 'human-question', status: 'running', correlationId: 'hq-only', summary: 'ask',
    });
    internal.durableRuns.markNeedsHuman(
      'AGT-1',
      '[operator-question] asked 2 times with no answer — stopped retrying automatically',
    );
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');

    // The card stays in Todo throughout — resuming does not depend on the
    // operator touching Linear at all, only on the answer landing.
    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'operator', recipient: 'worker-x',
      kind: 'human-answer', status: 'completed', correlationId: 'hq-only', summary: 'answered',
    });

    const selected = internal.filterAlreadyProcessed([TASK]); // still linearState: 'Todo'

    expect(selected).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('does not park a new, distinct question on its first ask just because an earlier one was answered', async () => {
    // The gate finding this closes: consecutiveAttemptsWithErrorCode used to
    // walk the ledger unbounded, so a resumed run's first ask on a brand-new
    // blocker shared its error code with the already-answered attempt before
    // it and got folded into the same streak — parking on a first ask instead
    // of getting the ordinary backoff. Bounding the walk by the task's most
    // recent answer timestamp is what this test pins.
    const internal = await makeRunner();
    const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
    const store = getCoordinationStore();

    const t0 = Date.now();
    await seedConsecutiveUnansweredAttempts(1); // question A's only ask

    const answeredAt = t0 + 1_000;
    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'worker-x', recipient: 'human',
      kind: 'human-question', status: 'running', correlationId: 'hq-a', summary: 'question A',
      timestamp: answeredAt - 500,
    });
    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'operator', recipient: 'worker-x',
      kind: 'human-answer', status: 'completed', correlationId: 'hq-a', summary: 'answered A',
      timestamp: answeredAt,
    });

    // The resume path: re-admit, re-dispatch, and this attempt asks a
    // different question (B) — its first ask, well after the answer landed.
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const resumedAt = answeredAt + 1_000;
    expect(ledger.markReady('AGT-1', resumedAt)).toBe(true);
    const claim = ledger.claimRun('AGT-1', {
      ownerInstanceId: 'seed-resumed', leaseMs: 60_000, maxActiveForProject: 1, now: resumedAt,
    });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'RETRY_AT', {
      retryAt: resumedAt + 3_600_000, errorCode: 'waiting_on_operator',
    }, resumedAt)).toBe(true);
    ledger.close();

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(true);
    });

    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('does not resume a NEEDS_HUMAN park from an unrelated reason just because no question was ever asked', async () => {
    // A rejection-limit or PR-closed-without-merge park shares NEEDS_HUMAN but
    // has nothing to do with ask_human — openQuestionCount is legitimately 0
    // for it, and that must not read as "answered". Modeled with the ticket out
    // of Todo/In Progress/In Review, the way those other parks also leave it
    // (a STUCK label move) — so only the marker-scoped check is on trial here,
    // not the pre-existing Linear-state resume this file already had.
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    const parkedElsewhere: TaskItem = { ...TASK, linearState: 'Backlog' };

    const selected = internal.filterAlreadyProcessed([parkedElsewhere]);

    expect(selected).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('still resumes an unrelated NEEDS_HUMAN park once Linear reopens it', async () => {
    // The other half of the mutual-exclusivity fix: making the ask_human path
    // ignore linearState must not cost the OTHER park types their own
    // resume condition.
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    const reopened: TaskItem = { ...TASK, linearState: 'In Progress' };

    const selected = internal.filterAlreadyProcessed([reopened]);

    expect(selected).toEqual([reopened]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });
});

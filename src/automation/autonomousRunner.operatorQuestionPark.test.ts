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

function pipelineResult(correlationIds: string[] = [], executionOutcomeUnknown = false): PipelineResult {
  return {
    success: false, sessionId: 'session-1', stages: [], finalStatus: 'waiting_on_operator',
    totalDuration: 0, iterations: 1,
    workerResult: {
      success: false,
      summary: 'asked the operator',
      filesChanged: [], commands: [], output: '', blockedOnOperator: true,
      executionOutcomeUnknown,
      operatorQuestionCorrelationIds: correlationIds,
    },
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
    // The exact resume gate joins run and coordination truth in one durable
    // SQLite database. Production config does the same; tests must not split it.
    process.env.OPENSWARM_AUTOMATION_DB = dbPath;
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
      autoExecute: true, dryRun: true,
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

  it('parks the first unanswered attempt immediately instead of retrying on a clock', async () => {
    const internal = await makeRunner();
    await seedConsecutiveUnansweredAttempts(1);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult(['hq-first']) });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });

    const run = internal.durableRuns.getRun('AGT-1');
    expect(run?.lastErrorCode).toBe('operator_question');
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

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult(['hq-identical']) });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });
    internal.durableRuns.close();
  });

  it('fails closed to ordinary backoff when an old adapter omits the exact correlation', async () => {
    const internal = await makeRunner();
    await seedConsecutiveUnansweredAttempts(1);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(true);
    });

    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('never turns a quarantined sandbox outcome into RETRY_AT or heartbeat backoff', async () => {
    const internal = await makeRunner();
    const quarantined = pipelineResult([], true);
    await internal.durableRuns.execute(TASK, REPO, async () => quarantined);
    expect(internal.durableRuns.getRun('AGT-1')).toMatchObject({
      state: 'NEEDS_HUMAN',
      lastErrorCode: 'execution_outcome_unknown',
      retryAt: undefined,
    });

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: quarantined });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });

    expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(false);
    // AGT-4257: idle_fill resumes even a sandbox-quarantine park so slots work.
    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('idle-fills a parked unanswered ask so the enabled pool does not sit empty (AGT-4257)', async () => {
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
    await seedConsecutiveUnansweredAttempts(1);
    expect(internal.durableRuns.markNeedsHumanForQuestions(
      'AGT-1', ['hq-still-open'], 'waiting for exact answer',
    )).toBe(true);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');

    const selected = internal.filterAlreadyProcessed([TASK]); // TASK.linearState === 'Todo'

    expect(selected).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
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
    await seedConsecutiveUnansweredAttempts(1);
    expect(internal.durableRuns.markNeedsHumanForQuestions(
      'AGT-1', ['hq-only'], 'waiting for exact answer',
    )).toBe(true);
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

  it('parks a new question independently and does not let an earlier answer resume it', async () => {
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

    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'worker-x', recipient: 'human',
      kind: 'human-question', status: 'waiting', correlationId: 'hq-b', summary: 'question B',
      timestamp: resumedAt + 100,
    });
    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult(['hq-b']) });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });

    // AGT-4257: idle_fill resumes question-B without waiting for its answer.
    expect(internal.filterAlreadyProcessed([TASK])).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');

    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'operator', recipient: 'worker-x',
      kind: 'human-answer', status: 'completed', correlationId: 'hq-b', summary: 'answered B',
      detail: 'Use monthly_cutoff; do not create due_date.', timestamp: resumedAt + 200,
    });
    internal.durableRuns.close();
  });

  it('idle-fills an unrelated NEEDS_HUMAN park so Backlog still occupies a slot (AGT-4257)', async () => {
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

    expect(selected).toEqual([parkedElsewhere]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('idle-fills an In Progress NEEDS_HUMAN park together with its sibling (AGT-4257)', async () => {
    // 'In Progress' is where THIS run put the card when it claimed the task,
    // and parking does not move it back. Treating that level as "the operator
    // reopened it" re-admitted the park on the very next heartbeat: it
    // re-claimed, re-executed, re-published and re-parked, once per cycle,
    // holding a slot the whole time. Observed in production at attempt 20.
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    const stillParked: TaskItem = { ...TASK, linearState: 'In Progress' };
    // The slot the park was holding has to go somewhere: an unrelated task in
    // the same cycle must still be admitted.
    const sibling: TaskItem = {
      ...TASK, id: 'AGT-2', issueId: 'AGT-2', issueIdentifier: 'AGT-2', title: 'unrelated work',
    };

    const selected = internal.filterAlreadyProcessed([stillParked, sibling]);

    expect(selected).toEqual([stillParked, sibling]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('keeps a NEEDS_HUMAN park parked while the pool is saturated (AGT-4257 idle gate)', async () => {
    // idle_fill exists to stop free slots sitting empty. With no free slot the
    // park has nothing to fill, and lifting it anyway is the AGT-4155 loop:
    // re-claim, re-execute, re-park, once per heartbeat, at attempt 20.
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(0);
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');

    expect(internal.filterAlreadyProcessed([{ ...TASK, linearState: 'In Progress' }])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('un-parks at most one row per free slot per heartbeat (AGT-4257 idle budget)', async () => {
    // One free slot must not turn every parked row READY at once — the rows
    // beyond the slot count would only compete with fresh work on the next
    // heartbeat, having lost their park for nothing.
    const internal = await makeRunner();
    const second: TaskItem = {
      ...TASK, id: 'AGT-2', issueId: 'AGT-2', issueIdentifier: 'AGT-2', title: 'also parked',
    };
    internal.durableRuns.observeTask(second, REPO);
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    internal.durableRuns.markNeedsHuman('AGT-2', 'Reviewer rejected 4 attempts: still failing lint');

    const selected = internal.filterAlreadyProcessed([TASK, second]);

    expect(selected).toEqual([TASK]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    expect(internal.durableRuns.getRun('AGT-2')?.state).toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('charges a NEEDS_HUMAN row with the stuck label once and admits it (AGT-4257 idle budget)', async () => {
    // The NEEDS_HUMAN lift and the stuck-label recovery are idle fill for the
    // same row. Charged twice, one task eats two slots' budget; at budget 1 the
    // second charge rejects a row whose park the first lift already erased.
    const internal = await makeRunner();
    vi.spyOn(internal.scheduler, 'getAvailableSlots').mockReturnValue(1);
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    const stuck: TaskItem = { ...TASK, linearState: 'Backlog', labels: ['swarm:stuck'] };

    expect(internal.filterAlreadyProcessed([stuck])).toEqual([stuck]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('skips an In Progress card this daemon never claimed (INT-1979 guard kept under AGT-4257)', async () => {
    // A bare Linear 'In Progress' with only the row observeTask wrote is
    // someone else's work — a human, or another daemon. Admitting it
    // re-decomposes work already in progress (INT-1980: duplicate sub-issues
    // and a redundant PR). This daemon's own parks reach here as READY after
    // idle fill and still pass.
    const internal = await makeRunner();
    const external: TaskItem = { ...TASK, linearState: 'In Progress' };

    expect(internal.filterAlreadyProcessed([external])).toEqual([]);
    internal.durableRuns.close();
  });

  it('idle-fills a finished run whose card is In Progress, but never one In Review (AGT-4257)', async () => {
    const internal = await makeRunner();
    const { RunLedger } = await import('./runLedger.js');
    const ledger = new RunLedger(dbPath);
    const claim = ledger.claimRun('AGT-1', { ownerInstanceId: 'seed', leaseMs: 60_000, maxActiveForProject: 1 });
    expect(claim).not.toBeNull();
    expect(ledger.transition(claim!, 'EXECUTING', {})).toBe(true);
    expect(ledger.transition(claim!, 'SYNC_PENDING', {})).toBe(true);
    expect(ledger.finalizeSyncedRun('AGT-1')).toBe(true);
    ledger.close();
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('DONE');

    // In Review: its PR is waiting on the merge gate. Re-executing makes a
    // duplicate PR, so a finished run there is not work to fill a slot with.
    expect(internal.filterAlreadyProcessed([{ ...TASK, linearState: 'In Review' }])).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('DONE');

    // In Progress with a free slot is idle fill of this daemon's own run.
    const inProgress: TaskItem = { ...TASK, linearState: 'In Progress' };
    expect(internal.filterAlreadyProcessed([inProgress])).toEqual([inProgress]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('READY');
    internal.durableRuns.close();
  });

  it('resumes an unrelated NEEDS_HUMAN park when the operator dispatches it again (AGT-4155)', async () => {
    // The park stays terminal for the autonomous loop but must remain
    // recoverable by an operator ACT — the issue board or `work` CLI saying
    // "run this", which the pipeline's own writes cannot forge.
    const internal = await makeRunner();
    internal.durableRuns.markNeedsHuman('AGT-1', 'Reviewer rejected 4 attempts: still failing lint');
    const dispatched: TaskItem = { ...TASK, linearState: 'In Progress', explicitDispatch: true };

    const selected = internal.filterAlreadyProcessed([dispatched]);

    expect(selected).toEqual([dispatched]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });
});

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

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openswarm-operator-question-park-'));
    process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
    process.env.OPENSWARM_TASK_STATE_FILE = join(root, 'task-state.json');
    process.env.OPENSWARM_RUNNER_TASK_STATE_FILE = join(root, 'runner-state.json');
    process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE = join(root, 'rejections.json');
    process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE = join(root, 'history.json');
    process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE = join(root, 'decomposition.json');
  });

  afterEach(async () => {
    delete process.env.OPENSWARM_COORDINATION_FILE;
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_TASK_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_REJECTION_STATE_FILE;
    delete process.env.OPENSWARM_RUNNER_PIPELINE_HISTORY_FILE;
    delete process.env.OPENSWARM_RUNNER_DECOMPOSITION_STATE_FILE;
    const store = await import('../coordination/coordinationStore.js');
    store.resetCoordinationStoreForTests();
    rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  async function makeRunner(): Promise<InternalRunner> {
    const { AutonomousRunner } = await import('./autonomousRunner.js');
    const runner = new AutonomousRunner({
      linearTeamId: 'team', allowedProjects: [REPO], heartbeatSchedule: '0 * * * *',
      autoExecute: true, maxConsecutiveTasks: 1, cooldownSeconds: 0, dryRun: true,
      automationLedgerMode: 'primary', automationDbPath: join(root, 'runs.db'),
    });
    const internal = runner as unknown as InternalRunner;
    internal.resolveProjectPath = vi.fn(async () => REPO);
    internal.durableRuns.observeTask(TASK, REPO);
    return internal;
  }

  async function seedOpenQuestions(count: number): Promise<void> {
    const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
    const store = getCoordinationStore();
    for (let i = 0; i < count; i += 1) {
      await store.publish({
        repository: REPO, taskId: 'AGT-1', actor: 'worker-x', recipient: 'human',
        kind: 'human-question', status: 'running', correlationId: `hq-${i}`,
        summary: `ask #${i}`,
      });
    }
  }

  it('parks the run once it has asked twice with no answer, instead of retrying on a clock', async () => {
    const internal = await makeRunner();
    await seedOpenQuestions(2);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    });

    const run = internal.durableRuns.getRun('AGT-1');
    expect(run?.lastErrorMessage).toMatch(/^\[operator-question\]/);
    expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(false); // no fixed-backoff ladder entry either
    internal.durableRuns.close();
  });

  it('still uses the ordinary backoff on the first unanswered ask', async () => {
    const internal = await makeRunner();
    await seedOpenQuestions(1);

    internal.scheduler.emit('waiting_on_operator', { task: TASK, result: pipelineResult() });
    await vi.waitFor(() => {
      expect(internal.failedTaskRetryTimes.has('AGT-1')).toBe(true);
    });

    expect(internal.durableRuns.getRun('AGT-1')?.state).not.toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });

  it('resumes the moment the outstanding question is answered, with no Linear touch', async () => {
    // linearState is deliberately outside the pre-existing Todo/In Progress/In
    // Review resume set — this test isolates the answered-question path, not
    // the resume this file already had.
    const parkedButAnswered: TaskItem = { ...TASK, linearState: 'Backlog' };
    const internal = await makeRunner();
    const { getCoordinationStore } = await import('../coordination/coordinationStore.js');
    const store = getCoordinationStore();
    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'worker-x', recipient: 'human',
      kind: 'human-question', status: 'running', correlationId: 'hq-only', summary: 'ask',
    });
    internal.durableRuns.markNeedsHuman('AGT-1', '[operator-question] asked 2 times with no answer — stopped retrying automatically');
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');

    // The card stays in Todo throughout — resuming does not depend on the
    // operator touching Linear at all, only on the answer landing.
    await store.publish({
      repository: REPO, taskId: 'AGT-1', actor: 'operator', recipient: 'worker-x',
      kind: 'human-answer', status: 'completed', correlationId: 'hq-only', summary: 'answered',
    });
    // The path cache is populated at dispatch time in production; the filter
    // reads it rather than resolving async, so seed it the same way a prior
    // run would have.
    (internal as unknown as { projectPathCache: Map<string, string> }).projectPathCache.set('Repo', REPO);

    const selected = internal.filterAlreadyProcessed([parkedButAnswered]);

    expect(selected).toEqual([parkedButAnswered]);
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
    (internal as unknown as { projectPathCache: Map<string, string> }).projectPathCache.set('Repo', REPO);
    const parkedElsewhere: TaskItem = { ...TASK, linearState: 'Backlog' };

    const selected = internal.filterAlreadyProcessed([parkedElsewhere]);

    expect(selected).toEqual([]);
    expect(internal.durableRuns.getRun('AGT-1')?.state).toBe('NEEDS_HUMAN');
    internal.durableRuns.close();
  });
});

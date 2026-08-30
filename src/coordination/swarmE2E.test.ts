import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { applyDurablePriorityCouncilRanking } from '../orchestration/priorityCouncilRanking.js';
import { consultationTelemetry } from './consultationTelemetry.js';
import { getCoordinationStore, resetCoordinationStoreForTests } from './coordinationStore.js';
import { executeCoordinationTool, type CoordinationToolContext } from './coordinationTools.js';
import { resetTraceDbForTests } from './coordinationTrace.js';
import { getCoordinationThread } from './coordinationThreads.js';
import { getPriorityCouncil } from './priorityCouncil.js';
import { repositoryCell, resetRepositoryCellCacheForTests } from './repositoryCell.js';

const originalAutomationDb = process.env.OPENSWARM_AUTOMATION_DB;
const originalCoordinationFile = process.env.OPENSWARM_COORDINATION_FILE;
let root = '';
let main = '';
let sibling = '';
let repoKey = '';

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore' });
}

function parse(result: { content: string; isError: boolean }): Record<string, any> {
  expect(result.isError, result.content).toBe(false);
  return JSON.parse(result.content) as Record<string, any>;
}

function context(
  repository: string,
  taskId: string,
  actor: string,
  actorRole: string,
): CoordinationToolContext {
  return {
    repository,
    repoKey,
    taskId,
    taskLabel: taskId.toUpperCase(),
    actor,
    actorName: actor,
    actorRole,
  };
}

function candidate(id: string, createdAt: number): TaskItem {
  return {
    id,
    issueId: id,
    issueIdentifier: id.toUpperCase(),
    source: 'linear',
    title: id,
    priority: 2,
    projectPath: main,
    linearState: 'Todo',
    createdAt,
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'openswarm-swarm-e2e-'));
  main = join(root, 'main');
  sibling = join(root, 'reviewer-worktree');
  mkdirSync(main);
  git(main, 'init');
  git(main, 'config', 'user.email', 'test@example.invalid');
  git(main, 'config', 'user.name', 'OpenSwarm test');
  writeFileSync(join(main, 'README.md'), 'swarm acceptance\n');
  git(main, 'add', 'README.md');
  git(main, 'commit', '-m', 'seed');
  git(main, 'worktree', 'add', '-b', 'reviewer-worktree', sibling);

  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  resetRepositoryCellCacheForTests();
  repoKey = repositoryCell(main).repoKey;
  expect(repositoryCell(sibling).repoKey).toBe(repoKey);
});

afterEach(() => {
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  resetRepositoryCellCacheForTests();
  process.env.OPENSWARM_AUTOMATION_DB = originalAutomationDb;
  process.env.OPENSWARM_COORDINATION_FILE = originalCoordinationFile;
  if (root) rmSync(root, { recursive: true, force: true });
  root = '';
});

describe('agent swarm acceptance', () => {
  it('persists a cross-worktree consultation and applies a cross-role priority decision after restart', async () => {
    const worker = context(main, 'candidate-a', 'worker-a', 'worker');
    const reviewer = context(sibling, 'review-peer', 'reviewer-b', 'reviewer');
    const votingOrchestrator = context(main, 'orchestrator-peer', 'orchestrator-c', 'orchestrator');
    const supervisor = context(main, 'supervisor-task', 'supervisor-d', 'orchestrator');
    const now = Date.now();

    for (const [presence, correlationId, timestamp] of [
      [worker, 'presence-worker', now],
      [reviewer, 'presence-reviewer', now + 1],
      [votingOrchestrator, 'presence-orchestrator', now + 2],
    ] as const) {
      await getCoordinationStore().publish({
        repository: presence.repository,
        repoKey,
        taskId: presence.taskId,
        taskLabel: presence.taskLabel,
        actor: presence.actor,
        actorName: presence.actorName,
        actorRole: presence.actorRole,
        recipient: 'openswarm-daemon',
        recipientRole: 'daemon',
        kind: 'delegation-request',
        status: 'running',
        correlationId,
        summary: `Active ${presence.actorRole} on ${presence.taskId}`,
        timestamp,
      });
    }

    const peers = parse(await executeCoordinationTool('coordination_peers', {
      task_ids: [reviewer.taskId], roles: ['reviewer'], limit: 3,
    }, worker)) as unknown as Array<{ address: string; taskId: string; role: string }>;
    expect(peers).toEqual([
      expect.objectContaining({ address: reviewer.actor, taskId: reviewer.taskId, role: 'reviewer' }),
    ]);

    const thread = parse(await executeCoordinationTool('coordination_thread_create', {
      subject: 'Shared retry ownership and execution order',
      body: 'Confirm file ownership before choosing which tied task runs first.',
      related_task_ids: ['candidate-a', 'candidate-b', reviewer.taskId],
      related_files: ['src/retry.ts', 'src/reviewPolicy.ts'],
      idempotency_key: 'swarm-acceptance-thread',
    }, worker)).thread as { id: string };
    parse(await executeCoordinationTool('coordination_thread_follow', {
      thread_id: thread.id, following: true,
    }, reviewer));

    const request = parse(await executeCoordinationTool('coordination_publish', {
      kind: 'advice-request',
      recipient: reviewer.actor,
      target_task_id: reviewer.taskId,
      thread_id: thread.id,
      summary: 'Will your change overlap src/retry.ts?',
    }, worker)).event as { correlationId: string };
    const reviewerInbox = parse(await executeCoordinationTool('coordination_read', {}, reviewer)) as unknown as Array<Record<string, any>>;
    expect(reviewerInbox).toContainEqual(expect.objectContaining({
      kind: 'advice-request', correlationId: request.correlationId, sourceTaskId: worker.taskId,
    }));

    parse(await executeCoordinationTool('coordination_publish', {
      kind: 'advice-response',
      recipient: worker.actor,
      correlation_id: request.correlationId,
      summary: 'No. Reviewer owns src/reviewPolicy.ts; worker keeps src/retry.ts.',
    }, reviewer));
    parse(await executeCoordinationTool('coordination_thread_reply', {
      thread_id: thread.id,
      body: 'Ownership accepted: candidate A keeps retry.ts and reviewer keeps reviewPolicy.ts.',
      acknowledges_correlation_id: request.correlationId,
      idempotency_key: 'swarm-acceptance-ack',
    }, worker));

    expect(consultationTelemetry(getCoordinationStore().list({ repoKey, limit: 500 }))).toMatchObject({
      requests: 1,
      responses: 1,
      acknowledgedResponses: 1,
      threadLinkedRequests: 1,
      crossTaskRequests: 1,
      crossRoleRequests: 1,
    });

    // Simulate a daemon restart: reopen both the bounded inbox and SQLite-backed
    // thread/council store before making the priority decision.
    resetCoordinationStoreForTests();
    resetTraceDbForTests();
    const workerInbox = parse(await executeCoordinationTool('coordination_read', {}, worker)) as unknown as Array<Record<string, any>>;
    expect(workerInbox).toContainEqual(expect.objectContaining({
      kind: 'advice-response', correlationId: request.correlationId,
    }));
    expect(parse(await executeCoordinationTool('coordination_read', {}, worker))).toEqual([]);
    expect(getCoordinationThread({ repository: repoKey, threadId: thread.id }).messages.items)
      .toContainEqual(expect.objectContaining({ body: expect.stringContaining('Ownership accepted') }));

    const opened = parse(await executeCoordinationTool('coordination_council_open', {
      thread_id: thread.id,
      reason: 'conflict-cohort',
      subject: 'Choose which tied candidate runs first',
      options: [
        {
          id: 'a', label: 'Candidate A first', task_id: 'candidate-a', evidence_ids: ['cached-a'],
          scheduling_facts: { priority: 2, downstream_count: 0, blocked_by: [], linear_state: 'Todo' },
        },
        {
          id: 'b', label: 'Candidate B first', task_id: 'candidate-b', evidence_ids: ['cached-b'],
          scheduling_facts: { priority: 2, downstream_count: 0, blocked_by: [], linear_state: 'Todo' },
        },
      ],
      snapshot_version: 'auto',
      snapshot_captured_at: Date.now(),
      snapshot_evidence: [
        { id: 'cached-a', source: 'tracker-cache', summary: 'Both candidates have equal deterministic priority.' },
        { id: 'cached-b', source: 'tracker-cache', summary: 'Cached conflict metadata cites the thread ownership split for candidate B.' },
      ],
      required_quorum: 2,
      expires_in_ms: 60_000,
      idempotency_key: 'swarm-acceptance-council',
    }, supervisor));
    const councilId = opened.council.id as string;
    const snapshotVersion = opened.council.snapshotVersion as string;
    expect(opened.council.eligibleVoters).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: reviewer.taskId, actorRole: 'reviewer' }),
      expect.objectContaining({ taskId: votingOrchestrator.taskId, actorRole: 'orchestrator' }),
    ]));

    for (const voter of [reviewer, votingOrchestrator]) {
      parse(await executeCoordinationTool('coordination_council_vote', {
        council_id: councilId,
        ranking: ['b', 'a'],
        confidence: 0.9,
        evidence_ids: ['cached-b'],
        snapshot_version: snapshotVersion,
        idempotency_key: `swarm-vote-${voter.taskId}`,
      }, voter));
    }
    const finalized = parse(await executeCoordinationTool('coordination_council_finalize', {
      council_id: councilId,
      expected_version: 3,
      idempotency_key: 'swarm-finalize',
    }, supervisor)).council as Record<string, any>;
    expect(finalized).toMatchObject({
      status: 'finalized', outcome: 'selected', selectedOptionId: 'b', rankedOptionIds: ['b', 'a'],
    });

    const tasks = [candidate('candidate-a', 1), candidate('candidate-b', 2)];
    const applied = applyDurablePriorityCouncilRanking(
      tasks,
      tasks,
      new Map([['candidate-a', 0], ['candidate-b', 0]]),
      new Map([['candidate-a', repoKey], ['candidate-b', repoKey]]),
    );
    expect(applied).toMatchObject({ applied: true, councilId, reason: 'applied' });
    expect(applied.tasks.map((task) => task.id)).toEqual(['candidate-b', 'candidate-a']);

    resetTraceDbForTests();
    expect(getPriorityCouncil({ repository: repoKey, councilId }).council).toMatchObject({
      status: 'finalized', selectedOptionId: 'b', consumptionCount: 1,
    });
    const durableThread = getCoordinationThread({ repository: repoKey, threadId: thread.id });
    expect(durableThread.messages.items.map((message) => message.body)).toEqual(expect.arrayContaining([
      expect.stringContaining('Ownership accepted'),
      expect.stringContaining('Opened from cached snapshot'),
      expect.stringContaining('Equal-weight ballot recorded by reviewer-b'),
      expect.stringContaining('selected. Selected b'),
    ]));
  });
});

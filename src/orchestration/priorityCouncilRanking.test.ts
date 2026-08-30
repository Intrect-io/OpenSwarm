import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const timeWindowMock = vi.hoisted(() => ({
  checkWorkAllowed: vi.fn(() => ({ allowed: true, reason: 'test', currentTime: '00:00' })),
}));
vi.mock('../support/timeWindow.js', () => timeWindowMock);
vi.mock('./workflow.js', () => ({
  loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Test', projectPath: '/repo', steps: [] })),
  listWorkflows: vi.fn(async () => []),
  createCIPipelineTemplate: vi.fn(),
}));
import { createCoordinationThread } from '../coordination/coordinationThreads.js';
import { resetTraceDbForTests } from '../coordination/coordinationTrace.js';
import { repositoryKey, resetRepositoryCellCacheForTests } from '../coordination/repositoryCell.js';
import {
  castPriorityCouncilBallot,
  createPriorityCouncil,
  finalizePriorityCouncil,
  getPriorityCouncil,
  type PriorityCouncil,
  type PriorityCouncilOption,
} from '../coordination/priorityCouncil.js';
import { DecisionEngine, computeDownstreamCounts, type TaskItem } from './decisionEngine.js';
import { applyDurablePriorityCouncilRanking } from './priorityCouncilRanking.js';

const now = 1_000_000;
let root: string;
let councilRepository: string;

beforeEach(() => {
  timeWindowMock.checkWorkAllowed.mockReturnValue({ allowed: true, reason: 'test', currentTime: '00:00' });
  root = mkdtempSync(join(tmpdir(), 'priority-council-ranking-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  resetTraceDbForTests();
  resetRepositoryCellCacheForTests();
  councilRepository = repositoryKey(undefined, root);
});

afterEach(() => {
  resetTraceDbForTests();
  resetRepositoryCellCacheForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  rmSync(root, { recursive: true, force: true });
});

function task(id: string, createdAt: number, overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id, issueId: id, issueIdentifier: id, source: 'linear', title: id,
    priority: 2, createdAt, workflowId: 'wf-1', linearState: 'Todo', projectPath: root,
    ...overrides,
  };
}

function facts(): PriorityCouncilOption['schedulingFacts'] {
  return { priority: 2, downstreamCount: 0, blockedBy: [], linearState: 'Todo' };
}

function openCouncil(): PriorityCouncil {
  const thread = createCoordinationThread({
    repository: councilRepository, subject: 'Contested pair', actor: 'proposer', actorRole: 'orchestrator',
    taskId: 'proposal-task', relatedTaskIds: ['candidate-a', 'candidate-b'],
    idempotencyKey: 'thread', now,
  });
  return createPriorityCouncil({
    repository: councilRepository, threadId: thread.id, reason: 'tie', subject: 'Which task first?',
    options: [
      { id: 'a', label: 'A', taskId: 'candidate-a', evidenceIds: ['a-cache'], schedulingFacts: facts() },
      { id: 'b', label: 'B', taskId: 'candidate-b', evidenceIds: ['b-cache'], schedulingFacts: facts() },
    ],
    snapshotVersion: 'auto', snapshotCapturedAt: now,
    snapshotEvidence: [
      { id: 'a-cache', source: 'tracker-cache', summary: 'A cached scheduling facts.' },
      { id: 'b-cache', source: 'tracker-cache', summary: 'B cached scheduling facts.' },
    ],
    eligiblePeers: [
      { repoKey: councilRepository, address: 'reviewer-c', role: 'reviewer', taskId: 'peer-c', lastSeen: now },
      { repoKey: councilRepository, address: 'orchestrator-d', role: 'orchestrator', taskId: 'peer-d', lastSeen: now },
    ],
    requiredQuorum: 2, expiresInMs: 60_000, actor: 'proposer', actorRole: 'orchestrator',
    taskId: 'proposal-task', idempotencyKey: 'council', now,
  });
}

function finalizeSelected(): PriorityCouncil {
  const council = openCouncil();
  for (const [actor, role, taskId] of [
    ['reviewer-c', 'reviewer', 'peer-c'],
    ['orchestrator-d', 'orchestrator', 'peer-d'],
  ] as const) {
    castPriorityCouncilBallot({
      repository: councilRepository, councilId: council.id, actor, actorRole: role, taskId,
      ranking: ['b', 'a'], confidence: 0.8, evidenceIds: ['b-cache'],
      snapshotVersion: council.snapshotVersion, idempotencyKey: `vote-${actor}`, now: now + 1_000,
    });
  }
  return finalizePriorityCouncil({
    repository: councilRepository, councilId: council.id, expectedVersion: 3,
    actor: 'orchestrator-d', taskId: 'peer-d', idempotencyKey: 'final', now: now + 2_000,
  });
}

describe('DecisionEngine priority-council integration', () => {
  it('automatically CAS-consumes a current decision and only changes cohort order', async () => {
    const council = finalizeSelected();
    const engine = new DecisionEngine({ sameProjectParallel: true });
    const result = await engine.heartbeatMultiple([
      task('outside', 0, { priority: 1 }),
      task('candidate-a', 1),
      task('candidate-b', 2),
    ], 3);

    expect(result.tasks.map(({ task: selected }) => selected.id))
      .toEqual(['outside', 'candidate-b', 'candidate-a']);
    expect(getPriorityCouncil({ repository: councilRepository, councilId: council.id }).council.consumptionCount).toBe(1);
  });

  it('preserves deterministic order when the current scheduling snapshot is stale', async () => {
    finalizeSelected();
    const engine = new DecisionEngine({ sameProjectParallel: true });
    const result = await engine.heartbeatMultiple([
      task('candidate-a', 1),
      task('candidate-b', 2, { linearState: 'In Progress' }),
    ], 2);
    expect(result.tasks.map(({ task: selected }) => selected.id)).toEqual(['candidate-a', 'candidate-b']);
  });

  it('preserves deterministic order when consumption loses its version CAS', () => {
    const council = finalizeSelected();
    const tasks = [task('candidate-a', 1), task('candidate-b', 2)];
    const scopes = new Map(tasks.map((item) => [item.id, councilRepository]));
    const result = applyDurablePriorityCouncilRanking(tasks, tasks, computeDownstreamCounts(tasks), scopes, {
      list: () => [council],
      consume: () => { throw new Error('Priority council version conflict'); },
    });
    expect(result).toMatchObject({ applied: false, reason: 'cas-rejected' });
    expect(result.tasks.map((item) => item.id)).toEqual(['candidate-a', 'candidate-b']);
  });

  it('preserves deterministic order when the council expires without quorum', async () => {
    const council = openCouncil();
    const expired = finalizePriorityCouncil({
      repository: councilRepository, councilId: council.id, expectedVersion: 1,
      actor: 'proposer', taskId: 'proposal-task', idempotencyKey: 'expired', now: now + 60_000,
    });
    expect(expired).toMatchObject({ status: 'expired', outcome: 'no-quorum' });
    const engine = new DecisionEngine({ sameProjectParallel: true });
    const result = await engine.heartbeatMultiple([task('candidate-a', 1), task('candidate-b', 2)], 2);
    expect(result.tasks.map(({ task: selected }) => selected.id)).toEqual(['candidate-a', 'candidate-b']);
  });

  it('does not read or consume a matching task-id council from another repository cell', async () => {
    const council = finalizeSelected();
    const otherRepository = join(root, 'other-repository');
    const engine = new DecisionEngine({ sameProjectParallel: true });
    const result = await engine.heartbeatMultiple([
      task('candidate-a', 1, { projectPath: otherRepository }),
      task('candidate-b', 2, { projectPath: otherRepository }),
    ], 2);
    expect(result.tasks.map(({ task: selected }) => selected.id)).toEqual(['candidate-a', 'candidate-b']);
    expect(getPriorityCouncil({ repository: councilRepository, councilId: council.id }).council.consumptionCount).toBe(0);
  });
});

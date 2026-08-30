import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinationThread } from './coordinationThreads.js';
import { resetTraceDbForTests } from './coordinationTrace.js';
import {
  ADVISORY_RANKING_AUTHORITY,
  applyAdvisoryPriorityRanking,
  castPriorityCouncilBallot,
  consumePriorityCouncilRanking,
  createPriorityCouncil,
  finalizePriorityCouncil,
  getPriorityCouncil,
  submitPriorityCouncilEvidence,
  type CreatePriorityCouncilInput,
} from './priorityCouncil.js';

let root: string;
const now = 1_000_000;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'priority-council-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  resetTraceDbForTests();
});

afterEach(() => {
  resetTraceDbForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  rmSync(root, { recursive: true, force: true });
});

function thread() {
  return createCoordinationThread({
    repository: 'git:repo',
    subject: 'Choose integration order',
    actor: 'proposer',
    actorRole: 'orchestrator',
    taskId: 'proposal-task',
    relatedTaskIds: ['candidate-a', 'candidate-b'],
    idempotencyKey: 'thread',
    now,
  });
}

function input(overrides: Partial<CreatePriorityCouncilInput> = {}): CreatePriorityCouncilInput {
  const topic = thread();
  return {
    repository: 'git:repo',
    threadId: topic.id,
    reason: 'conflict-cohort',
    subject: 'Which candidate integrates first?',
    options: [
      { id: 'a', label: 'Candidate A', taskId: 'candidate-a', evidenceIds: ['tracker-a'] },
      { id: 'b', label: 'Candidate B', taskId: 'candidate-b', evidenceIds: ['tracker-b'] },
    ],
    snapshotVersion: 'tracker-v1',
    snapshotCapturedAt: now - 1_000,
    snapshotEvidence: [
      { id: 'tracker-a', source: 'tracker-cache', summary: 'A priority=2 and has one dependent.' },
      { id: 'tracker-b', source: 'tracker-cache', summary: 'B priority=2 and touches the same file.' },
    ],
    eligiblePeers: [
      { repoKey: 'git:repo', address: 'reviewer-c', role: 'reviewer', taskId: 'peer-c', lastSeen: now - 500 },
      { repoKey: 'git:repo', address: 'orchestrator-d', role: 'orchestrator', taskId: 'peer-d', lastSeen: now - 400 },
      { repoKey: 'git:repo', address: 'review-agent-e', role: 'review-agent', taskId: 'peer-e', lastSeen: now - 300 },
      // Candidate-task participants may submit evidence but are not deciding voters.
      { repoKey: 'git:repo', address: 'worker-a', role: 'worker', taskId: 'candidate-a', lastSeen: now - 200 },
    ],
    requiredQuorum: 2,
    expiresInMs: 60_000,
    actor: 'proposer',
    actorRole: 'orchestrator',
    taskId: 'proposal-task',
    idempotencyKey: 'open-council',
    now,
    ...overrides,
  };
}

function ballot(councilId: string, actor: string, actorRole: string, taskId: string, ranking: string[], over: Record<string, unknown> = {}) {
  return castPriorityCouncilBallot({
    repository: 'git:repo', councilId, actor, actorRole, taskId, ranking,
    confidence: 0.8, evidenceIds: [ranking[0] === 'a' ? 'tracker-a' : 'tracker-b'],
    snapshotVersion: 'tracker-v1', idempotencyKey: `vote-${actor}-${taskId}`, now: now + 1_000,
    ...over,
  });
}

describe('durable priority council', () => {
  it('persists the bounded proposal and active independent eligibility across reopen', () => {
    const council = createPriorityCouncil(input());
    expect(council).toMatchObject({ status: 'open', version: 1, requiredQuorum: 2, ballotCount: 0 });
    expect(council.eligibleVoters.map((voter) => [voter.actor, voter.taskId])).toEqual([
      ['review-agent-e', 'peer-e'], ['orchestrator-d', 'peer-d'], ['reviewer-c', 'peer-c'],
    ]);
    expect(council.snapshotDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(createPriorityCouncil(input({
      threadId: council.threadId,
      eligiblePeers: [],
      now: now + 20 * 60_000,
    })).id).toBe(council.id);

    resetTraceDbForTests();
    const reopened = getPriorityCouncil({ repository: 'git:repo', councilId: council.id });
    expect(reopened.council).toMatchObject({ id: council.id, threadId: council.threadId, snapshotVersion: 'tracker-v1' });
  });

  it('rejects stale proposals and an eligibility pool without cross-role quorum', () => {
    expect(() => createPriorityCouncil(input({
      idempotencyKey: 'stale', snapshotCapturedAt: now - 10 * 60_000 - 1,
    }))).toThrow('snapshot is stale');
    expect(() => createPriorityCouncil(input({
      idempotencyKey: 'one-role',
      eligiblePeers: [
        { repoKey: 'git:repo', address: 'r1', role: 'reviewer', taskId: 'peer-1', lastSeen: now },
        { repoKey: 'git:repo', address: 'r2', role: 'reviewer', taskId: 'peer-2', lastSeen: now },
      ],
    }))).toThrow('distinct roles');
  });

  it('rejects self, stale, and duplicate ballots while making retry idempotent', () => {
    const council = createPriorityCouncil(input());
    expect(() => ballot(council.id, 'worker-a', 'worker', 'candidate-a', ['a', 'b']))
      .toThrow('Self-vote');
    expect(() => ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['a', 'b'], {
      snapshotVersion: 'tracker-v0',
    })).toThrow('stale tracker snapshot');

    const first = ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['a', 'b']);
    expect(ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['a', 'b']).id).toBe(first.id);
    expect(() => ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['a', 'b'], {
      idempotencyKey: 'second-attempt',
    })).toThrow('Duplicate council ballot');
  });

  it('keeps candidate evidence durable without turning it into a ballot', () => {
    const council = createPriorityCouncil(input());
    const evidence = submitPriorityCouncilEvidence({
      repository: 'git:repo', councilId: council.id, optionId: 'a', actor: 'worker-a', actorRole: 'worker',
      taskId: 'candidate-a', summary: 'A already owns the shared migration.', refs: ['thread:message-7'],
      idempotencyKey: 'candidate-a-evidence', now: now + 500,
    });
    expect(submitPriorityCouncilEvidence({
      repository: 'git:repo', councilId: council.id, optionId: 'a', actor: 'worker-a', actorRole: 'worker',
      taskId: 'candidate-a', summary: 'A already owns the shared migration.', refs: ['thread:message-7'],
      idempotencyKey: 'candidate-a-evidence', now: now + 900,
    }).id).toBe(evidence.id);
    const detail = getPriorityCouncil({ repository: 'git:repo', councilId: council.id });
    expect(detail).toMatchObject({ council: { evidenceSubmissionCount: 1, ballotCount: 0 } });
    expect(detail.evidenceSubmissions[0]).toMatchObject({ optionId: 'a', taskId: 'candidate-a' });
  });

  it('records deterministic proposal-order tie-break, tally, evidence, wall time, and CAS', () => {
    const council = createPriorityCouncil(input());
    ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['a', 'b']);
    ballot(council.id, 'orchestrator-d', 'orchestrator', 'peer-d', ['b', 'a']);
    expect(() => finalizePriorityCouncil({
      repository: 'git:repo', councilId: council.id, expectedVersion: 2,
      actor: 'orchestrator-d', taskId: 'peer-d', idempotencyKey: 'final', now: now + 2_000,
    })).toThrow('version conflict');
    const finalized = finalizePriorityCouncil({
      repository: 'git:repo', councilId: council.id, expectedVersion: 3,
      actor: 'orchestrator-d', taskId: 'peer-d', idempotencyKey: 'final', now: now + 2_000,
    });
    expect(finalized).toMatchObject({
      status: 'finalized', outcome: 'tie-break', version: 4, selectedOptionId: 'a',
      rankedOptionIds: ['a', 'b'], tieOptionIds: ['a', 'b'], ballotCount: 2,
      coordinationWallTimeMs: 2_000,
    });
    expect(finalized.tally).toEqual([
      { optionId: 'a', points: 3, firstChoiceCount: 1, proposalOrder: 0 },
      { optionId: 'b', points: 3, firstChoiceCount: 1, proposalOrder: 1 },
    ]);
    expect(finalized.decisionEvidenceIds).toEqual(['tracker-a', 'tracker-b']);
    expect(finalizePriorityCouncil({
      repository: 'git:repo', councilId: council.id, expectedVersion: 3,
      actor: 'orchestrator-d', taskId: 'peer-d', idempotencyKey: 'final', now: now + 9_000,
    }).id).toBe(council.id);
  });

  it('records deterministic no-quorum only after expiry', () => {
    const council = createPriorityCouncil(input());
    ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['a', 'b']);
    expect(() => finalizePriorityCouncil({
      repository: 'git:repo', councilId: council.id, expectedVersion: 2,
      actor: 'proposer', taskId: 'proposal-task', idempotencyKey: 'early', now: now + 2_000,
    })).toThrow('quorum not reached');
    const expired = finalizePriorityCouncil({
      repository: 'git:repo', councilId: council.id, expectedVersion: 2,
      actor: 'proposer', taskId: 'proposal-task', idempotencyKey: 'expired', now: now + 60_000,
    });
    expect(expired).toMatchObject({ status: 'expired', outcome: 'no-quorum', selectedOptionId: undefined });
    expect(expired.noQuorumReasons).toEqual(['actors:1/2', 'ballots:1/2', 'roles:1/2', 'tasks:1/2']);
  });

  it('CAS-consumes one advisory decision and only reorders the existing cohort slots', () => {
    const council = createPriorityCouncil(input());
    ballot(council.id, 'reviewer-c', 'reviewer', 'peer-c', ['b', 'a']);
    ballot(council.id, 'orchestrator-d', 'orchestrator', 'peer-d', ['b', 'a']);
    const finalized = finalizePriorityCouncil({
      repository: 'git:repo', councilId: council.id, expectedVersion: 3,
      actor: 'orchestrator-d', taskId: 'peer-d', idempotencyKey: 'final', now: now + 2_000,
    });
    const consumed = consumePriorityCouncilRanking({
      repository: 'git:repo', councilId: council.id, expectedCouncilVersion: finalized.version,
      currentSnapshotVersion: 'tracker-v1', consumer: 'scheduler', consumerTaskId: 'heartbeat',
      consumerRole: 'scheduler', now: now + 3_000,
    });
    expect(consumed.signal).toMatchObject({
      rankedTaskIds: ['candidate-b', 'candidate-a'], authority: ADVISORY_RANKING_AUTHORITY,
    });
    expect(consumePriorityCouncilRanking({
      repository: 'git:repo', councilId: council.id, expectedCouncilVersion: finalized.version,
      currentSnapshotVersion: 'tracker-v1', consumer: 'scheduler', consumerTaskId: 'heartbeat',
      consumerRole: 'scheduler', now: now + 9_000,
    }).consumption.id).toBe(consumed.consumption.id);
    expect(() => consumePriorityCouncilRanking({
      repository: 'git:repo', councilId: council.id, expectedCouncilVersion: finalized.version,
      currentSnapshotVersion: 'tracker-v0', consumer: 'orchestrator', consumerTaskId: 'sweep',
      consumerRole: 'orchestrator',
    })).toThrow('snapshot is stale');

    const tasks = [{ id: 'outside-1' }, { id: 'candidate-a' }, { id: 'candidate-b' }, { id: 'outside-2' }];
    const applied = applyAdvisoryPriorityRanking(tasks, consumed.signal, (task) => task.id);
    expect(applied).toMatchObject({ applied: true });
    expect(applied.tasks.map((task) => task.id)).toEqual(['outside-1', 'candidate-b', 'candidate-a', 'outside-2']);
    const forged = { ...consumed.signal, authority: { ...consumed.signal.authority, canMerge: true } };
    expect(applyAdvisoryPriorityRanking(tasks, forged as never, (task) => task.id))
      .toMatchObject({ applied: false, reason: 'authority-contract-mismatch', tasks });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCoordinationThread, getCoordinationThread } from './coordinationThreads.js';
import { getCoordinationStore, resetCoordinationStoreForTests } from './coordinationStore.js';
import { resetTraceDbForTests } from './coordinationTrace.js';
import { executeCoordinationTool } from './coordinationTools.js';
import {
  PRIORITY_COUNCIL_TOOL_DEFINITIONS,
  PRIORITY_COUNCIL_TOOL_NAMES,
  executePriorityCouncilTool,
  type PriorityCouncilToolContext,
} from './priorityCouncilTools.js';
import { PRIORITY_COUNCIL_LIMITS } from './priorityCouncil.js';

let root: string;
const repo = { repository: '/repo', repoKey: 'git:repo' };
const proposer: PriorityCouncilToolContext = {
  ...repo, taskId: 'proposal-task', taskLabel: 'AGT-P', actor: 'orchestrator-p', actorRole: 'orchestrator',
};
const candidate: PriorityCouncilToolContext = {
  ...repo, taskId: 'candidate-a', taskLabel: 'AGT-A', actor: 'worker-a', actorRole: 'worker',
};
const reviewer: PriorityCouncilToolContext = {
  ...repo, taskId: 'peer-c', taskLabel: 'AGT-C', actor: 'reviewer-c', actorRole: 'reviewer',
};
const orchestrator: PriorityCouncilToolContext = {
  ...repo, taskId: 'peer-d', taskLabel: 'AGT-D', actor: 'orchestrator-d', actorRole: 'orchestrator',
};

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'priority-council-tools-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(root, 'automation.db');
  process.env.OPENSWARM_COORDINATION_FILE = join(root, 'coordination.json');
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  const now = Date.now();
  for (const [context, correlationId] of [[candidate, 'presence-a'], [reviewer, 'presence-c'], [orchestrator, 'presence-d']] as const) {
    await getCoordinationStore().publish({
      repository: context.repository, repoKey: context.repoKey, taskId: context.taskId,
      taskLabel: context.taskLabel, actor: context.actor, actorRole: context.actorRole,
      recipient: 'openswarm-daemon', recipientRole: 'daemon', kind: 'delegation-request',
      status: 'running', correlationId, summary: `Active on ${context.taskId}`, timestamp: now,
    });
  }
});

afterEach(() => {
  resetTraceDbForTests();
  resetCoordinationStoreForTests();
  delete process.env.OPENSWARM_AUTOMATION_DB;
  delete process.env.OPENSWARM_COORDINATION_FILE;
  rmSync(root, { recursive: true, force: true });
});

function parsed(result: { content: string }) {
  return JSON.parse(result.content) as Record<string, any>;
}

function openArgs(threadId: string) {
  return {
    thread_id: threadId,
    reason: 'conflict-cohort',
    subject: 'Choose the shared-file integration order',
    options: [
      {
        id: 'a', label: 'Integrate A first', task_id: 'candidate-a', evidence_ids: ['cached-a'],
        scheduling_facts: { priority: 2, downstream_count: 0, blocked_by: [], linear_state: 'Todo' },
      },
      {
        id: 'b', label: 'Integrate B first', task_id: 'candidate-b', evidence_ids: ['cached-b'],
        scheduling_facts: { priority: 2, downstream_count: 0, blocked_by: [], linear_state: 'Todo' },
      },
    ],
    snapshot_version: 'auto',
    snapshot_captured_at: Date.now(),
    snapshot_evidence: [
      { id: 'cached-a', source: 'tracker-cache', summary: 'A and B are equal priority; A was created first.' },
      { id: 'cached-b', source: 'tracker-cache', summary: 'B holds the smaller remaining diff.' },
    ],
    required_quorum: 2,
    expires_in_ms: 60_000,
    idempotency_key: 'open-live-pair',
  };
}

describe('priority council agent tools', () => {
  it('keeps definitions and dispatcher in lockstep', async () => {
    expect([...PRIORITY_COUNCIL_TOOL_NAMES].sort()).toEqual(
      PRIORITY_COUNCIL_TOOL_DEFINITIONS.map((definition) => definition.function.name).sort(),
    );
    for (const definition of PRIORITY_COUNCIL_TOOL_DEFINITIONS) {
      const result = await executePriorityCouncilTool(definition.function.name, {}, proposer);
      expect(result.content).not.toContain('Unknown priority council tool');
    }
  });

  it('runs a live cross-task/cross-role contested pair through the common agent dispatcher', async () => {
    const thread = createCoordinationThread({
      repository: 'git:repo', subject: 'Shared-file conflict', actor: proposer.actor,
      actorRole: proposer.actorRole, taskId: proposer.taskId,
      relatedTaskIds: ['candidate-a', 'candidate-b'], idempotencyKey: 'shared-conflict',
    });
    const opened = await executeCoordinationTool('coordination_council_open', openArgs(thread.id), proposer);
    expect(opened.isError).toBe(false);
    const councilId = parsed(opened).council.id as string;
    const snapshotVersion = parsed(opened).council.snapshotVersion as string;
    expect(snapshotVersion).toMatch(/^sched-v1:[a-f0-9]{64}$/);
    expect(parsed(opened).council.eligibleVoters.map((voter: { taskId: string }) => voter.taskId).sort())
      .toEqual(['peer-c', 'peer-d']);

    const evidence = await executeCoordinationTool('coordination_council_evidence', {
      council_id: councilId, option_id: 'a', summary: 'A owns the migration already.',
      refs: ['thread:shared-conflict'], idempotency_key: 'worker-a-evidence',
    }, candidate);
    expect(evidence.isError).toBe(false);
    expect((await executeCoordinationTool('coordination_council_vote', {
      council_id: councilId, ranking: ['a', 'b'], confidence: 1,
      evidence_ids: ['cached-a'], snapshot_version: snapshotVersion, idempotency_key: 'self-vote',
    }, candidate)).content).toContain('Self-vote');

    for (const [context, ranking, evidenceId] of [
      [reviewer, ['b', 'a'], 'cached-b'],
      [orchestrator, ['b', 'a'], 'cached-b'],
    ] as const) {
      const vote = await executeCoordinationTool('coordination_council_vote', {
        council_id: councilId, ranking: [...ranking], confidence: 0.8,
        evidence_ids: [evidenceId], snapshot_version: snapshotVersion,
        idempotency_key: `vote-${context.actor}`,
      }, context);
      expect(vote.isError).toBe(false);
    }

    const beforeFinal = parsed(await executeCoordinationTool('coordination_council_get', {
      council_id: councilId,
    }, orchestrator));
    expect(beforeFinal.council).toMatchObject({ version: 4, ballotCount: 2, evidenceSubmissionCount: 1 });
    const finalized = await executeCoordinationTool('coordination_council_finalize', {
      council_id: councilId, expected_version: 4, idempotency_key: 'finalize-live-pair',
    }, orchestrator);
    expect(finalized.isError).toBe(false);
    expect(parsed(finalized).council).toMatchObject({
      status: 'finalized', outcome: 'selected', selectedOptionId: 'b', rankedOptionIds: ['b', 'a'],
      ballotCount: 2, evidenceSubmissionCount: 1,
    });
    expect(parsed(finalized).council.coordinationWallTimeMs).toBeGreaterThanOrEqual(0);
    expect(parsed(finalized).council.eligibleVoters.length).toBeLessThanOrEqual(PRIORITY_COUNCIL_LIMITS.maxEligibleVoters);

    const consumed = await executeCoordinationTool('coordination_council_consume', {
      council_id: councilId, expected_council_version: 5, current_snapshot_version: snapshotVersion,
    }, orchestrator);
    expect(consumed.isError).toBe(false);
    expect(parsed(consumed).signal.authority).toMatchObject({
      advisoryOnly: true, canStartTask: false, canBypassDependencies: false,
      canBypassFileLeases: false, canMerge: false, canUseDestructiveTools: false, canMutateTracker: false,
    });

    const audit = getCoordinationThread({ repository: 'git:repo', threadId: thread.id });
    expect(audit.messages.items.map((message) => message.body)).toEqual(expect.arrayContaining([
      expect.stringContaining(`Opened from cached snapshot ${snapshotVersion}`),
      expect.stringContaining('Evidence for a'),
      expect.stringContaining('Equal-weight ballot recorded by reviewer-c'),
      expect.stringContaining('selected. Selected b'),
      expect.stringContaining('Advisory ranking consumed'),
    ]));
    const board = JSON.parse(readFileSync(process.env.OPENSWARM_COORDINATION_FILE!, 'utf8')) as { events: Array<{ kind: string; metadata?: { councilId?: string } }> };
    expect(board.events).toContainEqual(expect.objectContaining({
      kind: 'council-update', metadata: expect.objectContaining({ councilId }),
    }));
  });
});

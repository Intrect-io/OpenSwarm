import { describe, expect, it, vi } from 'vitest';
import {
  buildCompletionEffect,
  buildIntegrationRequeueEffect,
  completionStats,
  deliverTrackerEffect,
} from './trackerEffects.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { EffectClaim } from './runLedger.js';
import type { ITaskSource } from './taskSource.js';

// The durable outbox is the daemon's DEFAULT completion path: on a primary
// ledger the runner returns before its inline logPairComplete call, and the
// Linear comment is rendered from the stats the effect payload carries. A
// field missing here silently degrades the dialogue transcript in production
// while the inline path keeps tests green — exactly how AGT-4019's
// codename/usage enrichment shipped dead on first review.

const task = { id: 'task-1', issueId: 'issue-1', issueIdentifier: 'AGT-1', title: 'T' } as TaskItem;

function pipelineResult(): PipelineResult {
  return {
    success: true,
    sessionId: 'session-1',
    stages: [],
    finalStatus: 'approved',
    totalDuration: 96_400,
    iterations: 2,
    workerResult: {
      success: true,
      summary: 'Added the regression test.',
      filesChanged: ['src/a.ts'],
      commands: ['npx vitest run src/a.test.ts'],
      codename: 'Nova',
      costInfo: { costUsd: 0.021, inputTokens: 12_345, outputTokens: 890, durationMs: 96_400, model: 'gpt-5.6-terra' },
    } as PipelineResult['workerResult'],
    reviewResult: {
      decision: 'approve',
      feedback: 'Covers the guard; approving.',
      codename: 'Sable',
      costInfo: { costUsd: 0.004, inputTokens: 900, outputTokens: 120, durationMs: 22_800, model: 'glm-5.2' },
    } as PipelineResult['reviewResult'],
  };
}

describe('completion effect carries the dialogue identity fields (AGT-4019)', () => {
  it('keeps codenames and per-speaker usage in completionStats', () => {
    const stats = completionStats(pipelineResult());
    expect(stats.workerName).toBe('Nova');
    expect(stats.reviewerName).toBe('Sable');
    expect(stats.workerUsage?.model).toBe('gpt-5.6-terra');
    expect(stats.workerUsage?.inputTokens).toBe(12_345);
    expect(stats.reviewerUsage?.costUsd).toBe(0.004);
  });

  it('carries them through the durable outbox payload', () => {
    const effect = buildCompletionEffect(task, pipelineResult(), 1);
    const stats = (effect.payload as { stats: ReturnType<typeof completionStats> }).stats;
    expect(stats.workerName).toBe('Nova');
    expect(stats.workerUsage?.model).toBe('gpt-5.6-terra');
    expect(stats.reviewerName).toBe('Sable');
    expect(stats.reviewerUsage?.outputTokens).toBe(120);
  });
});

describe('integration requeue effect (AGT-4078)', () => {
  it('delivers Todo plus marker-deduped conflict evidence', async () => {
    const marker = 'integration-conflict:owner/repo#8@abc';
    const input = buildIntegrationRequeueEffect('issue-8', marker, 'conflict evidence');
    const updateState = vi.fn(async () => true);
    const addComment = vi.fn(async () => undefined);
    const source = {
      updateState,
      addComment,
      getExecutionComments: vi.fn(async () => []),
      lookupIssueState: vi.fn(async () => ({
        ok: true as const,
        issue: { state: 'Done', stateType: 'completed' },
      })),
    } as unknown as ITaskSource;
    await deliverTrackerEffect({
      id: 1, issueId: 'issue-8', attemptNo: 1, kind: input.kind, dedupeKey: input.dedupeKey,
      payload: input.payload, status: 'in_flight', attempts: 1, availableAt: 0,
      ownerInstanceId: 'daemon', deliveryToken: 'token', leaseEpoch: 1, leaseExpiresAt: 10_000,
      createdAt: 0, updatedAt: 0,
    } as EffectClaim, source);

    expect(updateState).toHaveBeenCalledWith('issue-8', 'Todo');
    expect(addComment).toHaveBeenCalledWith(
      'issue-8', expect.stringContaining(`<!-- openswarm-effect:${marker} -->`), marker,
    );
    expect(addComment.mock.invocationCallOrder[0]).toBeLessThan(updateState.mock.invocationCallOrder[0]);
  });

  it('does not repeat Todo across comment failures or an outbox ack crash', async () => {
    const marker = 'integration-conflict:owner/repo#9@def';
    const input = buildIntegrationRequeueEffect('issue-9', marker, 'conflict evidence');
    const claim = {
      id: 2, issueId: 'issue-9', attemptNo: 1, kind: input.kind, dedupeKey: input.dedupeKey,
      payload: input.payload, status: 'in_flight', attempts: 1, availableAt: 0,
      ownerInstanceId: 'daemon', deliveryToken: 'token', leaseEpoch: 1, leaseExpiresAt: 10_000,
      createdAt: 0, updatedAt: 0,
    } as EffectClaim;
    let state = 'Done';
    let comments: Array<{ body: string; createdAt: string }> = [];
    const updateState = vi.fn(async () => {
      state = 'Todo';
      return true;
    });
    const addComment = vi.fn()
      .mockRejectedValueOnce(new Error('comment unavailable'))
      .mockImplementationOnce(async (_issueId: string, body: string) => {
        comments = [{ body, createdAt: new Date().toISOString() }];
      });
    const source = {
      updateState,
      addComment,
      getExecutionComments: vi.fn(async () => comments),
      lookupIssueState: vi.fn(async () => ({
        ok: true as const,
        issue: { state, stateType: state === 'Done' ? 'completed' : 'unstarted' },
      })),
    } as unknown as ITaskSource;

    await expect(deliverTrackerEffect(claim, source)).rejects.toThrow('comment unavailable');
    expect(updateState).not.toHaveBeenCalled();

    await deliverTrackerEffect(claim, source);
    expect(updateState).toHaveBeenCalledTimes(1);

    // Simulate a process crash after the remote Todo mutation but before the
    // local outbox ack: the same effect is claimed once more.
    await deliverTrackerEffect(claim, source);
    expect(addComment).toHaveBeenCalledTimes(2);
    expect(updateState).toHaveBeenCalledTimes(1);
  });

  it('preserves a worker claim made before a retry can set Todo', async () => {
    const marker = 'integration-conflict:owner/repo#10@ghi';
    const input = buildIntegrationRequeueEffect('issue-10', marker, 'conflict evidence');
    const updateState = vi.fn(async () => true);
    const source = {
      updateState,
      addComment: vi.fn(async () => undefined),
      getExecutionComments: vi.fn(async () => []),
      lookupIssueState: vi.fn(async () => ({
        ok: true as const,
        issue: { state: 'In Progress', stateType: 'started' },
      })),
    } as unknown as ITaskSource;

    await expect(deliverTrackerEffect({
      id: 3, issueId: 'issue-10', attemptNo: 1, kind: input.kind, dedupeKey: input.dedupeKey,
      payload: input.payload, status: 'in_flight', attempts: 1, availableAt: 0,
      ownerInstanceId: 'daemon', deliveryToken: 'token', leaseEpoch: 1, leaseExpiresAt: 10_000,
      createdAt: 0, updatedAt: 0,
    } as EffectClaim, source)).rejects.toThrow('tracker moved to In Progress');
    expect(updateState).not.toHaveBeenCalled();
  });
});

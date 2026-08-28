import { describe, expect, it } from 'vitest';
import { buildCompletionEffect, completionStats } from './trackerEffects.js';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

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

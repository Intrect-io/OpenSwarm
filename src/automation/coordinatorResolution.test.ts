import { describe, expect, it } from 'vitest';
import { WORKER_NO_CHANGES_PARK_REASON } from '../agents/pairPipelineTypes.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { PUBLICATION_SCOPE_PARK_REASON } from './publishOnPark.js';
import { coordinatorResolutionComment, planCoordinatorResolution } from './coordinatorResolution.js';
import { formatDoDContract } from './dodContract.js';

const task = (description?: string): Pick<TaskItem, 'description'> => ({ description });
const park = (code: string, reason = 'publication-scope: branch contains files outside reserved write scope: pytest-local/case/output.txt') => ({
  operatorPark: { code, reason },
});

describe('coordinator resolution plan', () => {
  it('retries an ephemeral-only publication fence once', () => {
    const plan = planCoordinatorResolution({
      task: task(),
      result: park(PUBLICATION_SCOPE_PARK_REASON),
      attemptNo: 1,
      now: 1000,
    });
    expect(plan).toMatchObject({ action: 'retry', retryAt: 31_000 });
  });

  it('does not retry a source file outside scope', () => {
    const plan = planCoordinatorResolution({
      task: task(),
      result: park(PUBLICATION_SCOPE_PARK_REASON, 'publication-scope: branch contains files outside reserved write scope: src/security.ts'),
      attemptNo: 1,
    });
    expect(plan.action).toBe('park');
  });

  it('does not retry when an ephemeral artifact is mixed with a source file', () => {
    const plan = planCoordinatorResolution({
      task: task(),
      result: park(
        PUBLICATION_SCOPE_PARK_REASON,
        'publication-scope: branch contains files outside reserved write scope: pytest-local/case/output.txt, src/security.ts',
      ),
      attemptNo: 1,
    });
    expect(plan.action).toBe('park');
  });

  it('stops retrying after the repair budget', () => {
    const plan = planCoordinatorResolution({
      task: task(),
      result: park(PUBLICATION_SCOPE_PARK_REASON),
      attemptNo: 2,
    });
    expect(plan.action).toBe('park');
  });

  it('honours an explicit park policy for ephemeral fences', () => {
    const description = formatDoDContract({
      version: 1,
      completion: { noChanges: 'park' },
      automation: { scopeMismatch: 'park', maxRepairs: 1 },
    });
    const plan = planCoordinatorResolution({
      task: task(description),
      result: park(PUBLICATION_SCOPE_PARK_REASON),
      attemptNo: 1,
    });
    expect(plan.action).toBe('park');
  });

  it('completes only when the issue explicitly allows no changes', () => {
    const description = formatDoDContract({
      version: 1,
      completion: { noChanges: 'complete' },
      automation: { scopeMismatch: 'park', maxRepairs: 0 },
    });
    expect(planCoordinatorResolution({
      task: task(description),
      result: park(WORKER_NO_CHANGES_PARK_REASON, 'Worker finished without edits: already satisfied'),
      attemptNo: 1,
    })).toMatchObject({ action: 'complete' });
  });

  it('does not complete a silent zero-diff stuck loop even with noChanges: complete', () => {
    const description = formatDoDContract({
      version: 1,
      completion: { noChanges: 'complete' },
      automation: { scopeMismatch: 'park', maxRepairs: 0 },
    });
    const plan = planCoordinatorResolution({
      task: task(description),
      result: park(
        WORKER_NO_CHANGES_PARK_REASON,
        'Worker claimed success without changing a file and without a noChangesReason (same output produced 3 times). The issue needs a human: either it asks for something the agent cannot express as a diff, or its description does not say what to change.',
      ),
      attemptNo: 1,
    });
    expect(plan.action).toBe('park');
  });

  it('keeps no-change work parked without explicit authority', () => {
    expect(planCoordinatorResolution({
      task: task(),
      result: park(WORKER_NO_CHANGES_PARK_REASON, 'Worker finished without edits: no source change required'),
      attemptNo: 1,
    }).action).toBe('park');
  });

  it('fails closed when a contract block is malformed', () => {
    const malformed = '```openswarm:dod\n{"version":1}\n```';
    const plan = planCoordinatorResolution({
      task: task(malformed),
      result: park(PUBLICATION_SCOPE_PARK_REASON),
      attemptNo: 1,
    });
    expect(plan).toMatchObject({ action: 'park', reason: expect.stringContaining('Malformed DoD contract') });
  });

  it('includes the retry instant in the operator comment', () => {
    const comment = coordinatorResolutionComment({
      action: 'retry',
      reason: 'ephemeral only',
      retryAt: Date.parse('2026-09-09T04:00:00.000Z'),
    });
    expect(comment).toContain('2026-09-09T04:00:00.000Z');
  });
});

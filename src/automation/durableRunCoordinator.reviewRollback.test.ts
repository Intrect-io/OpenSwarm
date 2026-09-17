import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { PR_REVIEW_ROLLBACK_CODE, PR_REVIEW_ROLLBACK_PREFIX } from './draftPullRequestCause.js';

const roots: string[] = [];

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-coordinator-rollback-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function task(id: string): TaskItem {
  return {
    id, issueId: id, issueIdentifier: id, source: 'linear', title: `Task ${id}`,
    priority: 2, createdAt: Date.now(), linearState: 'Todo',
    linearProject: { id: 'project', name: 'Repo' },
  };
}

function published(failureDetail: string | undefined): PipelineResult {
  return {
    success: false,
    sessionId: 'session-1',
    stages: [],
    finalStatus: 'failed',
    totalDuration: 100,
    iterations: 1,
    prUrl: 'https://github.com/o/r/pull/7',
    failureDetail,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('a publication the PR-time review rolled back keeps its cause on the ledger (AGT-4272)', () => {
  it('records the rollback code and the reviewer words instead of the generic reconcile label', async () => {
    // `rollBackReviewedPublication` leaves the PR URL on the result and marks
    // it failed, which is exactly the shape `publishedNeedsReconcile` parks.
    // Until now that park overwrote the rollback's detail with the reconcile
    // boilerplate, so nothing downstream could tell a rejected publication
    // from a crash after publishing — and the reconciler re-ran both.
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'rollback' });

    await coordinator.execute(task('AGT-ROLLBACK'), '/repo', async () =>
      published(`${PR_REVIEW_ROLLBACK_PREFIX}: the tests do not cover the new branch`));

    expect(coordinator.getRun('AGT-ROLLBACK')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      prUrl: 'https://github.com/o/r/pull/7',
      lastErrorCode: PR_REVIEW_ROLLBACK_CODE,
      lastErrorMessage: expect.stringContaining('the tests do not cover the new branch'),
    });
    coordinator.close();
  });

  it('leaves every other published-but-unfinished result on the generic reconcile label', async () => {
    const coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: dbPath(), instanceId: 'rollback' });

    await coordinator.execute(task('AGT-CRASHED'), '/repo', async () => published('tracker update threw'));

    expect(coordinator.getRun('AGT-CRASHED')).toMatchObject({
      state: 'NEEDS_RECONCILE',
      lastErrorCode: 'publication_reconcile',
      lastErrorMessage: 'Published PR requires artifact reconciliation before tracker completion',
    });
    coordinator.close();
  });
});

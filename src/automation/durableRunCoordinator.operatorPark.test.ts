import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-coordinator-park-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function task(id: string): TaskItem {
  return {
    id,
    issueId: id,
    issueIdentifier: id,
    source: 'linear',
    title: `Task ${id}`,
    priority: 2,
    createdAt: Date.now(),
    linearState: 'Todo',
    linearProject: { id: 'project', name: 'Repo' },
  };
}

// vela 2026-09-02: AGT-3844 / AX-868 / AGT-4158 retried a publication-scope
// rejection 48 / 23 / 15 times. The pipeline now names the failure as the
// operator's; the coordinator must park it rather than schedule it again.
describe('DurableRunCoordinator operatorPark', () => {
  it('parks immediately under the pipeline\'s own operator code, before any circuit', async () => {
    const ledger = new RunLedger(dbPath());
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger, infraFailureCircuit: 6 });
    const reason = 'publication-scope: branch contains files outside reserved write scope: uv.lock';
    const parked: PipelineResult = {
      success: false,
      sessionId: 's',
      stages: [],
      finalStatus: 'failed',
      totalDuration: 1,
      iterations: 1,
      failureDetail: `publication: ${reason}`,
      operatorPark: { code: 'publication_scope_mismatch', reason },
    };

    await coordinator.execute(task('scope'), '/repo', async () => parked);

    expect(ledger.getRun('scope')).toMatchObject({
      state: 'NEEDS_HUMAN',
      lastErrorCode: 'publication_scope_mismatch',
      lastErrorMessage: reason,
    });
    // An explicit redispatch after the operator widens the scope resumes it.
    expect(ledger.resumeNeedsHuman('scope')).toBe('READY');
    coordinator.close();
    ledger.close();
  });
});

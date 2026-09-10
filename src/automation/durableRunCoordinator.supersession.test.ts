import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function dbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-supersession-'));
  roots.push(root);
  return join(root, 'automation.db');
}

function task(id: string): TaskItem {
  return {
    id, issueId: id, issueIdentifier: id, source: 'linear', title: `Task ${id}`,
    priority: 2, createdAt: Date.now(), linearState: 'Todo', linearProject: { id: 'project', name: 'Repo' },
  };
}

function ended(finalStatus: PipelineResult['finalStatus']): PipelineResult {
  return { success: false, sessionId: 's', stages: [], finalStatus, totalDuration: 1, iterations: 1 };
}

// vela 2026-09-02: AGT-4168 had eight earlier attempts of every kind; one
// sibling PR (the operator's own #612) claiming its files then cost it a
// six-hour wait, and an explicit redispatch that met the same PR pushed the
// retry to 20:07. The backoff must count supersessions in a row, not history.
describe('supersession backoff', () => {
  it('backs off on the streak of supersessions, ignoring earlier failures of other kinds', async () => {
    const ledger = new RunLedger(dbPath());
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger });
    const t = task('sib');
    let now = 1_000_000;

    for (let i = 0; i < 4; i += 1) {
      await coordinator.execute(t, '/repo', async () => ended('failed'));
      ledger.markReady('sib');
    }
    await coordinator.execute(t, '/repo', async () => ended('superseded'));
    expect(ledger.getRun('sib')).toMatchObject({ state: 'RETRY_AT', attemptNo: 5 });
    now = Date.now();
    // First supersession → the 5-minute floor, not 5 min × 2^4.
    expect((ledger.getRun('sib')!.retryAt ?? 0) - now).toBeLessThanOrEqual(5 * 60_000 + 5_000);

    ledger.markReady('sib');
    await coordinator.execute(t, '/repo', async () => ended('superseded'));
    // Second in a row → 10 minutes.
    const second = (ledger.getRun('sib')!.retryAt ?? 0) - Date.now();
    expect(second).toBeGreaterThan(9 * 60_000);
    expect(second).toBeLessThanOrEqual(10 * 60_000 + 5_000);

    // A failure of another kind resets the streak.
    ledger.markReady('sib');
    await coordinator.execute(t, '/repo', async () => ended('failed'));
    ledger.markReady('sib');
    await coordinator.execute(t, '/repo', async () => ended('superseded'));
    expect((ledger.getRun('sib')!.retryAt ?? 0) - Date.now()).toBeLessThanOrEqual(5 * 60_000 + 5_000);

    coordinator.close();
    ledger.close();
  });
});

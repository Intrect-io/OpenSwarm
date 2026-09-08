import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DurableRunCoordinator } from './durableRunCoordinator.js';
import { RunLedger } from './runLedger.js';
import type { PipelineResult } from '../agents/pairPipeline.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('failure detail persistence (AGT-4237)', () => {
  it.each(['infra_error', 'failed'] as const)('persists %s causes in attempts and runs without staged errors', async (status) => {
    const root = mkdtempSync(join(tmpdir(), 'osw-failure-detail-'));
    roots.push(root);
    const path = join(root, 'automation.db');
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger, infraFailureCircuit: 2 });
    const reader = new Database(path, { readonly: true });
    const task = { id: 'issue', issueId: 'issue', issueIdentifier: 'AGT-TEST', source: 'linear' as const, title: 'task', priority: 2, createdAt: Date.now() };
    const detail = status === 'infra_error'
      ? 'worktree creation: Preserved worktree requires reconciliation (valid=true, branch=swarm/AX-868): /work/cgf-portal/worktree/6627815b'
      : 'pytest missing; prerequisite AGT-3961 remains open';
    const outcome: PipelineResult = {
      success: false, sessionId: 's', stages: [], finalStatus: status, totalDuration: 0, iterations: 1,
      ...(status === 'infra_error' ? { failureDetail: detail } : {
        workerResult: { success: false, summary: detail, filesChanged: [], commands: [], output: '' },
      }),
    };
    try {
      await coordinator.execute(task, '/repo', async () => outcome);
      expect(coordinator.getRun('issue')?.lastErrorMessage).toBe(detail);
      expect(reader.prepare('SELECT error_message FROM automation_attempts WHERE issue_id = ?').get('issue'))
        .toEqual({ error_message: detail });
      if (status === 'infra_error') {
        expect(ledger.markReady('issue')).toBe(true);
        await coordinator.execute(task, '/repo', async () => outcome);
        expect(coordinator.getRun('issue')).toMatchObject({ state: 'NEEDS_HUMAN', lastErrorCode: 'infra_circuit_open' });
        expect(coordinator.getRun('issue')?.lastErrorMessage).toContain(detail);
      }
    } finally {
      reader.close(); coordinator.close(); ledger.close();
    }
  });
});

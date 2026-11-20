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

describe('the change risk class reaches the durable record (AGT-4804)', () => {
  it('stores the class the publisher computed with the attempt', async () => {
    const root = mkdtempSync(join(tmpdir(), 'osw-change-risk-'));
    roots.push(root);
    const path = join(root, 'automation.db');
    const ledger = new RunLedger(path);
    const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger, infraFailureCircuit: 2 });
    const reader = new Database(path, { readonly: true });
    const changeRisk = { level: 'high' as const, reasons: ['migration: `db/migrations/1.sql`'], files: 1, lines: 4 };
    const outcome: PipelineResult = {
      success: false, sessionId: 's', stages: [], finalStatus: 'failed', totalDuration: 1, iterations: 1, changeRisk,
    };
    try {
      await coordinator.execute(
        { id: 'issue', issueId: 'issue', issueIdentifier: 'AGT-1', source: 'linear' as const, title: 't', priority: 2, createdAt: Date.now() },
        '/repo',
        async () => outcome,
      );
      const row = reader.prepare('SELECT result_json FROM automation_attempts WHERE issue_id = ?').get('issue') as { result_json: string };
      expect(JSON.parse(row.result_json).changeRisk).toEqual(changeRisk);
    } finally {
      reader.close(); coordinator.close(); ledger.close();
    }
  });
});

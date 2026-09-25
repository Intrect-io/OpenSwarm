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

function task() {
  return {
    id: 'issue', issueId: 'issue', issueIdentifier: 'AX-1556', source: 'linear' as const,
    title: 'A2 fixed-expense mutation adapter', priority: 2, createdAt: Date.now(),
  };
}

/** The AX-1556 shape: guards warned, the tester then failed, no PR. */
function outcome(guardWarnings?: PipelineResult['guardWarnings']): PipelineResult {
  return {
    success: false, sessionId: 's', stages: [], finalStatus: 'failed',
    totalDuration: 1234, iterations: 2, guardWarnings,
  };
}

async function recordAndRead(guardWarnings?: PipelineResult['guardWarnings']) {
  const root = mkdtempSync(join(tmpdir(), 'osw-guard-warnings-'));
  roots.push(root);
  const path = join(root, 'automation.db');
  const ledger = new RunLedger(path);
  const coordinator = new DurableRunCoordinator({ mode: 'primary', ledger, infraFailureCircuit: 2 });
  const reader = new Database(path, { readonly: true });
  try {
    await coordinator.execute(task(), '/repo', async () => outcome(guardWarnings));
    const row = reader
      .prepare('SELECT result_json FROM automation_attempts WHERE issue_id = ?')
      .get('issue') as { result_json: string | null };
    return JSON.parse(row.result_json ?? '{}') as Record<string, unknown>;
  } finally {
    reader.close(); coordinator.close(); ledger.close();
  }
}

describe('guard warnings reach the durable record (AGT-4439)', () => {
  it('stores what the guard objected to, not just that a guard objected', async () => {
    const stored = await recordAndRead([{
      guard: 'bsDetector',
      issues: [
        'apps/pipelines/src/cgf_pipelines/a2_fixed_expense_master.py:118 possible fake/mock data detected: "TODO"',
      ],
      omitted: 0,
    }]);

    // Before this change the row held exactly these three keys and nothing else.
    expect(Object.keys(stored)).toEqual(expect.arrayContaining(['sessionId', 'totalDuration', 'iterations']));
    expect(stored.guardWarnings).toEqual([{
      guard: 'bsDetector',
      issues: ['apps/pipelines/src/cgf_pipelines/a2_fixed_expense_master.py:118 possible fake/mock data detected: "TODO"'],
      omitted: 0,
    }]);
  });

  it('keeps the dropped count, so a reader of the row is never misled about volume', async () => {
    const stored = await recordAndRead([{ guard: 'bsDetector', issues: ['one'], omitted: 41 }]);
    expect(stored.guardWarnings).toEqual([{ guard: 'bsDetector', issues: ['one'], omitted: 41 }]);
  });

  it('leaves a clean run\'s row as it was', async () => {
    const stored = await recordAndRead(undefined);
    expect(stored.guardWarnings).toBeUndefined();
    expect(stored.iterations).toBe(2);
  });
});

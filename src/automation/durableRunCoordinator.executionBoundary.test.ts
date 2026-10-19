import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableRunCoordinator } from './durableRunCoordinator.js';

let root: string;
let coordinator: DurableRunCoordinator;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'coordinator-boundary-'));
  coordinator = new DurableRunCoordinator({ mode: 'primary', dbPath: join(root, 'automation.db'), instanceId: 'sandbox-quarantine-owner' });
});
afterEach(() => {
  coordinator.close();
  rmSync(root, { recursive: true, force: true });
});

describe('required stage execution quarantine', () => {
  it.each(['worker', 'tester', 'reviewer'] as const)('quarantines an unknown %s outcome without a retry deadline or question correlation', async (stage) => {
    const task = { id: 'unknown-task', source: 'linear' as const, title: 'Verify behavior', priority: 2, createdAt: 1 };
    await coordinator.execute(task, '/repo', async () => ({
      success: false, sessionId: 'session', stages: [], totalDuration: 1, iterations: 1,
      finalStatus: 'waiting_on_operator',
      ...(stage === 'worker' ? { workerResult: {
        success: false, summary: 'Sandbox command outcome unknown',
        filesChanged: [], commands: [], output: 'OUTCOME_UNKNOWN_DO_NOT_RETRY', executionOutcomeUnknown: true,
      } } : stage === 'tester' ? { testerResult: {
        success: false, testsPassed: 0, testsFailed: 0, output: 'OUTCOME_UNKNOWN_DO_NOT_RETRY', executionOutcomeUnknown: true,
      } } : { reviewResult: { decision: 'revise' as const, feedback: 'OUTCOME_UNKNOWN_DO_NOT_RETRY', executionOutcomeUnknown: true } }),
    }));

    expect(coordinator.getRun(task.id)).toMatchObject({
      state: 'NEEDS_HUMAN', retryAt: undefined, lastErrorCode: 'execution_outcome_unknown',
      lastErrorMessage: expect.stringContaining('inspect'),
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tryClaimTaskAdmission,
  getTaskState,
  resetTaskStateStoreForTests,
} from '../taskState/store.js';

describe('tryClaimTaskAdmission', () => {
  let stateDir: string;
  let stateFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-admission-'));
    stateFile = join(stateDir, 'state.json');
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    resetTaskStateStoreForTests();
  });

  afterEach(() => {
    delete process.env.OPENSWARM_TASK_STATE_FILE;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('first claim succeeds, second returns null', () => {
    const first = tryClaimTaskAdmission('AGT-3420', {
      issueIdentifier: 'AGT-3420',
      title: 'Atomic admission',
    });
    expect(first).not.toBeNull();
    expect(first?.execution.status).toBe('in_progress');

    const second = tryClaimTaskAdmission('AGT-3420', {
      issueIdentifier: 'AGT-3420',
      title: 'Atomic admission',
    });
    expect(second).toBeNull();

    expect(getTaskState('AGT-3420')?.execution.status).toBe('in_progress');
  });

  // A restart or expired lease leaves the marker behind. Once the caller has
  // established it is stale, the claim must be able to take it over, or the task
  // stays unadmittable after the engine stopped filtering it (AGT-4667).
  it('takes over an in_progress marker only when the caller says it is stale', () => {
    tryClaimTaskAdmission('AGT-4667', { issueIdentifier: 'AGT-4667', title: 'Stale marker', sessionId: 'dead-session' });

    expect(tryClaimTaskAdmission('AGT-4667', { issueIdentifier: 'AGT-4667', title: 'Stale marker' })).toBeNull();
    expect(tryClaimTaskAdmission('AGT-4667', { issueIdentifier: 'AGT-4667', title: 'Stale marker' }, { takeOverStale: false })).toBeNull();

    const taken = tryClaimTaskAdmission(
      'AGT-4667',
      { issueIdentifier: 'AGT-4667', title: 'Stale marker', sessionId: 'new-session' },
      { takeOverStale: true },
    );
    expect(taken?.execution.status).toBe('in_progress');
    expect(taken?.execution.lastSessionId).toBe('new-session');
  });

  it('claims normally with takeOverStale when nothing marks the task in_progress', () => {
    expect(tryClaimTaskAdmission('AGT-4668', { title: 'Fresh' }, { takeOverStale: true })?.execution.status).toBe('in_progress');
  });
});

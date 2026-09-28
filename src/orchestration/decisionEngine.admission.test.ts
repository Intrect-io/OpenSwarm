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
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { claimExecHold, clearExecHold, isExecHeld, resetExecHoldForTests } from '../automation/execHold.js';
import type { LinearIssueInfo, SwarmConfig } from '../core/types.js';
import type { RepoMetadata } from '../support/repoMetadata.js';
import { runExecDeployCommand, type ExecCommandDeps } from './execCommand.js';

// Split out of execCommand.test.ts, which is at its line cap. These run the deploy against the real
// hold store, the path production uses; the injected-seam tests stay in execCommand.test.ts.

const ISSUE_ID = 'uuid-hold-race';
const REFUSED = { status: 403, body: { error: 'not allowed' } };

let dir: string;
const ORIGINAL = process.env.OPENSWARM_AUTOMATION_DB;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'openswarm-execdeploy-'));
  process.env.OPENSWARM_AUTOMATION_DB = join(dir, 'automation.db');
  resetExecHoldForTests();
});

afterEach(() => {
  clearExecHold(ISSUE_ID);
  resetExecHoldForTests();
  if (ORIGINAL === undefined) delete process.env.OPENSWARM_AUTOMATION_DB;
  else process.env.OPENSWARM_AUTOMATION_DB = ORIGINAL;
  rmSync(dir, { recursive: true, force: true });
});

function refusedDeploy(overrides: Partial<ExecCommandDeps> = {}): ExecCommandDeps {
  return {
    loadConfig: () => ({}) as unknown as SwarmConfig,
    setAutomationDbPath: () => undefined,
    actor: 'external:test',
    ensureTaskSource: async () => ({}),
    isGitRepo: () => true,
    loadRepoMetadata: async () => ({ schemaVersion: 1, linear: { projectId: 'proj-1' } }) as unknown as RepoMetadata,
    getIssue: async () => ({
      id: ISSUE_ID, identifier: 'INT-1', title: 't', state: 'Todo', priority: 2, labels: [], comments: [],
      project: { id: 'proj-1', name: 'OpenSwarm' },
    }) as LinearIssueInfo,
    daemonHealthy: async () => true,
    postWork: async () => REFUSED,
    out: () => undefined,
    log: () => undefined,
    ...overrides,
  };
}

describe('exec deploy against the real hold store', () => {
  it('writes the hold and releases it again when nothing was deployed', async () => {
    expect(await runExecDeployCommand({ issue: 'INT-1', path: '/repo', json: true }, refusedDeploy())).toBe(1);
    expect(isExecHeld(ISSUE_ID)).toBe(false);
  });

  it('keeps the hold when another deploy of the same issue claimed it after this one: the refused deploy is not the owner', async () => {
    const deps = refusedDeploy({
      // The other orchestrator's claim lands between this call's claim and its refused deploy.
      claimHold: (issueId, who) => {
        const mine = claimExecHold(issueId, who);
        claimExecHold(issueId, 'external:other');
        return mine;
      },
    });
    expect(await runExecDeployCommand({ issue: 'INT-1', path: '/repo', json: true }, deps)).toBe(1);
    expect(isExecHeld(ISSUE_ID)).toBe(true);
  });

  it('keeps a hold that existed before this call', async () => {
    claimExecHold(ISSUE_ID, 'external:earlier');
    expect(await runExecDeployCommand({ issue: 'INT-1', path: '/repo', json: true }, refusedDeploy())).toBe(1);
    expect(isExecHeld(ISSUE_ID)).toBe(true);
  });
});

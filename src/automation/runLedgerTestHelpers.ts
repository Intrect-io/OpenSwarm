import { afterEach, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RunLedger, type RunClaim } from './runLedger.js';

const roots: string[] = [];
const execFileAsync = promisify(execFile);

export { execFileAsync };

export function createDbPath(): string {
  const root = mkdtempSync(join(tmpdir(), 'openswarm-run-ledger-'));
  roots.push(root);
  return join(root, 'automation.db');
}

export function register(ledger: RunLedger, issueId: string, projectPath = '/repo', fileScope?: string[]): void {
  ledger.registerRun({
    issueId,
    source: 'linear',
    identifier: issueId,
    title: `Task ${issueId}`,
    projectPath,
    metadata: fileScope ? { fileScope } : undefined,
  }, 1_000);
}

export function claim(ledger: RunLedger, issueId: string, owner: string, now = 2_000, maxActiveForProject = 1): RunClaim {
  const result = ledger.claimRun(issueId, {
    ownerInstanceId: owner,
    leaseMs: 1_000,
    maxActiveForProject,
    now,
  });
  expect(result).not.toBeNull();
  return result!;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

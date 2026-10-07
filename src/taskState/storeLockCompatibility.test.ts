import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildLockPayload, getTaskState, resetTaskStateStoreForTests } from './store.js';

describe('task state lock compatibility', () => {
  let stateDir: string;
  let stateFile: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'openswarm-lock-compat-'));
    stateFile = join(stateDir, 'state.json');
    process.env.OPENSWARM_TASK_STATE_FILE = stateFile;
    resetTaskStateStoreForTests();
  });

  afterEach(() => {
    resetTaskStateStoreForTests();
    rmSync(stateDir, { recursive: true, force: true });
    delete process.env.OPENSWARM_TASK_STATE_FILE;
  });

  it('makes a dual-lock writer wait for a legacy dot-lock-only writer', async () => {
    const lockPath = `${stateFile}.lock`;
    writeFileSync(lockPath, JSON.stringify(buildLockPayload('legacy-writer')));

    const fixture = fileURLToPath(new URL('./storeClaimProcess.fixture.ts', import.meta.url));
    const child = spawn(process.execPath, ['--import', 'tsx', fixture, stateFile, 'MIXED-CLIENT'], {
      stdio: 'pipe',
    });
    let stderr = '';
    let stdout = '';
    let readyResolve!: () => void;
    const ready = new Promise<void>((resolve) => { readyResolve = resolve; });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('READY')) readyResolve();
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });

    try {
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(child.exitCode).toBeNull();
    } finally {
      unlinkSync(lockPath);
    }

    expect(await exit, stderr).toBe(0);
    resetTaskStateStoreForTests();
    expect(getTaskState('MIXED-CLIENT')?.title).toBe('MIXED-CLIENT');
  });
});

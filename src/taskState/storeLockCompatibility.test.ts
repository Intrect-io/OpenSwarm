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
    let attemptResolve!: () => void;
    const attemptingWrite = new Promise<void>((resolve) => { attemptResolve = resolve; });
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
      if (stdout.includes('ATTEMPTING_WRITE')) attemptResolve();
    });
    child.stderr.on('data', (chunk) => { stderr += String(chunk); });
    const exit = new Promise<number>((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code) => resolve(code ?? 1));
    });

    try {
      await attemptingWrite;
      const resultWhileLocked = await Promise.race([
        exit.then((code) => ({ kind: 'exit' as const, code })),
        new Promise<{ kind: 'pending' }>((resolve) => setTimeout(() => resolve({ kind: 'pending' }), 150)),
      ]);
      expect(resultWhileLocked).toEqual({ kind: 'pending' });
      expect(child.exitCode).toBeNull();
    } finally {
      unlinkSync(lockPath);
    }

    expect(await exit, stderr).toBe(0);
    resetTaskStateStoreForTests();
    expect(getTaskState('MIXED-CLIENT')?.title).toBe('MIXED-CLIENT');
  });
});

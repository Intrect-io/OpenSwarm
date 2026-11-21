import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readlinkSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { buildLockPayload, getTaskState, resetTaskStateStoreForTests, upsertTaskState } from './store.js';

/** Open descriptors of this process that point at `target` (Linux only; null elsewhere). */
function openHandlesTo(target: string): number | null {
  if (process.platform !== 'linux') return null;
  return readdirSync('/proc/self/fd').filter((fd) => {
    try { return readlinkSync(`/proc/self/fd/${fd}`) === target; } catch { return false; }
  }).length;
}

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
    const mutexPath = `${stateFile}.mutex.db`;
    const initializeMutex = new Database(mutexPath);
    initializeMutex.exec('CREATE TABLE task_state_mutex (id INTEGER PRIMARY KEY CHECK (id = 1)); INSERT INTO task_state_mutex (id) VALUES (1)');
    initializeMutex.close();
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
      const contender = new Database(mutexPath, { timeout: 0 });
      const deadline = Date.now() + 5_000;
      let observedMutexHeld = false;
      while (Date.now() < deadline && !observedMutexHeld) {
        try {
          contender.exec('BEGIN IMMEDIATE');
          contender.exec('ROLLBACK');
          await new Promise((resolve) => setTimeout(resolve, 5));
        } catch (error) {
          if ((error as { code?: string }).code !== 'SQLITE_BUSY') throw error;
          observedMutexHeld = true;
        }
        if (child.exitCode !== null) break;
      }
      contender.close();
      expect(observedMutexHeld).toBe(true);
      expect(child.exitCode).toBeNull();
    } finally {
      unlinkSync(lockPath);
    }

    expect(await exit, stderr).toBe(0);
    resetTaskStateStoreForTests();
    expect(getTaskState('MIXED-CLIENT')?.title).toBe('MIXED-CLIENT');
  });
  it('reports mutex contention as a task state lock timeout and closes the mutex handle', () => {
    const mutexPath = `${stateFile}.mutex.db`;
    const holder = new Database(mutexPath);
    holder.exec('CREATE TABLE IF NOT EXISTS task_state_mutex (id INTEGER PRIMARY KEY CHECK (id = 1)); INSERT OR IGNORE INTO task_state_mutex (id) VALUES (1); BEGIN IMMEDIATE');
    try {
      const started = Date.now();
      // A raw SQLITE_BUSY would escape here before the fix; callers match on this message.
      expect(() => upsertTaskState('CONTENDED', { title: 'CONTENDED' })).toThrow(`Timed out waiting for task state lock: ${mutexPath}`);
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally {
      holder.exec('ROLLBACK');
      holder.close();
    }
    // SQLite defers closing a connection's fd while another connection in this
    // process holds a lock on the same file, so count only once the holder is
    // gone: a closed writer leaves nothing, a leaked one keeps its fd.
    const leftOpen = openHandlesTo(mutexPath);
    if (leftOpen !== null) expect(leftOpen).toBe(0);
    // Nothing was left locked: the same writer now succeeds.
    upsertTaskState('CONTENDED', { title: 'CONTENDED' });
    resetTaskStateStoreForTests();
    expect(getTaskState('CONTENDED')?.title).toBe('CONTENDED');
  }, 20_000);
});

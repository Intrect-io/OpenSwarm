// ============================================
// OpenSwarm - Runner State Lock
// Owner-safe stale-lock recovery + the exclusive mutation lock around
// runner-state files. Split out of runnerState.ts for the LOC gate.
// ============================================

import {
  existsSync,
  mkdirSync,
  readFileSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  fsyncSync,
  statSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import {
  isProofCapableSpace,
  processAppearsAlive,
  processNamespaceId,
  sameProcessNamespace,
} from '../support/processLiveness.js';

function ensureParentDir(filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
}

type RunnerLockOwner = { pid: number; token: string; ns?: string | null };

function readRunnerLockOwner(lockPath: string): RunnerLockOwner | null {
  try {
    const value = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<RunnerLockOwner>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? {
        pid: value.pid!,
        token: value.token,
        ns: value.ns === null ? null : typeof value.ns === 'string' ? value.ns : undefined,
      }
      : null;
  } catch {
    return null;
  }
}

/**
 * Release a runner-state lock only when we can prove its owner is gone in OUR
 * pid namespace. A lock from another namespace (or with no namespace recorded)
 * is left alone — reclaiming it would free a live remote owner's lock.
 *
 * Returns true when the lock file was removed.
 */
export function releaseStaleLock(lockPath: string): boolean {
  if (!existsSync(lockPath)) return false;
  const owner = readRunnerLockOwner(lockPath);
  if (!owner) {
    // Malformed lock: only reclaim when aged past a short stale window.
    try {
      const judgedMtimeMs = statSync(lockPath).mtimeMs;
      if (Date.now() - judgedMtimeMs > 30_000) {
        // Reclaim only the lock we judged: re-verify it is still the same
        // (still malformed, same mtime) before the unlink.
        if (readRunnerLockOwner(lockPath) === null && statSync(lockPath).mtimeMs === judgedMtimeMs) {
          unlinkSync(lockPath);
          return true;
        }
      }
    } catch {
      return false;
    }
    return false;
  }
  // Namespace proof required: never release a lock we cannot judge.
  if (!isProofCapableSpace(owner.ns ?? undefined) || !sameProcessNamespace(owner.ns ?? undefined)) {
    return false;
  }
  if (processAppearsAlive(owner.pid)) return false;
  // Reclaim only the lock we judged. Between our read and the unlink the owner
  // can release and a third process can take a fresh lock; deleting THAT one
  // would put two writers on the resource. Re-verify token+mtime first (same
  // pattern as support/fileLock.ts).
  try {
    const judgedMtimeMs = statSync(lockPath).mtimeMs;
    const judged = readRunnerLockOwner(lockPath);
    if (judged?.token !== owner.token || statSync(lockPath).mtimeMs !== judgedMtimeMs) return false;
    unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Exclusive file lock around a runner-state mutation. Uses the same
 * owner-safe stale recovery as `releaseStaleLock`.
 */
export function withRunnerStateLock<T>(stateFile: string, operation: () => T): T {
  const lockPath = `${stateFile}.lock`;
  ensureParentDir(stateFile);
  const deadline = Date.now() + 5_000;
  const token = randomUUID();
  let lockFd: number | undefined;

  while (lockFd === undefined) {
    try {
      lockFd = openSync(lockPath, 'wx', 0o600);
      writeFileSync(lockFd, JSON.stringify({
        pid: process.pid,
        token,
        ns: processNamespaceId() ?? null,
      }), 'utf8');
      fsyncSync(lockFd);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw error;
      releaseStaleLock(lockPath);
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for runner state lock: ${lockPath}`);
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
    }
  }

  try {
    return operation();
  } finally {
    closeSync(lockFd);
    try {
      if (readRunnerLockOwner(lockPath)?.token === token) unlinkSync(lockPath);
    } catch {
      // Best-effort unlock.
    }
  }
}

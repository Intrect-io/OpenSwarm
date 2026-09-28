import { randomUUID } from 'node:crypto';
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';

type LockOwner = { pid: number; token: string };

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4));

/**
 * The real setTimeout, captured at module load. Lock waits are real-time
 * scheduling, not application timers: a test that fakes setTimeout to skip a
 * retry backoff must not also freeze lock hand-off, which would hang the
 * acquire loop until the test's own timeout.
 */
const lockWaitTimer = globalThis.setTimeout;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function parseOwner(raw: string): LockOwner | null {
  try {
    const value = JSON.parse(raw) as Partial<LockOwner>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? { pid: value.pid!, token: value.token }
      : null;
  } catch {
    return null;
  }
}

async function owner(path: string): Promise<LockOwner | null> {
  try {
    return parseOwner(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

function ownerSync(path: string): LockOwner | null {
  try {
    return parseOwner(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Synchronous counterpart of the async reclaim below, sharing its ownership
 * judgement: only the exact lock observed as stale may be removed, so a live
 * holder that took the file between judgement and unlink is left alone.
 *
 * Returns true when the caller should retry the acquire loop.
 */
function reclaimStaleLockSync(path: string, current: LockOwner | null, malformedStaleMs: number): boolean {
  let judgedMtimeMs: number | undefined;
  let malformedAndStale = false;
  if (current === null) {
    try {
      judgedMtimeMs = statSync(path).mtimeMs;
      malformedAndStale = Date.now() - judgedMtimeMs > malformedStaleMs;
    } catch (statError) {
      // The holder released the lock between our failed open and this stat.
      // That is the normal hand-off, not an error: retry the open.
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      return true;
    }
  } else {
    try {
      judgedMtimeMs = statSync(path).mtimeMs;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      return true;
    }
  }
  // Reclaim only the lock we judged — same reasoning as the async path.
  if (((current !== null && !alive(current.pid)) || malformedAndStale) && judgedMtimeMs !== undefined) {
    const judgedToken = current?.token;
    try {
      const currentOwner = ownerSync(path);
      const currentMtimeMs = statSync(path).mtimeMs;
      if (currentMtimeMs === judgedMtimeMs && currentOwner?.token === judgedToken) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          const code = (unlinkError as NodeJS.ErrnoException).code;
          // ENOENT: another reclaim won. ENOTEMPTY: directory-style locks with
          // concurrent claim markers — retry the acquire loop after a wait.
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw unlinkError;
        }
      }
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
    }
    return true;
  }
  return false;
}

export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: { timeoutMs?: number; malformedStaleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const malformedStaleMs = options.malformedStaleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });

  for (;;) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }), 'utf8');
      await handle.sync();
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await owner(path);
      let judgedMtimeMs: number | undefined;
      let malformedAndStale = false;
      if (current === null) {
        try {
          judgedMtimeMs = (await stat(path)).mtimeMs;
          malformedAndStale = Date.now() - judgedMtimeMs > malformedStaleMs;
        } catch (statError) {
          // The holder released the lock between our failed open and this stat.
          // That is the normal hand-off, not an error: retry the open.
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
          continue;
        }
      } else {
        try {
          judgedMtimeMs = (await stat(path)).mtimeMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
          continue;
        }
      }
      // Reclaim only the lock we judged. Between judgement and unlink the holder
      // can release and a third process can take a fresh lock; deleting THAT one
      // would put two writers on the resource. Re-check mtime+token first.
      if (((current !== null && !alive(current.pid)) || malformedAndStale) && judgedMtimeMs !== undefined) {
        const judgedToken = current?.token;
        try {
          const currentOwner = await owner(path);
          const currentMtimeMs = (await stat(path)).mtimeMs;
          const sameLock = currentMtimeMs === judgedMtimeMs
            && currentOwner?.token === judgedToken;
          if (sameLock) {
            await unlink(path).catch((unlinkError) => {
              const code = (unlinkError as NodeJS.ErrnoException).code;
              // ENOENT: another reclaim raced us. ENOTEMPTY: directory-style
              // locks carrying concurrent claim markers — retry the loop.
              if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw unlinkError;
            });
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      await new Promise((resolve) => lockWaitTimer(resolve, 10));
    }
  }

  try {
    return await operation();
  } finally {
    // Ownership-safe release: only the token that created this lock may unlink.
    if ((await owner(path))?.token === token) {
      await unlink(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}

/**
 * Synchronous counterpart for callers that must stay sync (durable runner state,
 * auth store writes). Same ownership rules as {@link withFileLock}; the wait is
 * an Atomics wait on a shared buffer rather than a busy loop.
 */
export function withFileLockSync<T>(
  path: string,
  operation: () => T,
  options: { timeoutMs?: number; malformedStaleMs?: number } = {},
): T {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const malformedStaleMs = options.malformedStaleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const token = randomUUID();
  mkdirSync(dirname(path), { recursive: true });

  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(path, 'wx', 0o600);
      writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), 'utf8');
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      break;
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (reclaimStaleLockSync(path, ownerSync(path), malformedStaleMs)) {
        Atomics.wait(lockWaitBuffer, 0, 0, 10);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      Atomics.wait(lockWaitBuffer, 0, 0, 10);
    }
  }

  try {
    return operation();
  } finally {
    if (ownerSync(path)?.token === token) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
}

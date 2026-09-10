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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwnerSync(path: string): LockOwner | null {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockOwner>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? { pid: value.pid!, token: value.token }
      : null;
  } catch {
    return null;
  }
}

async function owner(path: string): Promise<LockOwner | null> {
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as Partial<LockOwner>;
    return Number.isInteger(value.pid) && (value.pid ?? 0) > 0 && typeof value.token === 'string'
      ? { pid: value.pid!, token: value.token }
      : null;
  } catch {
    return null;
  }
}

/**
 * Synchronous cross-process lock for sync read-modify-write call sites
 * (e.g. runnerState). Mirrors `withFileLock` semantics with sync fs + Atomics.wait.
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
    try {
      const fd = openSync(path, 'wx', 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ pid: process.pid, token }), 'utf8');
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = readOwnerSync(path);
      let malformedAndStale = false;
      if (current === null) {
        try {
          malformedAndStale = Date.now() - statSync(path).mtimeMs > malformedStaleMs;
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
          continue;
        }
      }
      if ((current !== null && !alive(current.pid)) || malformedAndStale) {
        try {
          unlinkSync(path);
        } catch (unlinkError) {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        }
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      Atomics.wait(lockWaitBuffer, 0, 0, 10);
    }
  }

  try {
    return operation();
  } finally {
    if (readOwnerSync(path)?.token === token) {
      try {
        unlinkSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
  }
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
      let malformedAndStale = false;
      if (current === null) {
        try {
          malformedAndStale = Date.now() - (await stat(path)).mtimeMs > malformedStaleMs;
        } catch (statError) {
          // The holder released the lock between our failed open and this stat.
          // That is the normal hand-off, not an error: retry the open.
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
          continue;
        }
      }
      if ((current !== null && !alive(current.pid)) || malformedAndStale) {
        await unlink(path).catch((unlinkError) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
        });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  try {
    return await operation();
  } finally {
    if ((await owner(path))?.token === token) {
      await unlink(path).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      });
    }
  }
}

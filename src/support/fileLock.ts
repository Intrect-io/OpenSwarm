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

function sleepSync(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy-wait is acceptable for short cross-process lock hand-offs (≤10ms).
  }
}

async function reclaimStaleLock(
  path: string,
  current: LockOwner | null,
  malformedStaleMs: number,
): Promise<boolean> {
  let malformedAndStale = false;
  if (current === null) {
    try {
      malformedAndStale = Date.now() - (await stat(path)).mtimeMs > malformedStaleMs;
    } catch (statError) {
      // The holder released the lock between our failed open and this stat.
      // That is the normal hand-off, not an error: retry the open.
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      return true;
    }
  }
  if ((current !== null && !alive(current.pid)) || malformedAndStale) {
    await unlink(path).catch((unlinkError) => {
      const code = (unlinkError as NodeJS.ErrnoException).code;
      // ENOENT: another reclaim won. ENOTEMPTY: directory-style locks with
      // concurrent claim markers — retry the open loop after a brief wait.
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw unlinkError;
    });
    return true;
  }
  return false;
}

function reclaimStaleLockSync(
  path: string,
  current: LockOwner | null,
  malformedStaleMs: number,
): boolean {
  let malformedAndStale = false;
  if (current === null) {
    try {
      malformedAndStale = Date.now() - statSync(path).mtimeMs > malformedStaleMs;
    } catch (statError) {
      if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
      return true;
    }
  }
  if ((current !== null && !alive(current.pid)) || malformedAndStale) {
    try {
      unlinkSync(path);
    } catch (unlinkError) {
      const code = (unlinkError as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTEMPTY') throw unlinkError;
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
      if (await reclaimStaleLock(path, current, malformedStaleMs)) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
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
 * Synchronous counterpart for callers that must stay sync (telemetry, oauth
 * save, pipeline history). Same ownership rules as {@link withFileLock}.
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
      const current = ownerSync(path);
      if (reclaimStaleLockSync(path, current, malformedStaleMs)) {
        sleepSync(10);
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for file lock: ${path}`);
      sleepSync(10);
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

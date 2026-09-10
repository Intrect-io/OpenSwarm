import { randomUUID } from 'node:crypto';
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
              if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError;
            });
          }
        } catch (statError) {
          if ((statError as NodeJS.ErrnoException).code !== 'ENOENT') throw statError;
        }
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

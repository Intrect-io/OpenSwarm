import {
  closeSync,
  chmodSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { chmod, mkdir, open, rename, stat, unlink } from 'node:fs/promises';

function existingModeSync(path: string): number {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return 0o600;
  }
}

async function existingMode(path: string): Promise<number> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return 0o600;
  }
}

export function atomicWriteFileSync(path: string, contents: string, mode?: number): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });
  const targetMode = mode ?? existingModeSync(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporaryPath, 'wx', targetMode);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporaryPath, path);
    chmodSync(path, targetMode);
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
    } catch {
      // Preserve the original write failure.
    }
    throw error;
  }
}

export async function atomicWriteFile(path: string, contents: string, mode?: number): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const targetMode = mode ?? await existingMode(path);
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temporaryPath, 'wx', targetMode);
  try {
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    await rename(temporaryPath, path);
    await chmod(path, targetMode);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

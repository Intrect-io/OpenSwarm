import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';

export interface LogRotationOptions {
  logDir?: string;
  maxBytes?: number;
  generations?: number;
  staleLockMs?: number;
  now?: number;
}

export interface LogRotationResult {
  rotated: string[];
  skippedLocked: boolean;
}

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024;
const DEFAULT_GENERATIONS = 5;

function positiveInteger(value: number | undefined, fallback: number): number {
  return value != null && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function configuredMaxBytes(): number {
  const parsed = Number(process.env.OPENSWARM_LOG_MAX_BYTES);
  return positiveInteger(parsed, DEFAULT_MAX_BYTES);
}

function safeUnlink(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // A competing startup may already have moved/removed the exact lock/temp.
  }
}

function rotateOne(logPath: string, maxBytes: number, generations: number): boolean {
  let activeFd: number | undefined;
  try {
    activeFd = openSync(logPath, constants.O_RDWR | constants.O_NOFOLLOW);
  } catch (error) {
    if (['ENOENT', 'EISDIR', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    throw error;
  }
  try {
    const info = fstatSync(activeFd);
    if (!info.isFile() || info.size < maxBytes) return false;

    const oldest = `${logPath}.${generations}`;
    safeUnlink(oldest);
    for (let generation = generations - 1; generation >= 1; generation--) {
      const source = `${logPath}.${generation}`;
      try {
        if (lstatSync(source).isFile()) renameSync(source, `${logPath}.${generation + 1}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }

    const temporary = `${logPath}.rotate-${process.pid}-${randomUUID()}`;
    try {
      const archiveFd = openSync(temporary, 'wx', 0o600);
      try {
        writeFileSync(archiveFd, readFileSync(activeFd));
        fsyncSync(archiveFd);
      } finally {
        closeSync(archiveFd);
      }
      chmodSync(temporary, 0o600);
      renameSync(temporary, `${logPath}.1`);

      // launchd opens stdout/stderr before Node starts. Truncating the already
      // opened descriptor keeps that inode (and inherited descriptors) valid.
      ftruncateSync(activeFd, 0);
      fsyncSync(activeFd);
      return true;
    } catch (error) {
      safeUnlink(temporary);
      throw error;
    }
  } finally {
    if (activeFd !== undefined) closeSync(activeFd);
  }
}

/** Rotate launchd stdout/stderr once at service startup under a cross-process lock. */
export function rotateServiceLogs(options: LogRotationOptions = {}): LogRotationResult {
  const logDir = options.logDir ?? join(homedir(), '.openswarm', 'logs');
  const maxBytes = positiveInteger(options.maxBytes, configuredMaxBytes());
  const generations = positiveInteger(options.generations, DEFAULT_GENERATIONS);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const lockPath = join(logDir, '.rotation-lock.db');
  const lockDb = new Database(lockPath, { timeout: 0 });
  chmodSync(lockPath, 0o600);
  try {
    lockDb.exec('BEGIN IMMEDIATE');
  } catch (error) {
    lockDb.close();
    if ((error as { code?: string }).code?.startsWith('SQLITE_BUSY')) {
      return { rotated: [], skippedLocked: true };
    }
    throw error;
  }

  try {
    const rotated = ['stdout.log', 'stderr.log']
      .filter((name) => rotateOne(join(logDir, name), maxBytes, generations));
    return { rotated, skippedLocked: false };
  } finally {
    try { lockDb.exec('ROLLBACK'); } finally { lockDb.close(); }
  }
}

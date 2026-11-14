// ============================================
// OpenSwarm - Contained directory writes
// Purpose: write files into one directory without following a symlink that
//          replaces it between the check and the write (AGT-3447).
// ============================================

import {
  closeSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync,
  unlinkSync, writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';

/** Identity of a directory pinned at check time: its path and its inode. */
export interface PinnedDirectory {
  path: string;
  dev: number;
  ino: number;
}

function sameInode(a: { dev: number; ino: number }, b: { dev: number; ino: number }): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/**
 * Create (if needed) and pin `<root>/<name>` as a real directory directly
 * inside the canonical `root`. A symlink or non-directory at that path is
 * refused rather than followed.
 */
export function pinChildDirectory(root: string, name: string): PinnedDirectory {
  if (name !== basename(name) || name === '.' || name === '..') {
    throw new Error(`Invalid directory name: ${name}`);
  }
  const path = join(realpathSync(root), name);
  try {
    // Non-recursive: mkdir never follows a symlink at the final component, so a
    // planted link makes this fail with EEXIST and the lstat below refuses it.
    mkdirSync(path, { mode: 0o755 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to write through ${path}: not a real directory`);
  }
  return { path, dev: stat.dev, ino: stat.ino };
}

function assertStillPinned(dir: PinnedDirectory): void {
  const stat = lstatSync(dir.path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || !sameInode(stat, dir)) {
    throw new Error(`Refusing to write through ${dir.path}: directory was replaced after it was checked`);
  }
}

/**
 * Atomically write `fileName` inside a pinned directory.
 *
 * Node has no openat(), so the write goes through the path. Containment is
 * kept by checking identities instead: the directory must still be the pinned
 * inode before and after the temporary file is written, and the path must
 * still lead to the very inode that was written. A directory swapped for a
 * symlink in between is detected, the temporary file is removed, and nothing
 * is renamed into place. The final rename replaces a symlink at the target
 * name instead of following it.
 */
export function writeFileInPinnedDirectory(dir: PinnedDirectory, fileName: string, contents: string): string {
  if (fileName !== basename(fileName) || fileName === '.' || fileName === '..') {
    throw new Error(`Invalid file name: ${fileName}`);
  }
  assertStillPinned(dir);
  const target = join(dir.path, fileName);
  const temporary = join(dir.path, `.${fileName}.${process.pid}.${randomUUID()}.tmp`);
  let fd: number | undefined;
  let written: { dev: number; ino: number } | undefined;
  try {
    // Keep an existing regular file's mode; new files are private, as with atomicWriteFileSync.
    let mode = 0o600;
    try {
      const existing = lstatSync(target);
      if (existing.isFile()) mode = existing.mode & 0o777;
    } catch {
      // No existing target.
    }
    fd = openSync(temporary, 'wx', mode);  // O_EXCL: never opens an existing link
    fchmodSync(fd, mode);
    writeFileSync(fd, contents, 'utf8');
    fsyncSync(fd);
    written = fstatSync(fd);
    closeSync(fd);
    fd = undefined;

    assertStillPinned(dir);
    const atPath = lstatSync(temporary);
    if (!atPath.isFile() || !sameInode(atPath, written)) {
      throw new Error(`Refusing to write through ${dir.path}: temporary file is not the one written`);
    }
    renameSync(temporary, target);
    return target;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      // Already renamed or never created; keep the original error.
    }
    throw error;
  }
}

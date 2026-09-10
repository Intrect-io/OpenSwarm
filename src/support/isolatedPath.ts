// ============================================
// OpenSwarm - isolated copies of ignored dependencies/data
// ============================================

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { cp, lstat, mkdir, readdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const COPY_TIMEOUT_MS = 5 * 60_000;

async function copyWithCloneFallback(
  source: string, target: string, exclude?: (path: string) => boolean, label = '',
): Promise<void> {
  if (exclude) {
    // Filter before reading files or following dependency links. Reflinks still
    // give independent writes where the filesystem supports them.
    await cp(source, target, {
      recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
      filter: (path) => !exclude(join(label, relative(source, path))),
    });
    return;
  }
  try {
    if (process.platform === 'darwin') {
      // APFS clonefile: independent writes with near-constant-time/space copies.
      await exec('cp', ['-cR', source, target], { timeout: COPY_TIMEOUT_MS });
      return;
    }
    if (process.platform === 'linux') {
      // GNU cp uses reflinks when the filesystem supports them and copies normally
      // otherwise, while preserving symlinks and executable metadata.
      await exec('cp', ['-a', '--reflink=auto', '--', source, target], { timeout: COPY_TIMEOUT_MS });
      return;
    }
  } catch {
    // A failed platform clone can leave a partial destination. Clear only the
    // caller-provided sandbox target, then use the portable implementation.
    await rm(target, { recursive: true, force: true });
  }
  await cp(source, target, {
    recursive: true,
    force: false,
    errorOnExist: false,
    verbatimSymlinks: true,
  });
}

/**
 * Copy a dependency/data path into a sandbox without retaining any symlink that
 * can resolve outside that sandbox. The outer source may itself be a worktree
 * symlink. Existing external targets are copied in; dangling external targets
 * remain dangling but are retargeted to a sandbox-local missing path.
 */
export async function copyIsolatedPath(
  source: string,
  target: string,
  sandboxRoot: string,
  label: string,
  exclude?: (path: string) => boolean,
): Promise<void> {
  if (exclude?.(label)) return;
  const physicalSource = await realpath(source);
  await mkdir(dirname(target), { recursive: true });
  await copyWithCloneFallback(physicalSource, target, exclude, label);
  // Always validate the destination tree. Even a previously sanitized snapshot
  // is mutable filesystem state; trusting it here would turn an intermediate
  // symlink change into a sandbox escape or unexpected dereference.
  await isolateCopiedTreeSymlinks(sandboxRoot, target, physicalSource, label, exclude);
}

async function isolateCopiedTreeSymlinks(
  sandboxRoot: string,
  current: string,
  sourceCurrent: string,
  label: string,
  exclude?: (path: string) => boolean,
): Promise<void> {
  const info = await lstat(current);
  if (info.isSymbolicLink()) {
    const linkTarget = await readlink(current);
    const lexicalTarget = resolve(dirname(current), linkTarget);
    const lexicalFromSandbox = relative(resolve(sandboxRoot), lexicalTarget);
    const lexicallyContained = lexicalFromSandbox !== '..'
      && !lexicalFromSandbox.startsWith(`..${sep}`)
      && !isAbsolute(lexicalFromSandbox);
    let copiedTarget: string | undefined;
    try {
      copiedTarget = await realpath(current);
    } catch {
      // Preserve an already-contained dangling link exactly. If a contained link
      // reaches an external dangling link through a chain, that external entry is
      // visited and neutralized separately during this same tree walk.
      if (lexicallyContained) return;
    }
    if (copiedTarget) {
      const fromSandbox = relative(resolve(sandboxRoot), copiedTarget);
      if (fromSandbox !== '..' && !fromSandbox.startsWith(`..${sep}`) && !isAbsolute(fromSandbox)) return;
    }

    // Virtualenv interpreters and file:/workspace dependencies can legitimately
    // point outside the copied dependency tree. Dereference those targets into
    // the sandbox so they remain usable without write-through access.
    let physicalTarget: string | undefined;
    try {
      physicalTarget = await realpath(sourceCurrent);
    } catch {
      const safeMissingTarget = join(sandboxRoot, '.git', 'openswarm-isolated-missing-target');
      const safeRelativeTarget = relative(dirname(current), safeMissingTarget);
      await rm(current, { force: true });
      await symlink(safeRelativeTarget, current);
      return;
    }
    await rm(current, { force: true });
    await copyWithCloneFallback(physicalTarget, current, exclude, label);
    await isolateCopiedTreeSymlinks(sandboxRoot, current, physicalTarget, label, exclude);
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of await readdir(current, { withFileTypes: true })) {
    // Dirent already tells us regular files cannot contain a symlink escape;
    // avoid an lstat syscall for every file in large node_modules trees.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    await isolateCopiedTreeSymlinks(
      sandboxRoot,
      join(current, entry.name),
      join(sourceCurrent, entry.name),
      `${label}/${entry.name}`,
      exclude,
    );
  }
}

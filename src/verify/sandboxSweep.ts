// ============================================
// OpenSwarm - Startup sweep of leftover verify sandboxes (AGT-4785)
// ============================================
//
// Each verify command clones the project into `$TMPDIR/.openswarm-verify-head-*`
// (and `.openswarm-verify-base-*` for the base comparison). The runner removes
// them on every exit path it controls, but a daemon killed mid-verify — a
// crash, a reboot, an OOM — leaves the whole clone behind, about 1 GB each on
// cgf-portal. On 2026-10-20 the host ran out of disk while copying git packs
// into exactly these directories, and nothing ever removed the leftovers.
//
// The sweep runs once at daemon start. It only removes sandboxes older than a
// generous age, because another process (a CLI run, a second daemon) may own a
// fresh one right now.
//
// Strict verification (the sandbox executor companion) makes its clones directly
// under the executor's allowed root that contains the project, not in $TMPDIR,
// so those roots are swept too.
//
// A base sandbox (and a strict head sandbox) is a `git worktree add` checkout. When `git worktree remove`
// fails the runner keeps the root on purpose, so the source repository's
// worktree metadata does not point at a deleted path. Deleting it here is still
// right (it is a stale 1 GB tree), and the metadata is pruned right after, but
// only when the repository's own back-pointer names this exact checkout: the
// `.git` pointer file sat inside the sandbox's writable root, so verified code
// could have rewritten it to aim `git worktree prune` at any repository.

import { execFile } from 'node:child_process';
import { lstat, readFile, readdir, realpath, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { getSandboxExecutorConfig } from '../sandboxExecutor/runtime.js';

const execFileAsync = promisify(execFile);

/** Directory names the verify runner creates with mkdtemp. */
export const VERIFY_SANDBOX_PATTERN = /^\.openswarm-verify-(?:head|base)-[A-Za-z0-9]+$/;

/** A verify run is bounded far below this; anything older has no live owner. */
export const DEFAULT_STALE_SANDBOX_AGE_MS = 6 * 60 * 60_000;

export interface VerifySandboxSweepResult {
  removed: string[];
  /** Matching sandboxes left alone because they are younger than the age floor. */
  keptFresh: number;
  failed: Array<{ path: string; error: string }>;
}

/**
 * Every directory the verify runner makes sandboxes in: the OS temp dir, and
 * each strict sandbox executor root (the runner's `sandboxScratchRoot` is the
 * allowed root that contains the project).
 */
export function verifySandboxScratchRoots(): string[] {
  return [...new Set([tmpdir(), ...(getSandboxExecutorConfig()?.allowedRoots ?? [])])];
}

/**
 * The repository a base sandbox's worktree belongs to, when the link is
 * confirmed from the repository side: `<repo>/.git/worktrees/<id>/gitdir`
 * must name this sandbox's `worktree/.git`. Anything else, including a
 * pointer the verified code rewrote, yields undefined.
 */
async function worktreeOwner(sandboxRoot: string): Promise<string | undefined> {
  const pointerFile = join(sandboxRoot, 'worktree', '.git');
  try {
    const info = await lstat(pointerFile);
    if (!info.isFile()) return undefined; // A cloned head has a .git directory, not a worktree pointer.
    const match = /^gitdir: (.+)$/m.exec(await readFile(pointerFile, 'utf8'));
    if (!match) return undefined;
    const adminDir = match[1].trim();
    if (basename(dirname(adminDir)) !== 'worktrees') return undefined;
    // An admin dir inside the sandbox is the sandbox's own forgery.
    const [realAdmin, realRoot] = await Promise.all([realpath(adminDir), realpath(sandboxRoot)]);
    if (realAdmin.startsWith(`${realRoot}${sep}`)) return undefined;
    const backPointer = (await readFile(join(adminDir, 'gitdir'), 'utf8')).trim();
    if (await realpath(backPointer) !== await realpath(pointerFile)) return undefined;
    return dirname(dirname(adminDir)); // the repository's common git dir
  } catch { // cxt-ignore: error_swallow — an unconfirmed pointer just means no prune
    return undefined;
  }
}

export async function sweepStaleVerifySandboxes(options: {
  /** One directory to sweep; the default is every {@link verifySandboxScratchRoots} entry. */
  root?: string;
  roots?: readonly string[];
  olderThanMs?: number;
  now?: number;
} = {}): Promise<VerifySandboxSweepResult> {
  const roots = options.roots ?? (options.root ? [options.root] : verifySandboxScratchRoots());
  const result: VerifySandboxSweepResult = { removed: [], keptFresh: 0, failed: [] };
  for (const root of new Set(roots)) await sweepRoot(root, options, result);
  return result;
}

async function sweepRoot(
  root: string,
  options: { olderThanMs?: number; now?: number },
  result: VerifySandboxSweepResult,
): Promise<void> {
  const olderThanMs = options.olderThanMs ?? DEFAULT_STALE_SANDBOX_AGE_MS;
  const now = options.now ?? Date.now();
  let names: string[];
  try {
    names = await readdir(root);
  } catch { // cxt-ignore: error_swallow — an unreadable scratch root has nothing to sweep
    return;
  }

  for (const name of names) {
    if (!VERIFY_SANDBOX_PATTERN.test(name)) continue;
    const path = join(root, name);
    try {
      const info = await lstat(path);
      // Never follow a link out of the scratch directory.
      if (!info.isDirectory() || info.isSymbolicLink()) continue;
      if (now - info.mtimeMs < olderThanMs) {
        result.keptFresh += 1;
        continue;
      }
      const owner = await worktreeOwner(path);
      // A killed run can leave the uv cache overlay's mode-000 `work/work`, which rm cannot enter.
      await rmdir(join(path, 'uv-cache', 'work', 'work')).catch(() => undefined);
      await rm(path, { recursive: true, force: true });
      result.removed.push(path);
      // Drop the now-dangling worktree entry the runner preserved the root for.
      if (owner) await execFileAsync('git', ['--git-dir', owner, 'worktree', 'prune'], { timeout: 30_000 });
    } catch (error) {
      result.failed.push({ path, error: error instanceof Error ? error.message : String(error) });
    }
  }
}

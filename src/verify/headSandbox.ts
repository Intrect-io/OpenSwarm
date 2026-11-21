// Created: 2026-11-22
// Purpose: Strict-companion head sandbox as a detached git worktree, with a full-copy fallback and worktree-aware cleanup (AGT-4785).
// Dependencies: ./git.js, ../sandboxExecutor/bubblewrap.js
// Test Status: covered by runner.strictHead.test.ts and runner.diskFootprint.test.ts

import { realpath, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { commonGitMountable, validatedGitCommonDirectory } from '../sandboxExecutor/bubblewrap.js';
import { git } from './git.js';

/**
 * Remove a registered worktree and prune its metadata. Returns false when the
 * remove failed: the caller must then keep the root, so Git metadata does not
 * point at a deleted path (the startup sweep prunes it later).
 */
export async function removeVerifyWorktree(projectPath: string, worktreePath: string, label: string): Promise<boolean> {
  try {
    await git(projectPath, ['worktree', 'remove', '--force', worktreePath]);
  } catch (error) {
    console.warn(`[Verify] Failed to remove ${label} worktree ${worktreePath}:`, error);
    return false;
  }
  await git(projectPath, ['worktree', 'prune']).catch((error) => {
    console.warn(`[Verify] git worktree prune failed after removing ${worktreePath}:`, error);
  });
  return true;
}

/** A head worktree whose rollback failed; its path may still be registered with Git. */
export class HeadWorktreeRollbackError extends Error {
  constructor(readonly worktree: string) {
    super(`[Verify] could not roll back head worktree ${worktree}`);
    this.name = 'HeadWorktreeRollbackError';
  }
}

/** The worktree a failed head build left registered, so its release preserves on a failed remove. */
export function strandedHeadWorktree(error: unknown): string | undefined {
  return error instanceof HeadWorktreeRollbackError ? error.worktree : undefined;
}

/** Release a head sandbox root; a worktree head is unregistered first. */
export async function releaseHeadSandbox(projectPath: string, root: string, worktree?: string): Promise<void> {
  if (worktree && !(await removeVerifyWorktree(projectPath, worktree, 'head'))) {
    console.warn(`[Verify] Preserving ${root} so Git worktree metadata does not point at a deleted path.`);
    return;
  }
  await rm(root, { recursive: true, force: true });
}

async function sourceCommonGitDir(projectPath: string): Promise<string> {
  const raw = await git(projectPath, ['rev-parse', '--git-common-dir']);
  return await realpath(isAbsolute(raw) ? raw : resolve(projectPath, raw));
}

/**
 * Build the strict head at `project` as `git worktree add --detach`. The companion
 * serves its objects through the read-only common-dir mount, so nothing is copied.
 * Returns undefined on success, or the reason the caller must fall back to a full
 * copy. On a fallback `project` no longer exists and no worktree is registered.
 */
export async function addStrictHeadWorktree(
  projectPath: string, project: string, headCommit: string, allowedRoots: readonly string[],
): Promise<string | undefined> {
  if (allowedRoots.length === 0) return 'no strict sandbox scratch root';
  // Cheap precheck on the source's common dir; the post-add check below decides.
  let sourceCommon: string;
  try {
    sourceCommon = await sourceCommonGitDir(projectPath);
  } catch (error) {
    return `cannot resolve the git common dir: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!commonGitMountable(project, sourceCommon, allowedRoots)) {
    return `common git dir ${sourceCommon} is not mountable by the companion`;
  }
  let reason: string | undefined;
  try {
    await git(projectPath, ['worktree', 'add', '--detach', project, headCommit]);
    // Authority: exactly what the companion validates and mounts at execution time.
    const common = await validatedGitCommonDirectory(project);
    if (common === sourceCommon && commonGitMountable(project, common, allowedRoots)) return undefined;
    reason = `companion would not mount the worktree's common git dir (${common ?? 'unvalidated'})`;
  } catch (error) {
    reason = `git worktree add failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  // Roll back a partial or rejected worktree before the caller clones into the same path.
  // Twice --force also removes an add killed while still holding its initializing lock.
  await git(projectPath, ['worktree', 'remove', '--force', '--force', project]).catch(() => undefined);
  try {
    await rm(project, { recursive: true, force: true });
  } catch {
    // A half-removed path is reported below; the release then keeps the root.
  }
  await git(projectPath, ['worktree', 'prune']).catch(() => undefined);
  if (existsSync(project)) throw new HeadWorktreeRollbackError(project);
  return reason;
}

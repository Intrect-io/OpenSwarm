/** Git index ops for ephemeral worktree artifact purge. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { isEphemeralWorktreeArtifact, ephemeralPathspecRoots } from './worktreeEphemeral.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;
const PRESERVE_MARKER = '.openswarm-preserved';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

async function stripRuntimeMarkerFromGit(worktreePath: string): Promise<void> {
  const markerPath = join(worktreePath, PRESERVE_MARKER);
  try { rmSync(markerPath, { force: true }); } catch { /* git cleanup below still runs */ }
  await git(worktreePath, 'rm', '--cached', '--ignore-unmatch', '--', PRESERVE_MARKER).catch(() => '');
}

export async function forceRemoveFromIndex(worktreePath: string, files: string[]): Promise<void> {
  if (files.length === 0) return;
  // Directory pathspecs beat hundreds of long unicode paths: on cgf-portal
  // AX-855, `update-index --force-remove -- <245 files>` left the index
  // unchanged while `git rm -r --cached -- .trash/pytest-of-…` removed them.
  const roots = ephemeralPathspecRoots(files);
  for (const root of roots) {
    await git(worktreePath, 'rm', '-r', '--cached', '--ignore-unmatch', '-q', '--', root).catch(async () => {
      await git(worktreePath, 'update-index', '--force-remove', '--', root).catch(() => '');
    });
  }
}

/**
 * Stage only recoverable source edits for the automatic WIP checkpoint.
 *
 * `git add -A` can otherwise commit a linked virtualenv and pytest's per-run
 * directory. Artifacts from an older WIP commit get an index-only removal, so
 * the branch is repaired without deleting shared/test files from disk.
 */
export async function stagePreservableWorktreeChanges(worktreePath: string): Promise<void> {
  await stripRuntimeMarkerFromGit(worktreePath);
  await git(worktreePath, 'add', '-A');
  const staged = (await git(worktreePath, 'diff', '--cached', '--name-only'))
    .split('\n').filter(Boolean);
  const artifacts = staged.filter(isEphemeralWorktreeArtifact);
  if (artifacts.length === 0) return;

  // reset pathspecs in root batches — same ARG/encoding hazard as update-index.
  for (const root of ephemeralPathspecRoots(artifacts)) {
    await git(worktreePath, 'reset', '-q', '--', root).catch(() => '');
  }
  const trackedInHead: string[] = [];
  for (const file of artifacts) {
    if (await git(worktreePath, 'cat-file', '-e', `HEAD:${file}`).then(() => true).catch(() => false)) {
      trackedInHead.push(file);
    }
  }
  await forceRemoveFromIndex(worktreePath, trackedInHead);
}

/** Remove legacy runtime artifacts from a previously preserved branch before it can publish. */
export async function purgeTrackedEphemeralArtifacts(worktreePath: string): Promise<void> {
  const tracked = (await git(worktreePath, 'ls-tree', '-r', '--name-only', 'HEAD'))
    .split('\n').filter(isEphemeralWorktreeArtifact);
  if (tracked.length === 0) return;

  // Index-only removal leaves shared virtualenvs and pytest scratch output on
  // disk for the active process, but records the deletion on the task branch.
  // Preserve any unrelated staged source edit for the normal WIP checkpoint;
  // `git commit -- <path>` re-reads an existing worktree path and cannot commit
  // this index-only deletion when that path is now intentionally untracked.
  const stagedSource = (await git(worktreePath, 'diff', '--cached', '--name-only'))
    .split('\n').filter((file) => file && !isEphemeralWorktreeArtifact(file));
  if (stagedSource.length > 0) await git(worktreePath, 'restore', '--staged', '--', ...stagedSource);
  await forceRemoveFromIndex(worktreePath, tracked);
  const stagedAfter = (await git(worktreePath, 'diff', '--cached', '--name-only'))
    .split('\n').filter(Boolean);
  if (stagedAfter.length === 0) return;
  try {
    await git(
      worktreePath,
      '-c', 'user.email=swarm@openswarm.local', '-c', 'user.name=OpenSwarm',
      'commit', '--no-verify', '-m', 'wip: remove ephemeral runtime artifacts (auto)',
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Empty commit after a concurrent cleaner is not an infra failure.
    if (/nothing to commit|nothing added to commit/i.test(msg)) return;
    throw err;
  }
  console.log(`[Worktree] Removed ${tracked.length} legacy runtime artifact(s) from WIP branch: ${worktreePath}`);
}

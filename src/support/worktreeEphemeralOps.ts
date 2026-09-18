/** Git index ops for ephemeral worktree artifact purge. */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { rmSync } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { isEphemeralWorktreeArtifact, isAgentScratchFile, ephemeralPathspecRoots } from './worktreeEphemeral.js';
import { isSymlinkMode, symlinkTargetEscapes } from './escapingSymlink.js';
import { rejectedWorkerPaths } from './rejectedWorkerPaths.js';

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
  await unstageAgentScratchAdditions(worktreePath);
  await unstageEscapingSymlinkAdditions(worktreePath);
  await unstageRejectedWorkerAdditions(worktreePath);
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

/**
 * Drop what the worker-scope fence rejected from what `add -A` just staged —
 * additions only.
 *
 * The fence discards the iteration; the file it wrote stays on disk and lands
 * on the branch at the next preserve commit. Nothing downstream can tell that
 * file apart by name or mode, so the verdict has to be carried forward — see
 * `rejectedWorkerPaths.ts` for why it is carried in-process (AGT-4440).
 *
 * Additions only, by the AGT-4410 rule: a path the branch already tracks is
 * the repository's own file, not this iteration's leftover, and unstaging it
 * would silently revert a real edit. Index-only — never deleted from disk,
 * because a later iteration may be mid-write on the same path.
 */
export async function unstageRejectedWorkerAdditions(worktreePath: string): Promise<string[]> {
  const rejected = new Set(rejectedWorkerPaths(worktreePath));
  if (rejected.size === 0) return [];
  // `-z` for the same reason as the scratch filter: cgf-portal tracks Korean
  // file names, and a quoted path builds a pathspec that matches nothing.
  const records = (await git(worktreePath, 'diff', '--cached', '--name-status', '--diff-filter=A', '-z'))
    .split('\0');
  const added: string[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const file = records[i + 1];
    if (file && rejected.has(file)) added.push(file);
  }
  if (added.length === 0) return [];
  console.warn(
    `[Worktree] Leaving ${added.length} file(s) the worker-scope fence rejected out of the commit `
    + `— a discarded iteration's leftovers are not task source (AGT-4440): ${added.join(', ')}`,
  );
  await git(worktreePath, 'reset', '-q', '--', ...added);
  return added;
}

/**
 * Untracked paths the commit path would refuse, so a viewer can leave them out.
 *
 * The reviewer's diff includes untracked files, because a worker's brand-new
 * file stays untracked until the preserve commit and a changed-file list with
 * no patch behind it tells a reviewer nothing (AGT-4443). That also pulled in
 * material nobody authored: the machine-local `node_modules` symlink a worktree
 * mount creates appeared as a change, and a live reviewer spent 4 of its 71
 * tool calls chasing it. The wasted turns are the cheap part — the risk is a
 * REVISE against a worker for a link the worktree layer made.
 *
 * The judgement here is the staging path's, not a second opinion: the same
 * three predicates that keep a path out of the commit keep it out of the diff,
 * so the two cannot drift into disagreeing about what counts as the worker's
 * work. (AGT-4447)
 */
export async function refusedUntrackedPaths(worktreePath: string): Promise<string[]> {
  const root = await realpath(worktreePath).catch(() => worktreePath);
  // `--exclude-standard` honours .gitignore, so this is the same set `add -A`
  // would stage; `-z` keeps a non-ASCII path unquoted (cgf-portal tracks
  // Korean file names).
  const listed = await git(worktreePath, 'ls-files', '--others', '--exclude-standard', '-z')
    .catch(() => '');
  const files = listed.split('\0').filter(Boolean);
  if (files.length === 0) return [];
  const rejected = new Set(rejectedWorkerPaths(worktreePath));
  const refused: string[] = [];
  for (const file of files) {
    if (isAgentScratchFile(file) || rejected.has(file)) {
      refused.push(file);
      continue;
    }
    // Untracked, so there is no index mode to read: ask the filesystem.
    const linkPath = join(root, file);
    const stat = await lstat(linkPath).catch(() => undefined);
    if (!stat?.isSymbolicLink()) continue;
    const target = await readlink(linkPath).catch(() => '');
    if (target && symlinkTargetEscapes({ root, linkPath, target })) refused.push(file);
  }
  return refused;
}

/**
 * Drop the agent's scratch files from what `add -A` just staged — additions
 * only. A scratch-shaped path the branch already tracks is the repository's
 * own file and stays exactly as staged (AGT-4410).
 */
export async function unstageAgentScratchAdditions(worktreePath: string): Promise<string[]> {
  // `-z`: NUL-separated `status\0path\0` records, so a non-ASCII path (cgf-portal
  // tracks Korean file names) is not returned quoted and escaped, which a
  // pathspec built from it would then fail to match.
  const records = (await git(worktreePath, 'diff', '--cached', '--name-status', '--diff-filter=A', '-z'))
    .split('\0');
  const added: string[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const file = records[i + 1];
    if (file && isAgentScratchFile(file)) added.push(file);
  }
  if (added.length === 0) return [];
  console.warn(
    `[Worktree] Leaving ${added.length} agent scratch file(s) out of the commit — a backup or `
    + `one-off edit script is not task source (AGT-4410): ${added.join(', ')}`,
  );
  await git(worktreePath, 'reset', '-q', '--', ...added);
  return added;
}

/**
 * Drop newly added symlinks whose target escapes the worktree — additions only.
 *
 * `git add -A` stages a link the same way it stages a file, and a worktree is
 * set up with local-asset links: cgf-portal's `post-checkout` hook runs
 * `scripts/dev/link-local-assets.sh`, and this harness links `node_modules`
 * from the main checkout. Whether git ignores such a link is an accident of
 * the repository's own pattern — `node_modules` matches a link, `node_modules/`
 * matches only a directory — so cgf-portal staged
 * `apps/portal/node_modules` → `/Users/unohee/dev/cgf-portal/apps/portal/node_modules`
 * into the AX-1556 branch and the publication fence then refused the branch
 * (AGT-4431). The operator had already stripped this class of link out of one
 * hand PR.
 *
 * A link the branch already tracks is the repository's own file and stays, by
 * the AGT-4410 rule. The target is read from the staged blob rather than from
 * disk, so the decision holds even after a later cleanup removed the link.
 */
export async function unstageEscapingSymlinkAdditions(worktreePath: string): Promise<string[]> {
  const root = await realpath(worktreePath).catch(() => worktreePath);
  // `--raw -z`: `:<old-mode> <new-mode> <old-sha> <new-sha> <status>\0<path>\0`.
  // The mode comes from the index, so a link is identified without a stat, and
  // `-z` keeps a non-ASCII path unquoted (cgf-portal tracks Korean names).
  const records = (await git(worktreePath, 'diff', '--cached', '--raw', '-z', '--diff-filter=A'))
    .split('\0');
  const escaping: string[] = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const meta = records[i];
    const file = records[i + 1];
    if (!meta || !file) continue;
    const newMode = meta.split(' ')[1];
    if (!newMode || !isSymlinkMode(newMode)) continue;
    const target = (await git(worktreePath, 'show', `:${file}`).catch(() => '')).trim();
    if (!target) continue;
    if (symlinkTargetEscapes({ root, linkPath: join(root, file), target })) escaping.push(file);
  }
  if (escaping.length === 0) return [];
  console.warn(
    `[Worktree] Leaving ${escaping.length} escaping symlink(s) out of the commit — the target is `
    + `outside this worktree, so the branch would carry a dangling link on any other machine `
    + `(AGT-4431): ${escaping.join(', ')}`,
  );
  await git(worktreePath, 'reset', '-q', '--', ...escaping);
  return escaping;
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

// ============================================
// OpenSwarm - Adaptive worker fan-out
// ============================================
//
// Runs candidate workers in isolated temporary git clones and promotes only the
// selected winner's diff back into the real project path.

import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync } from 'node:fs';
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readlink, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import type { WorkerFanoutCandidateConfig, PipelineGuardsConfig } from '../core/types.js';
import { runPool } from '../support/concurrencyPool.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { copyIsolatedPath } from '../support/isolatedPath.js';
import { resolveSharedPaths } from '../support/worktreeManager.js';
import type { WorkerResult } from './agentPair.js';
import { runWorker, type WorkerOptions } from './worker.js';
import { runGuards, type GuardsRunResult } from './pipelineGuards.js';

const exec = promisify(execFile);

export interface WorkerFanoutCandidateRun {
  id: string;
  projectPath: string;
  result: WorkerResult;
  filesChanged: string[];
  guards?: GuardsRunResult;
  durationMs: number;
  score: number;
  eligible: boolean;
  error?: string;
  /** Shared dependency/data paths injected by the harness, never candidate edits. */
  linkedSharedPaths?: string[];
}

export interface WorkerFanoutRunResult {
  winner?: WorkerFanoutCandidateRun;
  candidates: WorkerFanoutCandidateRun[];
  fallbackReason?: string;
}

export interface RunWorkerFanoutOptions {
  projectPath: string;
  baseWorkerOptions: WorkerOptions;
  candidates: WorkerFanoutCandidateConfig[];
  concurrency: number;
  keepSandboxes?: boolean;
  /**
   * Shared deps/data handling:
   * - undefined: copy shared paths into each sandbox (verification works, no loser write leak)
   * - true: symlink shared paths (faster, but writes hit the original shared path)
   * - false: do not provide shared paths
   */
  linkSharedPaths?: boolean;
  guards?: Partial<PipelineGuardsConfig>;
  onLog?: (line: string) => void;
}

export interface SharedPathSnapshot {
  root: string;
  relativePaths: string[];
}

function safeCandidateId(id: string, index: number): string {
  const safe = id.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return safe || `candidate-${index + 1}`;
}

// git clone (used for sandbox seeding) can stall; bound it so a hung clone becomes
// an infra timeout instead of wedging the fan-out. (INT-2521)
const FANOUT_GIT_TIMEOUT_MS = 5 * 60_000;

async function git(cwd: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    encoding: 'utf8',
    env: opts?.env,
    maxBuffer: 20 * 1024 * 1024,
    timeout: FANOUT_GIT_TIMEOUT_MS,
  } as Parameters<typeof exec>[2]);
  return String(stdout);
}

/**
 * Untracked files above this size are artifacts (build output, media, vendored
 * bundles, trashed copies), not in-flight source edits. Seeding them copies the
 * same bytes into every sandbox for no fix value, so they stay out of the
 * baseline. Tracked modifications are always seeded, whatever their size.
 */
export const BASELINE_UNTRACKED_FILE_LIMIT_BYTES = 2 * 1024 * 1024;

/** Where the captured baseline lives, plus what it deliberately left out. */
export interface BaselinePatch {
  /** Patch file path, or '' when there is nothing uncommitted to seed. */
  path: string;
  /** Untracked files excluded by BASELINE_UNTRACKED_FILE_LIMIT_BYTES. */
  skippedUntracked: string[];
}

/** A baseline that seeds nothing — clean worktree, or capture failed. */
export function emptyBaselinePatch(): BaselinePatch {
  return { path: '', skippedUntracked: [] };
}

/**
 * Run git with stdout streamed straight to a file. `git diff --binary` over a
 * dirty tree carrying large untracked artifacts reaches hundreds of MB; buffering
 * that through execFile dies with "stdout maxBuffer length exceeded" and takes
 * the whole fix/fan-out run down with it. (INT-3098)
 */
async function gitToFile(
  cwd: string,
  args: string[],
  destPath: string,
  opts?: { env?: NodeJS.ProcessEnv },
): Promise<void> {
  const child = spawn('git', args, {
    cwd,
    env: opts?.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: FANOUT_GIT_TIMEOUT_MS,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    if (stderr.length < 8_192) stderr += chunk;
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once('error', rejectExit);
    child.once('close', (code, signal) => resolveExit({ code, signal }));
  });
  try {
    await streamPipeline(child.stdout, createWriteStream(destPath));
  } catch (error) {
    child.kill('SIGKILL');
    await exited.catch(() => undefined);
    throw error;
  }
  const { code, signal } = await exited;
  if (code !== 0) {
    throw new Error(`git ${args.join(' ')} failed${signal ? ` (${signal})` : ''}: ${stderr.trim()}`.trim());
  }
}

/**
 * Unstage untracked additions that are too big to be worth seeding, and report
 * them. They stay untouched on disk in the project — only the temporary index
 * (and therefore the baseline patch) drops them.
 */
async function dropOversizedUntracked(projectPath: string, env: NodeJS.ProcessEnv): Promise<string[]> {
  const added = await git(projectPath, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z', 'HEAD'], { env })
    .catch(() => '');
  const oversized: string[] = [];
  for (const rel of added.split('\0').filter(Boolean)) {
    const info = await stat(resolve(projectPath, rel)).catch(() => null);
    if (info?.isFile() && info.size > BASELINE_UNTRACKED_FILE_LIMIT_BYTES) oversized.push(rel);
  }
  // Chunked: a repository can hold thousands of these, and one argv has a limit.
  for (let i = 0; i < oversized.length; i += 100) {
    await git(projectPath, ['rm', '--cached', '--quiet', '-r', '--ignore-unmatch', '--', ...oversized.slice(i, i + 100)], { env });
  }
  return oversized;
}

// Capture ALL uncommitted work in the project (tracked edits, deletions, and
// untracked new files) as a binary patch vs HEAD, WITHOUT mutating the project's
// real index or worktree — everything is staged into a throwaway temporary index
// selected via GIT_INDEX_FILE. The patch is written to `destPath`; a clean
// worktree yields no file and `{ path: '' }`. This lets fan-out run on a dirty
// tree (e.g. a self-repair retry that still holds the previous iteration's
// edits) by seeding that state into each sandbox.
export async function captureBaselinePatch(projectPath: string, destPath: string): Promise<BaselinePatch> {
  const idxDir = await mkdtemp(join(tmpdir(), 'openswarm-fanout-idx-'));
  const env = { ...process.env, GIT_INDEX_FILE: join(idxDir, 'index') };
  try {
    await git(projectPath, ['add', '-A'], { env });
    let metadata = null;
    try { metadata = await loadRepoMetadata(projectPath); } catch { metadata = null; }
    const injectedUntracked: string[] = [];
    for (const rel of resolveSharedPaths(projectPath, metadata)) {
      const tracked = await git(projectPath, ['ls-files', '--error-unmatch', '--', rel])
        .then(() => true)
        .catch(() => false);
      if (!tracked) injectedUntracked.push(rel);
    }
    if (injectedUntracked.length > 0) {
      // A worktree's injected dependency path may be a symlink. A trailing-slash
      // gitignore rule does not match that symlink, so the temporary index would
      // otherwise capture it and seedBaseline would collide with the sandbox's
      // isolated dependency copy. Shared untracked paths are harness inputs, not
      // candidate source state.
      // Some shared paths (the normal node_modules/.venv case) are ignored and
      // therefore absent from the temporary index. `git reset HEAD -- <path>`
      // rejects those missing pathspecs and used to abort fan-out before any
      // candidate ran. `git rm --ignore-unmatch` removes an accidentally staged
      // symlink/directory while treating the normal absent case as a no-op.
      await git(projectPath, ['rm', '--cached', '--quiet', '-r', '--ignore-unmatch', '--', ...injectedUntracked], { env });
    }
    const skippedUntracked = await dropOversizedUntracked(projectPath, env);
    await gitToFile(projectPath, ['diff', '--cached', '--binary', 'HEAD'], destPath, { env });
    const written = await stat(destPath).catch(() => null);
    if (!written || written.size === 0) {
      await rm(destPath, { force: true });
      return { path: '', skippedUntracked };
    }
    return { path: destPath, skippedUntracked };
  } finally {
    await rm(idxDir, { recursive: true, force: true });
  }
}

export async function cloneSandbox(
  projectPath: string,
  root: string,
  id: string,
  sharedPathMode: 'copy' | 'link' | 'off',
  sharedPathSnapshot?: SharedPathSnapshot,
): Promise<{ sandbox: string; linkedSharedPaths: string[] }> {
  const sandbox = join(root, id);
  await git(projectPath, ['clone', '--quiet', '--no-hardlinks', '--', projectPath, sandbox]);
  const linkedSharedPaths = sharedPathMode === 'link'
    ? await linkSharedPaths(projectPath, sandbox)
    : sharedPathMode === 'copy'
      ? sharedPathSnapshot
        ? await copySharedPathSnapshot(sharedPathSnapshot, sandbox)
        : await copySharedPaths(projectPath, sandbox)
      : [];
  return { sandbox, linkedSharedPaths };
}

async function linkSharedPaths(projectPath: string, sandboxPath: string): Promise<string[]> {
  let metadata = null;
  try {
    metadata = await loadRepoMetadata(projectPath);
  } catch {
    metadata = null;
  }

  const linked: string[] = [];
  for (const rel of resolveSharedPaths(projectPath, metadata)) {
    const target = resolve(projectPath, rel);
    const linkPath = resolve(sandboxPath, rel);
    if (existsSync(linkPath)) continue;
    await mkdir(dirname(linkPath), { recursive: true });
    await symlink(target, linkPath);
    linked.push(rel);
  }
  return linked;
}

async function copySharedPaths(projectPath: string, sandboxPath: string): Promise<string[]> {
  let metadata = null;
  try {
    metadata = await loadRepoMetadata(projectPath);
  } catch {
    metadata = null;
  }

  const copied: string[] = [];
  for (const rel of resolveSharedPaths(projectPath, metadata)) {
    const source = resolve(projectPath, rel);
    const target = resolve(sandboxPath, rel);
    if (existsSync(target)) continue;
    await copyIsolatedPath(source, target, sandboxPath, rel);
    copied.push(rel);
  }
  return copied;
}

/**
 * Resolve and isolate shared dependencies once per worker batch. Sandboxes can
 * then use filesystem clones of this trusted snapshot without repeatedly
 * walking the original dependency tree or re-resolving external symlinks.
 */
export async function createSharedPathSnapshot(
  projectPath: string,
  snapshotRoot: string,
): Promise<SharedPathSnapshot> {
  await mkdir(snapshotRoot, { recursive: true });
  return {
    root: snapshotRoot,
    relativePaths: await copySharedPaths(projectPath, snapshotRoot),
  };
}

async function copySharedPathSnapshot(snapshot: SharedPathSnapshot, sandboxPath: string): Promise<string[]> {
  const copied: string[] = [];
  for (const rel of snapshot.relativePaths) {
    const source = resolve(snapshot.root, rel);
    const target = resolve(sandboxPath, rel);
    if (existsSync(target)) continue;
    await copyIsolatedPath(source, target, sandboxPath, rel);
    copied.push(rel);
  }
  return copied;
}

function sharedPathModeFor(linkSharedPaths: boolean | undefined): 'copy' | 'link' | 'off' {
  if (linkSharedPaths === true) return 'link';
  if (linkSharedPaths === false) return 'off';
  return 'copy';
}

export async function changedFiles(projectPath: string, ignoredPaths: string[] = []): Promise<string[]> {
  const out = await git(projectPath, ['status', '--porcelain']).catch(() => '');
  return out
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const file = line.slice(3);
      return file.includes(' -> ') ? file.split(' -> ').pop() ?? file : file;
    })
    .filter((file) => Boolean(file) && !ignoredPaths.some((ignored) => file === ignored || file.startsWith(`${ignored}/`)));
}

/**
 * The winner's changes relative to the seeded base (sandbox HEAD): tracked
 * add/modify/delete/rename plus untracked new files. NUL-delimited so paths with
 * spaces/newlines survive. Returns { write } (paths whose content to copy from
 * the sandbox) and { remove } (paths to delete from the project).
 */
async function winnerChangeSet(sandbox: string, ignoredPaths: string[] = []): Promise<{ write: string[]; remove: string[] }> {
  const write = new Set<string>();
  const remove = new Set<string>();

  const nameStatus = await git(sandbox, ['diff', '--name-status', '-z', 'HEAD']);
  const tokens = nameStatus.split('\0').filter(Boolean);
  for (let i = 0; i < tokens.length; ) {
    const status = tokens[i];
    if (status.startsWith('R') || status.startsWith('C')) {
      // rename/copy: <status>\t?<src>\0<dst>\0 → src removed, dst written
      const src = tokens[i + 1];
      const dst = tokens[i + 2];
      if (status.startsWith('R') && src) remove.add(src);
      if (dst) write.add(dst);
      i += 3;
    } else {
      const path = tokens[i + 1];
      if (path) (status === 'D' ? remove : write).add(path);
      i += 2;
    }
  }

  const untracked = await git(sandbox, ['ls-files', '--others', '--exclude-standard', '-z']);
  for (const p of untracked.split('\0').filter(Boolean)) write.add(p);

  const included = (path: string) => !ignoredPaths.some((ignored) => path === ignored || path.startsWith(`${ignored}/`));
  return { write: [...write].filter(included), remove: [...remove].filter(included) };
}

/**
 * Return the complete incremental sandbox delta, including both sides of a
 * rename. Fix-unit scope checks use this instead of `git status` so a deleted or
 * renamed source path cannot disappear from validation.
 */
export async function sandboxChangedFiles(sandbox: string, ignoredPaths: string[] = []): Promise<string[]> {
  const { write, remove } = await winnerChangeSet(sandbox, ignoredPaths);
  return [...new Set([...write, ...remove])].sort();
}

function assertSafeSandboxPath(path: string): void {
  if (!path || path.includes('\0') || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new Error(`unsafe sandbox path: ${JSON.stringify(path)}`);
  }
}

function containedSandboxPath(root: string, path: string): string {
  assertSafeSandboxPath(path);
  const canonicalRoot = resolve(root);
  const target = resolve(canonicalRoot, path);
  const fromRoot = relative(canonicalRoot, target);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`unsafe sandbox path escapes repository: ${JSON.stringify(path)}`);
  }
  return target;
}

async function assertNoSymlinkAncestors(root: string, path: string): Promise<void> {
  const canonicalRoot = resolve(root);
  const parts = path.split(/[\\/]/).filter(Boolean);
  let current = canonicalRoot;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink()) {
        throw new Error(`unsafe sandbox path traverses symlink: ${JSON.stringify(path)}`);
      }
      if (!info.isDirectory()) {
        throw new Error(`unsafe sandbox path traverses non-directory: ${JSON.stringify(path)}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
}

function assertSafeRepositorySymlink(root: string, path: string, target: string): void {
  if (isAbsolute(target)) {
    throw new Error(`unsafe sandbox symlink has absolute target: ${JSON.stringify(path)}`);
  }
  const canonicalRoot = resolve(root);
  const resolvedTarget = resolve(dirname(containedSandboxPath(root, path)), target);
  const fromRoot = relative(canonicalRoot, resolvedTarget);
  if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`unsafe sandbox symlink escapes repository: ${JSON.stringify(path)}`);
  }
}

interface SandboxBaseEntry {
  mode: string;
  type: string;
  objectId: string;
}

async function sandboxBaseEntry(sandbox: string, path: string): Promise<SandboxBaseEntry | undefined> {
  const output = await git(sandbox, ['ls-tree', '-z', 'HEAD', '--', path]);
  if (!output) return undefined;
  const tab = output.indexOf('\t');
  const header = (tab >= 0 ? output.slice(0, tab) : output).trim().split(/\s+/);
  if (header.length !== 3) throw new Error(`could not inspect sandbox base entry: ${JSON.stringify(path)}`);
  return { mode: header[0], type: header[1], objectId: header[2] };
}

async function assertProjectMatchesSandboxBase(projectPath: string, sandbox: string, path: string): Promise<void> {
  const expected = await sandboxBaseEntry(sandbox, path);
  const destination = containedSandboxPath(projectPath, path);
  const actual = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (!expected) {
    if (actual) throw new Error(`project changed while sandbox worker ran: ${JSON.stringify(path)} was created`);
    return;
  }
  if (expected.type !== 'blob') {
    throw new Error(`unsupported sandbox base entry type for promotion: ${expected.type} ${JSON.stringify(path)}`);
  }
  const expectedSymlink = expected.mode === '120000';
  if (!actual
    || (expectedSymlink && !actual.isSymbolicLink())
    || (!expectedSymlink && !actual.isFile())) {
    throw new Error(`project changed while sandbox worker ran: ${JSON.stringify(path)} changed type or disappeared`);
  }
  if (!expectedSymlink && (expected.mode === '100755') !== Boolean(actual.mode & 0o111)) {
    throw new Error(`project changed while sandbox worker ran: ${JSON.stringify(path)} changed executable mode`);
  }
  let objectId: string;
  if (expectedSymlink) {
    // git hash-object follows a worktree symlink, while Git stores the link text
    // itself as the blob. Recreate the object hash without dereferencing it.
    const target = await readlink(destination, { encoding: 'buffer' });
    const format = (await git(projectPath, ['rev-parse', '--show-object-format'])).trim();
    objectId = createHash(format)
      .update(`blob ${target.byteLength}\0`)
      .update(target)
      .digest('hex');
  } else {
    objectId = (await git(projectPath, ['hash-object', `--path=${path}`, '--', path])).trim();
  }
  if (objectId !== expected.objectId) {
    throw new Error(`project changed while sandbox worker ran: ${JSON.stringify(path)} changed content`);
  }
}

export interface PromotionHooks {
  /** Test/observability seam invoked immediately before each destination write. */
  beforeWrite?: (relativePath: string, index: number) => Promise<void> | void;
  /** Test/observability seam invoked immediately before each destination removal. */
  beforeRemove?: (relativePath: string, index: number) => Promise<void> | void;
}

type PromotionBackup =
  | { dst: string; kind: 'absent' }
  | { dst: string; kind: 'symlink'; target: string }
  | { dst: string; kind: 'file' | 'directory'; backupPath: string; mode: number };

async function removeExistingEntry(path: string): Promise<void> {
  const existing = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
  if (existing) await rm(path, { recursive: existing.isDirectory(), force: true });
}

async function capturePromotionBackups(destinations: string[], backupRoot: string): Promise<PromotionBackup[]> {
  const backups: PromotionBackup[] = [];
  for (const [index, dst] of destinations.entries()) {
    const info = await lstat(dst).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
    if (!info) {
      backups.push({ dst, kind: 'absent' });
      continue;
    }
    if (info.isSymbolicLink()) {
      backups.push({ dst, kind: 'symlink', target: await readlink(dst) });
      continue;
    }
    if (!info.isFile() && !info.isDirectory()) {
      throw new Error(`unsupported promotion destination type: ${JSON.stringify(dst)}`);
    }
    const backupPath = join(backupRoot, String(index));
    if (info.isDirectory()) {
      await cp(dst, backupPath, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
      backups.push({ dst, kind: 'directory', backupPath, mode: info.mode & 0o7777 });
    } else {
      await copyFile(dst, backupPath);
      backups.push({ dst, kind: 'file', backupPath, mode: info.mode & 0o7777 });
    }
  }
  return backups;
}

async function restorePromotionBackups(backups: PromotionBackup[]): Promise<void> {
  for (const backup of [...backups].reverse()) {
    await removeExistingEntry(backup.dst);
    if (backup.kind === 'absent') continue;
    await mkdir(dirname(backup.dst), { recursive: true });
    if (backup.kind === 'symlink') {
      await symlink(backup.target, backup.dst);
    } else if (backup.kind === 'directory') {
      await cp(backup.backupPath, backup.dst, {
        recursive: true,
        force: false,
        errorOnExist: true,
        verbatimSymlinks: true,
      });
      await chmod(backup.dst, backup.mode);
    } else {
      await copyFile(backup.backupPath, backup.dst);
      await chmod(backup.dst, backup.mode);
    }
  }
}

async function applyWinnerChangeSet(
  projectPath: string,
  sandbox: string,
  changeSet: { write: string[]; remove: string[] },
  hooks: PromotionHooks = {},
): Promise<string[]> {
  // Validate the complete set before the first mutation so one malicious path
  // cannot leave a partially promoted candidate behind.
  const remove = [] as Array<{ rel: string; dst: string }>;
  for (const rel of changeSet.remove) {
    await assertNoSymlinkAncestors(projectPath, rel);
    remove.push({ rel, dst: containedSandboxPath(projectPath, rel) });
  }
  const write = [] as Array<{
    rel: string;
    src: string;
    dst: string;
    symlinkTarget?: string;
  }>;
  for (const rel of changeSet.write) {
    await assertNoSymlinkAncestors(sandbox, rel);
    await assertNoSymlinkAncestors(projectPath, rel);
    const src = containedSandboxPath(sandbox, rel);
    const info = await lstat(src);
    if (!info.isFile() && !info.isSymbolicLink()) {
      throw new Error(`unsupported sandbox entry type: ${JSON.stringify(rel)}`);
    }
    const symlinkTarget = info.isSymbolicLink() ? await readlink(src) : undefined;
    if (symlinkTarget !== undefined) assertSafeRepositorySymlink(sandbox, rel, symlinkTarget);
    write.push({ rel, src, dst: containedSandboxPath(projectPath, rel), symlinkTarget });
  }
  for (const rel of new Set([...changeSet.remove, ...changeSet.write])) {
    await assertProjectMatchesSandboxBase(projectPath, sandbox, rel);
  }
  const destinations = [...new Set([...remove.map((entry) => entry.dst), ...write.map((entry) => entry.dst)])];
  const rollbackRoot = await mkdtemp(join(tmpdir(), 'openswarm-promotion-rollback-'));
  let backups: PromotionBackup[] = [];
  try {
    // Snapshot every affected destination before the first write. Validation
    // alone cannot prevent disk errors or process interruption from otherwise
    // leaving a half-promoted worktree.
    backups = await capturePromotionBackups(destinations, rollbackRoot);
    try {
      for (const [index, entry] of remove.entries()) {
        await hooks.beforeRemove?.(entry.rel, index);
        await assertProjectMatchesSandboxBase(projectPath, sandbox, entry.rel);
        await removeExistingEntry(entry.dst);
      }
      for (const [index, entry] of write.entries()) {
        await hooks.beforeWrite?.(entry.rel, index);
        await assertProjectMatchesSandboxBase(projectPath, sandbox, entry.rel);
        // Never let copyFile follow an existing destination symlink. Replace the
        // directory entry itself, then either copy a regular file or recreate a
        // repository-contained relative symlink with its original Git semantics.
        await removeExistingEntry(entry.dst);
        await mkdir(dirname(entry.dst), { recursive: true });
        if (entry.symlinkTarget !== undefined) await symlink(entry.symlinkTarget, entry.dst);
        else await copyFile(entry.src, entry.dst);
      }
    } catch (promotionError) {
      try {
        await restorePromotionBackups(backups);
      } catch (rollbackError) {
        const promotionMessage = promotionError instanceof Error ? promotionError.message : String(promotionError);
        const rollbackMessage = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
        throw new Error(`promotion failed (${promotionMessage}) and rollback failed (${rollbackMessage})`, {
          cause: promotionError,
        });
      }
      throw promotionError;
    }
  } finally {
    // A cleanup failure must not turn a successfully applied promotion into a
    // reported failure; the rollback snapshot lives only under the OS temp dir.
    await rm(rollbackRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  return [...changeSet.write, ...changeSet.remove];
}

/**
 * Promote the winner by COPYING its changed files into the project, rather than
 * reconstructing a patch and `git apply`-ing it. The patch route is inherently
 * fragile on dirty (self-repair-retry) worktrees because context, whitespace,
 * and binary strictness can reject an otherwise valid candidate. A direct copy of the
 * exact file set the winner touched cannot fail on context mismatch: the
 * sandbox file is `seeded-base + winner-edits`, and the project sits at the same
 * seeded base, so the copy yields `base + winner-edits`, untouched files keep
 * their project content. Returns the promoted path list.
 */
export async function promoteWinnerFiles(projectPath: string, sandbox: string, ignoredPaths: string[] = []): Promise<string[]> {
  return applyWinnerChangeSet(projectPath, sandbox, await winnerChangeSet(sandbox, ignoredPaths));
}

/**
 * Promote only the delta that a caller already inspected. The sandbox is read
 * again immediately before copying; any late mutation turns into a hard error
 * instead of bypassing the caller's scope/conflict checks.
 */
export async function promoteValidatedFiles(
  projectPath: string,
  sandbox: string,
  validatedFiles: string[],
  ignoredPaths: string[] = [],
  hooks: PromotionHooks = {},
): Promise<string[]> {
  validatedFiles.forEach(assertSafeSandboxPath);
  const changeSet = await winnerChangeSet(sandbox, ignoredPaths);
  const actual = [...new Set([...changeSet.write, ...changeSet.remove])].sort();
  const expected = [...new Set(validatedFiles)].sort();
  if (actual.length !== expected.length || actual.some((file, index) => file !== expected[index])) {
    throw new Error(
      `sandbox changed after validation: expected [${expected.join(', ')}], found [${actual.join(', ')}]`,
    );
  }
  return applyWinnerChangeSet(projectPath, sandbox, changeSet, hooks);
}

function scoreCandidate(input: {
  result: WorkerResult;
  filesChanged: string[];
  guards?: GuardsRunResult;
  durationMs: number;
  error?: string;
}): { score: number; eligible: boolean } {
  const blockingIssues = input.guards?.results.filter((r) => !r.passed && r.blocking).flatMap((r) => r.issues) ?? [];
  const hasDiff = input.filesChanged.length > 0;
  const guardsPass = blockingIssues.length === 0;
  const eligible = input.result.success && hasDiff && guardsPass && !input.error;

  let score = 0;
  if (input.result.success) score += 100;
  if (hasDiff) score += 25;
  if (guardsPass) score += 25;
  if (typeof input.result.confidencePercent === 'number') score += Math.max(0, Math.min(100, input.result.confidencePercent)) / 10;
  score -= Math.min(input.filesChanged.length, 20);
  score -= Math.min(Math.round(input.durationMs / 30_000), 20);
  if (input.error) score -= 100;
  if (blockingIssues.length > 0) score -= 50 + blockingIssues.length * 5;

  return { score, eligible };
}

// Seed the project's pre-existing uncommitted state into a freshly-cloned
// sandbox and commit it, so the candidate continues from the dirty base and the
// winner's promoted diff is the incremental delta (not base+delta, which would
// double-apply onto the already-dirty project).
// The patch file is shared read-only by every sandbox in the batch (each used to
// rewrite its own copy, which meant holding the whole patch in memory per worker);
// the batch owner deletes it with the sandbox root.
export async function seedBaseline(sandbox: string, baseline: BaselinePatch): Promise<void> {
  if (!baseline.path) return;
  await git(sandbox, ['apply', '--whitespace=nowarn', baseline.path]);
  await git(sandbox, ['add', '-A']);
  await git(sandbox, [
    '-c', 'user.email=fanout@openswarm.local',
    '-c', 'user.name=OpenSwarm Fanout',
    'commit', '--quiet', '--no-verify', '-m', 'fanout: seed pre-existing worktree state',
  ]);
}

async function runCandidate(
  options: RunWorkerFanoutOptions,
  candidate: WorkerFanoutCandidateConfig,
  index: number,
  root: string,
  baseline: BaselinePatch,
  sharedPathSnapshot?: SharedPathSnapshot,
): Promise<WorkerFanoutCandidateRun> {
  const id = safeCandidateId(candidate.id, index);
  const started = Date.now();
  let sandbox = '';
  let linkedSharedPaths: string[] = [];

  try {
    ({ sandbox, linkedSharedPaths } = await cloneSandbox(
      options.projectPath,
      root,
      id,
      sharedPathModeFor(options.linkSharedPaths),
      sharedPathSnapshot,
    ));
    await seedBaseline(sandbox, baseline);
    const result = await runWorker({
      ...options.baseWorkerOptions,
      projectPath: sandbox,
      model: candidate.model ?? options.baseWorkerOptions.model,
      adapterName: candidate.adapter ?? options.baseWorkerOptions.adapterName,
      reasoningEffort: candidate.reasoningEffort ?? options.baseWorkerOptions.reasoningEffort,
      maxTurns: candidate.maxTurns ?? options.baseWorkerOptions.maxTurns,
      nudgeMaxOnNoEdit: candidate.nudgeMaxOnNoEdit ?? options.baseWorkerOptions.nudgeMaxOnNoEdit,
      webTools: candidate.webTools ?? options.baseWorkerOptions.webTools,
      memoryTools: candidate.memoryTools ?? options.baseWorkerOptions.memoryTools,
      processContext: options.baseWorkerOptions.processContext
        ? { ...options.baseWorkerOptions.processContext, stage: `worker:${id}` }
        : undefined,
      onLog: (line) => options.onLog?.(`[${id}] ${line}`),
    });
    const files = await changedFiles(sandbox, linkedSharedPaths);
    const guards = options.guards && files.length > 0
      ? await runGuards({ ...result, filesChanged: files }, sandbox, options.guards)
      : undefined;
    const scored = scoreCandidate({ result, filesChanged: files, guards, durationMs: Date.now() - started });
    return {
      id,
      projectPath: sandbox,
      result,
      filesChanged: files,
      guards,
      durationMs: Date.now() - started,
      score: scored.score,
      eligible: scored.eligible,
      linkedSharedPaths,
    };
  } catch (err) {
    const result: WorkerResult = {
      success: false,
      summary: `Fan-out candidate ${id} failed`,
      filesChanged: [],
      commands: [],
      output: '',
      error: err instanceof Error ? err.message : String(err),
    };
    const scored = scoreCandidate({ result, filesChanged: [], durationMs: Date.now() - started, error: result.error });
    return {
      id,
      projectPath: sandbox,
      result,
      filesChanged: [],
      durationMs: Date.now() - started,
      score: scored.score,
      eligible: false,
      error: result.error,
      linkedSharedPaths,
    };
  }
}

export async function runWorkerFanout(options: RunWorkerFanoutOptions): Promise<WorkerFanoutRunResult> {
  if (options.candidates.length < 2) {
    return { candidates: [], fallbackReason: 'fan-out needs at least two candidates' };
  }

  const root = await mkdtemp(join(tmpdir(), 'openswarm-worker-fanout-'));
  try {
    // A dirty worktree is expected on self-repair retries (the gate scores fan-out
    // mainly on retry signals). Rather than bail, snapshot the uncommitted state
    // and seed it into each sandbox so candidates continue from it and only the
    // incremental winner diff is promoted back. Falls back to clean on error.
    const baseline = await captureBaselinePatch(options.projectPath, join(root, 'baseline.patch'))
      .catch(() => emptyBaselinePatch());
    if (baseline.skippedUntracked.length > 0) {
      options.onLog?.(
        `[fanout] baseline skipped ${baseline.skippedUntracked.length} untracked file(s) over ` +
          `${Math.round(BASELINE_UNTRACKED_FILE_LIMIT_BYTES / (1024 * 1024))}MB: ${baseline.skippedUntracked.slice(0, 3).join(', ')}` +
          `${baseline.skippedUntracked.length > 3 ? ', …' : ''}`,
      );
    }
    let sharedPathSnapshot: SharedPathSnapshot | undefined;
    if (sharedPathModeFor(options.linkSharedPaths) === 'copy') {
      try {
        sharedPathSnapshot = await createSharedPathSnapshot(
          options.projectPath,
          join(root, 'shared-path-snapshot'),
        );
      } catch (error) {
        return {
          candidates: [],
          fallbackReason: `shared-path snapshot failed: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
    options.onLog?.(`[fanout] launching ${options.candidates.length} candidate worker(s)${baseline.path ? ' (seeded from dirty worktree)' : ''}`);
    const settled = await runPool(
      options.candidates,
      options.concurrency,
      (candidate, index) => runCandidate(options, candidate, index, root, baseline, sharedPathSnapshot),
      (item) => {
        if (item.value) {
          options.onLog?.(`[fanout] ${item.value.id}: score=${item.value.score.toFixed(1)} eligible=${item.value.eligible} files=${item.value.filesChanged.length}`);
        } else if (item.error) {
          options.onLog?.(`[fanout] candidate ${item.index + 1} failed: ${item.error instanceof Error ? item.error.message : String(item.error)}`);
        }
      },
    );

    const candidates = settled
      .map((item) => item.value)
      .filter((item): item is WorkerFanoutCandidateRun => Boolean(item));
    const winner = candidates
      .filter((candidate) => candidate.eligible)
      .sort((a, b) => b.score - a.score)[0];

    if (!winner) {
      return { candidates, fallbackReason: 'no eligible fan-out candidate produced a guarded diff' };
    }

    // A promotion failure (e.g. the project drifted while candidates ran) must
    // not sink the whole worker stage — fall back to a single in-place worker,
    // which is what would have run without fan-out.
    let copied: string[];
    try {
      copied = await promoteWinnerFiles(options.projectPath, winner.projectPath, winner.linkedSharedPaths);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { candidates, fallbackReason: `winner promotion failed: ${msg}` };
    }
    if (copied.length === 0) {
      return { candidates, fallbackReason: 'selected fan-out candidate had no changes to promote' };
    }
    // Report the full accumulated worktree change set (base dirty state + the
    // winner's increment) so the reviewer/tester see everything the PR carries,
    // not just this iteration's delta.
    const promotedFiles = await changedFiles(options.projectPath);
    winner.result = {
      ...winner.result,
      summary: `[fanout:${winner.id}] ${winner.result.summary}`,
      filesChanged: promotedFiles,
    };
    options.onLog?.(`[fanout] promoted ${winner.id}: ${promotedFiles.length} file(s)`);
    return { winner, candidates };
  } finally {
    if (!options.keepSandboxes) {
      await rm(root, { recursive: true, force: true });
    } else {
      options.onLog?.(`[fanout] kept sandboxes at ${root}`);
    }
  }
}

// ============================================
// OpenSwarm - Git Tracker
// Aider-style Git diff-based file change tracking
// ============================================

import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Extract changed file list via git diff
 * Track actual changed files without relying on Worker JSON parsing
 */
export async function getChangedFiles(
  projectPath: string,
  since?: string // commit hash or HEAD~1
): Promise<string[]> {
  try {
    const args = since
      ? ['diff', '--name-only', since]
      : ['diff', '--name-only', 'HEAD'];

    const output = await runGitCommand(projectPath, args);

    // Include staged files
    const stagedOutput = await runGitCommand(projectPath, ['diff', '--name-only', '--cached']);
    const untrackedOutput = await runGitCommand(projectPath, ['ls-files', '--others', '--exclude-standard']);

    const files = new Set<string>();

    output.split('\n').filter(Boolean).forEach(f => files.add(f));
    stagedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));
    untrackedOutput.split('\n').filter(Boolean).forEach(f => files.add(f));

    return Array.from(files);
  } catch (error) {
    console.error('[GitTracker] getChangedFiles error:', error);
    return [];
  }
}

/**
 * The diff itself, for handing to a reviewer that cannot run git.
 *
 * Bounded, and honest about it: a truncated diff that does not say so invites a
 * verdict on a change the reviewer only partly saw.
 *
 * The notice goes at the TOP, not the bottom. Downstream truncation — the
 * prompt template bounds the whole worker report as untrusted data — removes
 * the end of the text, so a notice appended after the diff is the first thing
 * lost, leaving a diff that stops mid-hunk with no sign that anything is
 * missing. Putting it first makes it survive any later cut, and removes the
 * need to reason about how our limit compares to anyone else's: the earlier
 * attempt tried to sit "just under" the template ceiling and still lost to a
 * long file list sharing the same budget.
 */
export async function getDiffText(
  projectPath: string,
  since?: string,
  maxBytes = 16_000,
  opts: {
    /**
     * Also show brand-new untracked files as additions. `git diff` ignores
     * them entirely, so a viewer listing changed files would show a new file
     * with no patch behind it. Staged into a THROWAWAY index, never the
     * worktree's own. (INT-3402)
     */
    includeUntracked?: boolean;
  } = {},
): Promise<string> {
  const base = since ?? 'HEAD';
  try {
    let diff: string;
    if (opts.includeUntracked) {
      const dir = await mkdtemp(join(tmpdir(), 'osw-diff-idx-'));
      const indexFile = join(dir, 'index');
      try {
        const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile };
        // `read-tree` seeds the temp index from the base so unchanged files
        // are not reported; `add -A` then stages the worktree (new files
        // included, .gitignore honored) and the cached diff shows everything.
        await runGitCommand(projectPath, ['read-tree', base], env);
        await runGitCommand(projectPath, ['add', '-A'], env);
        diff = await runGitCommand(
          projectPath,
          ['diff', '--no-color', '--no-ext-diff', '--cached', base],
          env,
        );
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } else {
      diff = await runGitCommand(projectPath, ['diff', '--no-color', '--no-ext-diff', base]);
    }
    if (diff.length <= maxBytes) return diff;
    return `[diff truncated at ${maxBytes} bytes of ${diff.length}; read the files directly for the rest]\n\n${diff.slice(0, maxBytes)}`;
  } catch (error) {
    console.error('[GitTracker] getDiffText error:', error);
    return '';
  }
}

/**
 * Capture the CURRENT worktree state (tracked + untracked-non-ignored) as a git
 * tree object, without touching the real index or worktree. A throwaway index
 * (via GIT_INDEX_FILE) lets `git add -A` stage everything there, then `write-tree`
 * turns it into a tree SHA we can diff against later.
 *
 * This is what makes change detection correct on an already-dirty repo: the
 * pre-existing dirty files live in the snapshot tree, so only edits made AFTER
 * the snapshot show up as changes. (Before this, the "snapshot" was just HEAD, so
 * every worker was blamed for the repo's entire pre-existing dirty tree.)
 */
async function writeWorktreeTree(projectPath: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'osw-idx-'));
  const indexFile = join(dir, 'index');
  try {
    const env: NodeJS.ProcessEnv = { GIT_INDEX_FILE: indexFile };
    // Fresh temp index → `add -A` stages the full current worktree (new/modified,
    // honoring .gitignore); write-tree records it. Works even in an empty repo.
    await runGitCommand(projectPath, ['add', '-A'], env);
    return (await runGitCommand(projectPath, ['write-tree'], env)).trim();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Save a pre-work snapshot of the worktree as a git tree SHA (opaque token —
 * pass it back to getChangedFilesSinceSnapshot). Captures the dirty state so
 * pre-existing changes are NOT later attributed to the worker. (INT-2447)
 */
export async function takeSnapshot(projectPath: string): Promise<string> {
  try {
    return await writeWorktreeTree(projectPath);
  } catch (error) {
    // Best-effort: proceed without the snapshot (the reviewer still judges the real
    // diff, so an empty run can't silently pass). Warn LOUDLY so the disabled
    // "did real work" guard is visible rather than looking like a clean run. (INT-2521)
    console.warn('[GitTracker] takeSnapshot FAILED — "did real work" guard disabled for this run:', error);
    return '';
  }
}

/**
 * Files changed since the snapshot: build the current worktree tree the same way
 * and diff it against the snapshot tree. Reports ONLY what changed after the
 * snapshot (added/modified/deleted, untracked included) — pre-existing dirty
 * files identical in both trees don't appear. (INT-2447)
 */
export async function getChangedFilesSinceSnapshot(
  projectPath: string,
  snapshotTree: string
): Promise<string[]> {
  if (!snapshotTree) return [];

  try {
    const currentTree = await writeWorktreeTree(projectPath);
    if (currentTree === snapshotTree) return [];
    const diff = await runGitCommand(projectPath, ['diff', '--name-only', snapshotTree, currentTree]);
    return diff.split('\n').filter(Boolean);
  } catch (error) {
    // Do NOT return [] on a git failure — indistinguishable from "no changes", it
    // would drop the worker's real edits (uncredited → false STUCK) or mask them.
    // Throw with the 'git-tracker' marker so isInfraError routes it → infra_error
    // (backoff retry), preserving the work for the next attempt. (INT-2521)
    const msg = error instanceof Error ? error.message : String(error);
    console.error('[GitTracker] getChangedFilesSinceSnapshot error:', error);
    throw new Error(`git-tracker: diff since snapshot failed: ${msg}`);
  }
}

/**
 * Auto-commit staged project changes.
 */
export async function autoCommit(
  projectPath: string,
  message: string,
  _model: string = 'claude'
): Promise<{ success: boolean; hash?: string; error?: string }> {
  try {
    // 1. Stage all changes
    await runGitCommand(projectPath, ['add', '-A']);

    // 2. Check if there are changes to commit
    const status = await runGitCommand(projectPath, ['status', '--porcelain']);
    if (!status.trim()) {
      return { success: true, hash: undefined }; // Nothing to commit
    }

    // 3. Commit using the caller-provided message verbatim.
    await runGitCommand(projectPath, ['commit', '-m', message]);

    // 4. Get commit hash
    const hash = await runGitCommand(projectPath, ['rev-parse', 'HEAD']);

    return { success: true, hash: hash.trim() };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * Per-file diff detail for the working tree vs HEAD.
 * Guards run pre-commit, so the worker's edits live in the working tree —
 * `git diff HEAD` captures tracked/staged changes and `ls-files --others` the
 * untracked files. Used by dead-module and reformat-noise guards. (INT-2388)
 */
export interface FileDiffDetail {
  file: string;
  /** Added lines (0 for binary or brand-new untracked files). */
  added: number;
  /** Deleted lines. */
  deleted: number;
  /** Newly created file relative to HEAD, staged or untracked. */
  isNew: boolean;
  /** Change vanishes under `-w` (whitespace-ignored) — reformat-only noise. */
  whitespaceOnly: boolean;
}

/** Parse `git diff --numstat` output into a path -> [added, deleted] map. Binary rows (`-`) map to [0,0]. */
function parseNumstat(output: string): Map<string, [number, number]> {
  const map = new Map<string, [number, number]>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const added = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
    const deleted = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
    // Rename rows look like `a\td\told => new`; take the last path token.
    const path = parts.slice(2).join('\t');
    map.set(path, [added, deleted]);
  }
  return map;
}

/** Parse `git diff --name-status` output and return paths added relative to HEAD. */
function parseAddedPaths(output: string): Set<string> {
  const added = new Set<string>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    if (parts[0] === 'A' && parts[1]) {
      added.add(parts[1]);
    }
  }
  return added;
}

/**
 * Working-tree diff detail vs HEAD: per-file line counts, new-file flag, and a
 * reformat-only (whitespace) flag. Returns [] on any git error (advisory only).
 */
export async function getWorkingDiffDetail(projectPath: string): Promise<FileDiffDetail[]> {
  try {
    const [numstatRaw, wsNumstatRaw, nameStatusRaw, untrackedRaw] = await Promise.all([
      runGitCommand(projectPath, ['diff', '--numstat', 'HEAD']),
      runGitCommand(projectPath, ['diff', '-w', '--numstat', 'HEAD']),
      runGitCommand(projectPath, ['diff', '--name-status', 'HEAD']),
      runGitCommand(projectPath, ['ls-files', '--others', '--exclude-standard']),
    ]);

    const numstat = parseNumstat(numstatRaw);
    const wsNumstat = parseNumstat(wsNumstatRaw);
    const addedPaths = parseAddedPaths(nameStatusRaw);
    const details: FileDiffDetail[] = [];

    for (const [file, [added, deleted]] of numstat) {
      // Whitespace-only: the file has a real change but it disappears under -w
      // (missing from the -w numstat, or present with 0/0).
      const ws = wsNumstat.get(file);
      const whitespaceOnly = (added + deleted) > 0 && (!ws || ws[0] + ws[1] === 0);
      details.push({ file, added, deleted, isNew: addedPaths.has(file), whitespaceOnly });
    }

    for (const file of untrackedRaw.split('\n').filter(Boolean)) {
      details.push({ file, added: 0, deleted: 0, isNew: true, whitespaceOnly: false });
    }

    return details;
  } catch (error) {
    console.error('[GitTracker] getWorkingDiffDetail error:', error);
    return [];
  }
}

/**
 * Git command execution utility
 */
// Bound each snapshot/diff git call so a stuck git (index lock, corrupt repo)
// rejects with a timeout instead of hanging the worker's "did real work" check
// forever. "timed out" → isInfraError → infra_error backoff. (INT-2521)
const GIT_CMD_TIMEOUT_MS = 5 * 60_000;

function runGitCommand(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd, env: env ? { ...process.env, ...env } : process.env });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true; // claim settlement before the late close/error handlers run
      proc.kill('SIGKILL');
      reject(new Error(`git ${args.join(' ')} timed out after ${GIT_CMD_TIMEOUT_MS}ms`));
    }, GIT_CMD_TIMEOUT_MS);

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
      }
    });

    proc.on('error', (err) => { settled = true; clearTimeout(timer); reject(err); });
  });
}

/**
 * Check if project is a git repository
 */
export async function isGitRepo(projectPath: string): Promise<boolean> {
  try {
    await runGitCommand(projectPath, ['rev-parse', '--git-dir']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check dirty state (uncommitted changes)
 */
export async function isDirty(projectPath: string): Promise<boolean> {
  try {
    const status = await runGitCommand(projectPath, ['status', '--porcelain']);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}

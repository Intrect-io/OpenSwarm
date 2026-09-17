// Base freshness at publication (AGT-4189)
//
// A worktree branches from the remote default branch when it is created, and a
// preserved worktree is resumed days later without ever moving. On 2026-09-03
// four cgf-portal PRs were opened 112–122 commits behind main and CONFLICTING.
// GitHub does not run `pull_request` workflows on a PR it cannot merge, but the
// default CodeQL setup still posts green checks — so a PR that had never run
// `ruff + pytest` looked like one that had passed them. One of the four
// re-solved, under a different name, a problem main had fixed six days earlier.
//
// This module answers two questions at publication time, before the PR is
// opened: how far behind the base the branch is, and whether it merges cleanly.
// A conflicting branch is published as a DRAFT with the conflicting files named;
// a merely stale one gets a note. Nothing here rebases — a rebase performed by
// the publisher on a branch nobody reviewed afterwards is not safer than a draft
// the operator can see.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;

export interface BaseFreshness {
  /** Commits on the base ref that the branch does not have. */
  behindBy: number;
  /** Paths `git merge-tree` reports as conflicting; empty when the merge is clean. */
  conflictFiles: string[];
}

export const FRESH_BASE: BaseFreshness = { behindBy: 0, conflictFiles: [] };

/**
 * Probe how the branch at `worktreePath` relates to `baseRef` (e.g.
 * `origin/main`, already fetched by the caller). Read-only: `merge-tree
 * --write-tree` writes a tree object but touches no ref, index or worktree.
 *
 * Best-effort in the way the other publication sections are: a git failure
 * (an old git without `--write-tree`, an unreadable ref) yields `FRESH_BASE`
 * rather than blocking a publication the run already earned.
 */
export async function probeBaseFreshness(worktreePath: string, baseRef: string): Promise<BaseFreshness> {
  try {
    const { stdout } = await execFileAsync(
      'git', ['-C', worktreePath, 'rev-list', '--count', `HEAD..${baseRef}`], { timeout: GIT_TIMEOUT_MS },
    );
    const behindBy = Number.parseInt(stdout.trim(), 10);
    if (!Number.isFinite(behindBy) || behindBy <= 0) return FRESH_BASE;
    return { behindBy, conflictFiles: await mergeConflicts(worktreePath, baseRef) };
  } catch {
    return FRESH_BASE;
  }
}

/**
 * `git merge-tree --write-tree --name-only` exits 1 on a conflict and prints the
 * tree id, a blank line, then one conflicting path per line. Exit 0 is a clean
 * merge; any other exit is a probe failure, reported as "no conflict known".
 */
async function mergeConflicts(worktreePath: string, baseRef: string): Promise<string[]> {
  try {
    await execFileAsync(
      'git', ['-C', worktreePath, 'merge-tree', '--write-tree', '--no-messages', '--name-only', baseRef, 'HEAD'],
      { timeout: GIT_TIMEOUT_MS },
    );
    return [];
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string };
    if (failure.code !== 1 || typeof failure.stdout !== 'string') return [];
    return parseConflictedPaths(failure.stdout);
  }
}

/** The conflicting paths from `merge-tree --write-tree --name-only` output on exit 1. */
export function parseConflictedPaths(stdout: string): string[] {
  const [, ...rest] = stdout.split('\n');
  const seen = new Set<string>();
  for (const line of rest) {
    const path = line.trim();
    if (path) seen.add(path);
  }
  return [...seen];
}

/**
 * The PR-body section for a stale or conflicting base, or `null` when the
 * branch is up to date. Conflicts are the loud case: they name the files and
 * say why the green CodeQL checks on a conflicting PR are not a verdict.
 */
export function baseFreshnessSection(freshness: BaseFreshness, baseBranch: string): string | null {
  if (freshness.behindBy === 0 && freshness.conflictFiles.length === 0) return null;
  const lines = ['## Base freshness', `Branch base is ${freshness.behindBy} commit(s) behind \`${baseBranch}\` at publication.`];
  if (freshness.conflictFiles.length > 0) {
    lines.push(
      '',
      `⚠ **Conflicts with \`${baseBranch}\`** in: ${freshness.conflictFiles.map((file) => `\`${file}\``).join(', ')}`,
      'GitHub runs no `pull_request` workflows on a PR it cannot merge, so any green checks here are not the verification gate. Opened as a draft; rebase before review.',
    );
  }
  return lines.join('\n');
}

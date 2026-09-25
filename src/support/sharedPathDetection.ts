// Shared dependency detection for fresh worktrees (INT-2415, AGT-4043)
//
// A worktree is created fresh from origin/main, so it has NO node_modules /
// .venv and none of the repo's gitignored real data — a worker there cannot run
// npm/pytest/ruff. The original checkout is the installed sandbox, so its
// dependency directories are shared into the worktree (symlink or clone; the
// caller decides). This module only decides WHICH repo-relative paths qualify.
//
// The first version looked at the repository root only. A monorepo keeps its
// dependencies under its workspaces (`apps/portal/node_modules`,
// `apps/pipelines/.venv`), so the root check found nothing, the worker started
// with no toolchain, halted once, and on the next attempt installed uv from the
// internet and borrowed another task's worktree venv (AGT-4043). Detection now
// also walks the workspace tree — bounded, and only into directories that carry
// a workspace manifest, so a stray `venv` folder in a fixture is never linked.

import { existsSync, readdirSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';

/** Always-gitignored dependency dirs safe to auto-link without a config. */
export const AUTO_SHARED_CANDIDATES = ['node_modules', '.venv-verify', '.venv', 'venv'];

/**
 * A directory carrying one of these is a workspace: its dependency dirs are
 * the toolchain the worker needs, not incidental fixture data.
 */
export const WORKSPACE_MANIFESTS = ['package.json', 'pyproject.toml', 'uv.lock', 'requirements.txt'];

/**
 * How many directory levels below the repository root the workspace walk
 * visits. `apps/<name>` is depth 2; `packages/<scope>/<name>` is depth 3. A
 * full scan is unaffordable on large repositories, so the bound is fixed here
 * and pinned by a test rather than derived from the tree.
 */
export const SHARED_PATH_SCAN_DEPTH = 3;

/** Directories the walk never descends into: dependency payloads, VCS state, build output. */
const SKIPPED_DIRECTORIES = new Set([
  ...AUTO_SHARED_CANDIDATES, '.git', 'worktree', 'dist', 'build', 'target', '.next', '.cache', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
]);

export interface SandboxConfig {
  sandbox?: { sharedPaths?: string[] } | null;
}

export interface SharedPathDetection {
  /** Repo-relative dependency dirs that qualify for sharing, root first, then by walk order. */
  shared: string[];
  /**
   * Dependency dirs the walk saw but did not qualify: they sit in a directory
   * without a workspace manifest, or one level past the depth bound. Reported
   * so an empty `shared` can say what it missed instead of staying silent.
   */
  unlinked: string[];
}

function hasWorkspaceManifest(directory: string): boolean {
  return WORKSPACE_MANIFESTS.some((manifest) => existsSync(join(directory, manifest)));
}

function childDirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return []; // unreadable directory: nothing to share from it
  }
}

/**
 * Auto-detect dependency directories: the repository root unconditionally
 * (the single-repo behaviour, unchanged), then every directory up to
 * `SHARED_PATH_SCAN_DEPTH` levels down that carries a workspace manifest.
 * Read-only; returns repo-relative paths with `/` separators normalised by
 * `path.join`.
 */
export function detectSharedPaths(repoPath: string): SharedPathDetection {
  const shared: string[] = [];
  const unlinked: string[] = [];
  // Breadth-first so the order is stable and shallow workspaces come first.
  const queue: Array<{ rel: string; depth: number }> = [{ rel: '', depth: 0 }];
  while (queue.length > 0) {
    const { rel, depth } = queue.shift()!;
    const directory = rel ? join(repoPath, rel) : repoPath;
    const qualifies = depth === 0 || hasWorkspaceManifest(directory);
    const children = childDirectories(directory);
    for (const name of children) {
      const candidateRel = rel ? join(rel, name) : name;
      if (AUTO_SHARED_CANDIDATES.includes(name)) {
        (qualifies ? shared : unlinked).push(candidateRel);
        continue;
      }
      if (name.startsWith('.') || SKIPPED_DIRECTORIES.has(name)) continue;
      if (depth < SHARED_PATH_SCAN_DEPTH) {
        queue.push({ rel: candidateRel, depth: depth + 1 });
      } else {
        // One level past the bound: look, but only to report what was missed.
        for (const deeper of childDirectories(join(directory, name))) {
          if (AUTO_SHARED_CANDIDATES.includes(deeper)) unlinked.push(join(candidateRel, deeper));
        }
      }
    }
  }
  return { shared, unlinked };
}

function escapesRepo(p: string): boolean {
  if (isAbsolute(p)) return true;
  const segments = p.split(/[\\/]/);
  if (segments.includes('..')) return true;
  const rel = relative('.', p);
  return rel.startsWith(`..${sep}`) || rel === '..';
}

/**
 * Pure decision: which repo-relative paths should be shared into a worktree.
 *
 * - If openswarm.json declares `sandbox.sharedPaths`, trust that list verbatim
 *   (the repo owner opted in — no gitignore check).
 * - Otherwise auto-detect the always-gitignored dependency dirs at the root
 *   and under workspace manifests (`detectSharedPaths`); never a tracked dir.
 *
 * Returns only candidates that actually EXIST at `<repoPath>/<P>` (read-only
 * check). Absolute or parent-escaping (`..`) entries are dropped for safety.
 * The symlink/clone itself is the caller's side effect. (INT-2415, AGT-4043)
 */
export function resolveSharedPaths(repoPath: string, openswarmJson?: SandboxConfig | null): string[] {
  const configured = openswarmJson?.sandbox?.sharedPaths;
  const candidates = configured && configured.length > 0 ? configured : detectSharedPaths(repoPath).shared;

  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of candidates) {
    const p = (raw ?? '').trim();
    if (!p) continue;
    if (escapesRepo(p)) continue; // never escape the repo
    if (seen.has(p)) continue;
    seen.add(p);
    if (existsSync(join(repoPath, p))) out.push(p);
  }
  return out;
}

/**
 * One line for the worktree log when nothing qualified but dependency dirs do
 * exist in the repository — the silent-empty case that started AGT-4043.
 * `null` when there is nothing to say.
 */
export function emptyDetectionWarning(repoPath: string, detection: SharedPathDetection): string | null {
  if (detection.shared.length > 0 || detection.unlinked.length === 0) return null;
  return `[Worktree] No shared dependency paths detected in ${repoPath}, but dependency dirs exist outside any workspace manifest `
    + `or deeper than ${SHARED_PATH_SCAN_DEPTH} levels: ${detection.unlinked.join(', ')}. `
    + `Declare them in openswarm.json sandbox.sharedPaths or add a manifest next to them.`;
}

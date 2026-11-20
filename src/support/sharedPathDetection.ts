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

import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
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

/** Secret-like path components must not be silently shared into worker worktrees. */
export function secretSharedPathComponents(paths: string[]): string[] {
  const patterns = [/^\.env.*$/i, /^.+\.pem$/i, /^.+\.key$/i, /^credentials.*$/i];
  return paths.filter((path) => path.split(/[\\/]/).some((part) => patterns.some((pattern) => pattern.test(part))));
}

export function secretSharedPathsWarning(paths: string[]): string | null {
  const matches = secretSharedPathComponents(paths);
  if (matches.length === 0) return null;
  return `[Worktree] sharedPaths may expose secret files to the worker: ${matches.join(', ')}. `
    + 'Remove these entries from openswarm.json sandbox.sharedPaths to keep them out of worktrees.';
}

/** Gitignored source paths a worktree will not see, split by why. (AGT-4041) */
export interface GitignoredPathGaps {
  /** Ignored and not covered by `sharedPaths`: the worktree has no such path at all. */
  missing: string[];
  /** Shared into the worktree, but the sandbox identity cannot read it: a name with no content. */
  unreadable: string[];
}

/**
 * The identity that reads shared paths inside the worker sandbox. The bubblewrap
 * sandbox runs as the daemon uid, so by default that is this process. A container
 * that maps the worker to another uid sets `OPENSWARM_SANDBOX_UID` (and optionally
 * `OPENSWARM_SANDBOX_GID`); nothing in OpenSwarm sets them today.
 */
export interface SandboxReader { uid?: number; gid?: number }

function envId(name: string): number | undefined {
  const raw = process.env[name]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return undefined;
  return Number(raw);
}

export { recordWorktreeGitignoredGaps } from './worktreeMissingPaths.js';

export function configuredSandboxReader(): SandboxReader {
  return { uid: envId('OPENSWARM_SANDBOX_UID'), gid: envId('OPENSWARM_SANDBOX_GID') };
}

/**
 * Whether `reader` can read `path` by its Unix mode. The owner bit applies only when the
 * reader is the owner and the group bit only when its gid matches; anyone else needs the
 * "other" bit. A reader that is this process also gets the real `access(2)` check (which
 * catches ACLs and parent-dir denials); root is still judged by the mode, since root in a
 * container is not root on the host. (#855 review: the incident was a daemon-owned
 * drwx------ dir read from a container running as another uid.)
 */
function readableBy(path: string, reader: SandboxReader): boolean {
  const stat = statSync(path);
  const processUid = process.getuid?.();
  const uid = reader.uid ?? processUid;
  const sameProcess = uid === processUid && reader.gid === undefined;
  if (sameProcess) accessSync(path, constants.R_OK);
  const groups = sameProcess
    ? new Set([process.getgid?.(), ...(process.getgroups?.() ?? [])])
    : new Set(reader.gid === undefined ? [] : [reader.gid]);
  const readBit = uid === stat.uid ? 0o400 : groups.has(stat.gid) ? 0o040 : 0o004;
  return (stat.mode & readBit) !== 0;
}

/**
 * An ignored dir that is another checkout, or a container of parked checkouts only
 * (`worktrees/<id>/.git`). A dir mixing a clone with real data is still data.
 */
function holdsNestedCheckout(path: string): boolean {
  if (existsSync(join(path, '.git'))) return true;
  try {
    const children = readdirSync(path, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    return children.length > 0 && children.every((entry) => existsSync(join(path, entry.name, '.git')));
  } catch { return false; }
}

/**
 * Gitignored paths in the source checkout that a worktree will not see: ignored and not covered by
 * `sharedPaths` (a shared ancestor covers it; sharing only a child leaves the rest missing), or
 * shared but unreadable by the sandbox identity. Each ignored directory is reported once at its
 * topmost ignored level (git also lists its files under some patterns; those are dropped), so
 * `docs/CGF_data` under a tracked `docs/` is found, and a large `node_modules` is not walked.
 * A directory holding nested checkouts (parked worktrees) is not this repository's data.
 */
export function unsharedGitignoredPaths(
  repoPath: string,
  sharedPaths: string[] = [],
  reader: SandboxReader = configuredSandboxReader(),
): GitignoredPathGaps {
  const gaps: GitignoredPathGaps = { missing: [], unreadable: [] };
  let listing: string;
  try {
    listing = execFileSync(
      'git', ['-C', repoPath, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 16 * 1024 * 1024, timeout: 10_000 },
    );
  } catch { return gaps; }
  const shared = sharedPaths.map((entry) => entry.replace(/\/+$/, '')).filter(Boolean);
  const directories = new Set<string>();
  const nestedRepo = new Map<string, boolean>();
  // A nested checkout (another worktree parked inside this one) is not this repository's data.
  const insideNestedRepo = (name: string): boolean => {
    const parts = name.split('/');
    for (let depth = 1; depth < parts.length; depth++) {
      const dir = parts.slice(0, depth).join('/');
      let nested = nestedRepo.get(dir);
      if (nested === undefined) {
        nested = existsSync(join(repoPath, dir, '.git'));
        nestedRepo.set(dir, nested);
      }
      if (nested) return true;
    }
    return false;
  };
  const entries = listing.split('\0').filter(Boolean);
  for (const raw of entries) if (raw.endsWith('/')) directories.add(raw.replace(/\/+$/, ''));
  const underListedDirectory = (name: string): boolean => {
    for (let at = name.indexOf('/'); at !== -1; at = name.indexOf('/', at + 1)) {
      if (directories.has(name.slice(0, at))) return true;
    }
    return false;
  };
  for (const raw of entries) {
    const name = raw.replace(/\/+$/, '');
    if (!name || name === '.git' || name.startsWith('.git/') || underListedDirectory(name) || insideNestedRepo(name)) continue;
    const covered = shared.some((entry) => name === entry || name.startsWith(`${entry}/`));
    if (!covered) {
      if (!(directories.has(name) && holdsNestedCheckout(join(repoPath, name)))) gaps.missing.push(name);
      continue;
    }
    try {
      if (!readableBy(join(repoPath, name), reader)) gaps.unreadable.push(name);
    } catch { gaps.unreadable.push(name); }
  }
  // Directories first: they hold data; loose ignored files (.env, notes) rarely change a conclusion.
  const order = (a: string, b: string) => Number(directories.has(b)) - Number(directories.has(a)) || a.localeCompare(b);
  gaps.missing.sort(order);
  gaps.unreadable.sort(order);
  return gaps;
}

const WARNING_LISTED = 20;

function listed(paths: string[]): string {
  const shown = paths.slice(0, WARNING_LISTED).join(', ');
  return paths.length > WARNING_LISTED ? `${shown} +${paths.length - WARNING_LISTED} more` : shown;
}

export function gitignoredPathsWarning(gaps: GitignoredPathGaps): string | null {
  const parts: string[] = [];
  if (gaps.missing.length) {
    parts.push(`${gaps.missing.length} gitignored path(s) from the source are absent from this worktree (${listed(gaps.missing)})`);
  }
  if (gaps.unreadable.length) {
    parts.push(`${gaps.unreadable.length} shared gitignored path(s) are unreadable by the sandbox identity (${listed(gaps.unreadable)})`);
  }
  if (!parts.length) return null;
  return `[Worktree] ${parts.join('; ')}; expose them through sandbox.sharedPaths (readable by the sandbox user) or do not use their absence as a conclusion.`;
}

const warnedGitignoredPaths = new Set<string>();

/** Warn once per repository and gap list, like the secret-path warning: every worktree creation recomputes it. */
export function warnGitignoredPathsOnce(repoPath: string, gaps: GitignoredPathGaps): void {
  const warning = gitignoredPathsWarning(gaps);
  if (!warning) return;
  const key = `${repoPath}\0${warning}`;
  if (warnedGitignoredPaths.has(key)) return;
  warnedGitignoredPaths.add(key);
  console.warn(warning);
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
  warnSecretSharedPathsOnce(repoPath, out);
  return out;
}

const warnedSecretSharedPaths = new Set<string>();

/**
 * Every consumer of the shared list — worktree creation, worker fan-out
 * (symlink and copy) and verification sandboxes — goes through
 * `resolveSharedPaths`, so the secret-path warning is raised here, once per
 * repository and list, instead of by one caller only. (#848 review)
 */
function warnSecretSharedPathsOnce(repoPath: string, paths: string[]): void {
  const warning = secretSharedPathsWarning(paths);
  if (!warning) return;
  const key = `${repoPath}\0${warning}`;
  if (warnedSecretSharedPaths.has(key)) return;
  warnedSecretSharedPaths.add(key);
  console.warn(warning);
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

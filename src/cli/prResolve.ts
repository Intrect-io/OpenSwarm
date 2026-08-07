// ============================================
// OpenSwarm - Resolve repo + PR from cwd / flags (INT-3282)
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PRInfo } from '../github/github.js';

const execFileAsync = promisify(execFile);

async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { cwd, maxBuffer: 4 * 1024 * 1024 });
  return stdout;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

export interface ResolvedPR {
  repo: string;
  number: number;
  title: string;
  branch: string;
  url: string;
  author?: string;
}

export interface ResolvePROptions {
  /** Working directory (default: process.cwd()) */
  path?: string;
  /** Explicit PR number */
  number?: number;
  /** Explicit owner/repo (otherwise inferred via `gh repo view`) */
  repo?: string;
}

/**
 * Parse `owner/repo#123`, `#123`, or bare `123` into parts.
 * Pure — no I/O.
 */
export function parsePRRef(raw: string): { repo?: string; number: number } {
  const trimmed = raw.trim();
  const withRepo = trimmed.match(/^([^/\s]+\/[^#\s]+)#(\d+)$/);
  if (withRepo) {
    return { repo: withRepo[1], number: parseInt(withRepo[2], 10) };
  }
  const hashOnly = trimmed.match(/^#?(\d+)$/);
  if (hashOnly) {
    return { number: parseInt(hashOnly[1], 10) };
  }
  throw new Error(`Invalid PR ref "${raw}" (expected #123, 123, or owner/repo#123)`);
}

/** Infer `owner/repo` for the git checkout at `cwd`. */
export async function resolveRepoName(cwd: string, explicit?: string): Promise<string> {
  if (explicit?.includes('/')) return explicit;
  const stdout = await gh(cwd, 'repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner');
  const name = stdout.trim();
  if (!name.includes('/')) {
    throw new Error(`Could not resolve repository name from ${cwd}`);
  }
  return name;
}

/**
 * The repo `cwd`'s `origin` remote actually points at — resolved by handing
 * origin's own URL to `gh repo view <url>`, not the bare `gh repo view` that
 * `resolveRepoName` uses. A bare `gh repo view` is not documented to
 * specifically pick `origin` when a checkout has more than one remote
 * configured, which matters for any caller (like `pr review --all`) that
 * then fetches explicitly from `origin` — resolving against a different
 * remote than the one actually fetched from would defeat the whole point of
 * checking repo identity first. Same pattern as
 * `PRProcessor.freshReview`'s origin check (INT-3282).
 */
export async function resolveOriginRepo(cwd: string): Promise<string> {
  const originUrl = (await git(cwd, 'remote', 'get-url', 'origin')).trim();
  const stdout = await gh(cwd, 'repo', 'view', originUrl, '--json', 'nameWithOwner', '-q', '.nameWithOwner');
  const name = stdout.trim();
  if (!name.includes('/')) {
    throw new Error(`Could not resolve repository name for origin (${originUrl}) at ${cwd}`);
  }
  return name;
}

/**
 * Resolve the PR to operate on: explicit number → current branch's PR → error.
 */
export async function resolvePR(opts: ResolvePROptions = {}): Promise<ResolvedPR> {
  const cwd = opts.path ?? process.cwd();
  const repo = await resolveRepoName(cwd, opts.repo);

  if (opts.number != null) {
    const stdout = await gh(
      cwd,
      'pr', 'view', String(opts.number),
      '-R', repo,
      '--json', 'number,title,headRefName,url,author',
    );
    const view = JSON.parse(stdout) as {
      number: number;
      title: string;
      headRefName: string;
      url: string;
      author?: { login?: string };
    };
    return {
      repo,
      number: view.number,
      title: view.title,
      branch: view.headRefName,
      url: view.url,
      author: view.author?.login,
    };
  }

  // Current branch open PR (gh fails when none).
  try {
    const stdout = await gh(
      cwd,
      'pr', 'view',
      '--json', 'number,title,headRefName,url,author',
    );
    const view = JSON.parse(stdout) as {
      number: number;
      title: string;
      headRefName: string;
      url: string;
      author?: { login?: string };
    };
    return {
      repo,
      number: view.number,
      title: view.title,
      branch: view.headRefName,
      url: view.url,
      author: view.author?.login,
    };
  } catch {
    const branch = (await git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD')).trim();
    throw new Error(
      `No open PR for branch "${branch}" in ${repo}. Pass --number <n> or create one with: openswarm pr create`,
    );
  }
}

/** Convert ResolvedPR → github.PRInfo. */
export function toPRInfo(resolved: ResolvedPR): PRInfo {
  return {
    repo: resolved.repo,
    number: resolved.number,
    title: resolved.title,
    branch: resolved.branch,
    createdAt: new Date().toISOString(),
    url: resolved.url,
    author: resolved.author,
  };
}

// ============================================
// OpenSwarm - Git Status & PR Cache
// ============================================

import { execFile } from 'node:child_process';

// --- Types ---

export interface GitStatus {
  branch: string;
  hasChanges: boolean;
  uncommittedFiles: number;
  ahead: number;
  behind: number;
}

export interface PRSummary {
  number: number;
  title: string;
  branch: string;
  url: string;
  updatedAt: string;
}

export interface ProjectGitInfo {
  git: GitStatus | null;
  prs: PRSummary[];
}

// --- Cache ---

const cache = new Map<string, { data: ProjectGitInfo; ts: number }>();
const CACHE_TTL = 30_000;
const MAX_CACHE_ENTRIES = 200;
const CMD_TIMEOUT = 5_000;
const CMD_MAX_BUFFER = 10 * 1024 * 1024;
let activePoller: NodeJS.Timeout | null = null;

// --- Helpers ---

function git(projectPath: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', projectPath, ...args], { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER }, (err, stdout) => {
      if (err) { reject(err); return; }
      resolve(stdout.trim());
    });
  });
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER }, (err, stdout) => {
      if (err) { resolve(''); return; }
      resolve(stdout.trim());
    });
  });
}

// --- Fetch functions ---

async function fetchGitStatus(projectPath: string): Promise<GitStatus | null> {
  let branch: string;
  let porcelain: string;
  try {
    branch = await git(projectPath, ['branch', '--show-current']);
    porcelain = await git(projectPath, ['status', '--porcelain']);
  } catch {
    // Failure must not look like a clean tree.
    return null;
  }
  if (!branch) return null; // not a git repo or error

  const lines = porcelain ? porcelain.split('\n').filter(Boolean) : [];

  // ahead/behind — may catch and treat as 0
  let ahead = 0;
  let behind = 0;
  try {
    const revList = await git(projectPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    if (revList) {
      const parts = revList.split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  } catch {
    ahead = 0;
    behind = 0;
  }

  return {
    branch,
    hasChanges: lines.length > 0,
    uncommittedFiles: lines.length,
    ahead,
    behind,
  };
}

async function fetchOpenPRs(projectPath: string): Promise<PRSummary[]> {
  // Extract owner/repo from origin remote URL
  let remoteUrl: string;
  try {
    remoteUrl = await git(projectPath, ['remote', 'get-url', 'origin']);
  } catch {
    return [];
  }
  if (!remoteUrl) return [];

  // SSH: git@github.com:owner/repo.git / HTTPS: https://github.com/owner/repo.git
  const match = remoteUrl.match(/github\.com[:/]([^/]+\/[^/.]+)/);
  if (!match) return [];

  const repoSlug = match[1];
  const raw = await gh([
    'pr', 'list', '-R', repoSlug,
    '--state', 'open',
    '--json', 'number,title,headRefName,url,updatedAt',
  ]);
  if (!raw) return [];

  try {
    const prs = JSON.parse(raw) as any[];
    return prs.map((pr) => ({
      number: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      url: pr.url,
      updatedAt: pr.updatedAt,
    }));
  } catch {
    return [];
  }
}

// --- Public API ---

export async function getProjectGitInfo(path: string): Promise<ProjectGitInfo> {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (now - entry.ts >= CACHE_TTL) cache.delete(key);
  }
  const cached = cache.get(path);
  if (cached) {
    cache.delete(path);
    cache.set(path, cached);
    return cached.data;
  }

  const [gitStatus, prs] = await Promise.all([
    fetchGitStatus(path),
    fetchOpenPRs(path),
  ]);

  const data: ProjectGitInfo = { git: gitStatus, prs };
  cache.set(path, { data, ts: Date.now() });
  while (cache.size > MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  return data;
}

export function clearGitStatusCache(): void {
  cache.clear();
}

export function getGitStatusCacheSizeForTests(): number {
  return cache.size;
}

export function startGitStatusPoller(
  getPaths: () => string[],
  intervalMs: number = 30_000,
): NodeJS.Timeout {
  stopGitStatusPoller();
  activePoller = setInterval(async () => {
    const paths = getPaths();
    // Background refresh — ignore errors
    await Promise.allSettled(paths.map((p) => getProjectGitInfo(p)));
  }, intervalMs);
  activePoller.unref();
  return activePoller;
}

export function stopGitStatusPoller(): void {
  if (!activePoller) return;
  clearInterval(activePoller);
  activePoller = null;
}

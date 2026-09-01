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
const CMD_MAX_BUFFER = 10 * 1024 * 1024; // 10 MiB — explicit bounded buffer
let activePoller: NodeJS.Timeout | null = null;

// --- Helpers ---

/**
 * Run a git command with explicit maxBuffer and distinguishable error handling.
 * Returns the trimmed stdout on success, or an empty string on failure (callers
 * that need to distinguish failure from clean empty output should check via
 * other means or use a dedicated wrapper).
 */
function git(projectPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', projectPath, ...args], { timeout: CMD_TIMEOUT, maxBuffer: CMD_MAX_BUFFER }, (err, stdout, stderr) => {
      if (err) {
        // Distinguish Git command failure (e.g., E2BIG) from clean empty output
        console.warn(`[GitStatus] git command failed: ${err.code}, ${err.message}`);
        resolve('');
        return;
      }
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
  const [branch, changesRaw, aheadBehindRaw] = await Promise.all([
    git(projectPath, ['rev-parse', '--abbrev-ref', 'HEAD']),
    git(projectPath, ['status', '--porcelain']),
    git(projectPath, ['rev-list', '--count', '--left-right', '@{upstream}...HEAD']),
  ]);

  if (!branch) return null;

  const hasChanges = changesRaw.length > 0;
  const uncommittedFiles = hasChanges ? changesRaw.split('\n').filter(Boolean).length : 0;

  let ahead = 0;
  let behind = 0;
  if (aheadBehindRaw) {
    const parts = aheadBehindRaw.split('\t');
    if (parts.length === 2) {
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  }

  return { branch, hasChanges, uncommittedFiles, ahead, behind };
}

async function fetchOpenPRs(projectPath: string): Promise<PRSummary[]> {
  const raw = await gh(['pr', 'list', '--json', 'number,title,headRefName,url,updatedAt', '--limit', '20', `--repo=${projectPath}`]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{
      number: number;
      title: string;
      headRefName: string;
      url: string;
      updatedAt: string;
    }>;
    return parsed.map((pr) => ({
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
  const cached = cache.get(path);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  const [git, prs] = await Promise.all([
    fetchGitStatus(path),
    fetchOpenPRs(path),
  ]);

  const data: ProjectGitInfo = { git, prs };

  // Evict oldest if at capacity
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(path, { data, ts: Date.now() });

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
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
const CMD_TIMEOUT = 5_000;

// --- Helpers ---

function git(projectPath: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['-C', projectPath, ...args], { timeout: CMD_TIMEOUT }, (err, stdout) => {
      if (err) { resolve(''); return; }
      resolve(stdout.trim());
    });
  });
}

function gh(args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile('gh', args, { timeout: CMD_TIMEOUT }, (err, stdout) => {
      if (err) { resolve(''); return; }
      resolve(stdout.trim());
    });
  });
}

// --- Fetch functions ---

async function fetchGitStatus(projectPath: string): Promise<GitStatus | null> {
  const branch = await git(projectPath, ['branch', '--show-current']);
  if (!branch) return null; // git repo가 아니거나 에러

  const porcelain = await git(projectPath, ['status', '--porcelain']);
  const lines = porcelain ? porcelain.split('\n').filter(Boolean) : [];

  // ahead/behind
  let ahead = 0;
  let behind = 0;
  const revList = await git(projectPath, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
  if (revList) {
    const parts = revList.split(/\s+/);
    ahead = parseInt(parts[0], 10) || 0;
    behind = parseInt(parts[1], 10) || 0;
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
  // origin remote URL에서 owner/repo 추출
  const remoteUrl = await git(projectPath, ['remote', 'get-url', 'origin']);
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
  const cached = cache.get(path);
  if (cached && Date.now() - cached.ts < CACHE_TTL) {
    return cached.data;
  }

  const [gitStatus, prs] = await Promise.all([
    fetchGitStatus(path),
    fetchOpenPRs(path),
  ]);

  const data: ProjectGitInfo = { git: gitStatus, prs };
  cache.set(path, { data, ts: Date.now() });
  return data;
}

export function startGitStatusPoller(
  getPaths: () => string[],
  intervalMs: number = 30_000,
): NodeJS.Timeout {
  return setInterval(async () => {
    const paths = getPaths();
    // 백그라운드 갱신 — 에러 무시
    await Promise.allSettled(paths.map((p) => getProjectGitInfo(p)));
  }, intervalMs);
}

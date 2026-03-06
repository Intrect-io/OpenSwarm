// ============================================
// OpenSwarm - Git Worktree Manager
// Per-issue independent worktree creation/cleanup and PR automation
// ============================================

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, rmSync } from 'node:fs';
import { registerOwnedPR } from '../automation/prOwnership.js';
import { runConventionalCommitGuard } from '../agents/pipelineGuards.js';

const execFileAsync = promisify(execFile);

/** Safe git command execution (no shell) */
async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args]);
  return stdout;
}

/** Safe gh command execution (no shell) */
async function gh(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args);
  return stdout;
}

// ============================================
// Types
// ============================================

export interface WorktreeInfo {
  /** {repoPath}/worktree/{issueId} */
  worktreePath: string;
  /** swarm/INT-XXX-slug */
  branchName: string;
  /** Original repository path */
  originalPath: string;
  issueId: string;
}

// ============================================
// Branch & Path Utilities
// ============================================

/** Generate branch name: swarm/INT-512-llm-tool-interface */
export function buildBranchName(issueIdentifier: string, title: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `swarm/${issueIdentifier}-${slug}`;
}

// ============================================
// Worktree Lifecycle
// ============================================

/** Create git worktree + checkout branch */
export async function createWorktree(
  repoPath: string,
  issueId: string,
  branchName: string,
): Promise<WorktreeInfo> {
  const worktreePath = `${repoPath}/worktree/${issueId}`;

  // Clean up existing worktree (retry case)
  if (existsSync(worktreePath)) {
    await git(repoPath, 'worktree', 'remove', '--force', worktreePath).catch((e) => console.warn(`[Worktree] Failed to remove existing worktree: ${worktreePath}`, e));
    rmSync(worktreePath, { recursive: true, force: true });
  }

  // Always create fresh branch from latest main to avoid conflicts
  // Delete existing branch if it exists (force clean state)
  const branchExists = await git(repoPath, 'branch', '--list', branchName)
    .then((out) => out.trim().length > 0)
    .catch((e) => { console.warn(`[Worktree] Branch check failed for ${branchName}:`, e); return false; });

  if (branchExists) {
    // Delete old branch to start fresh
    await git(repoPath, 'branch', '-D', branchName).catch((e) =>
      console.warn(`[Worktree] Failed to delete old branch ${branchName}:`, e)
    );
  }

  // Update main to latest
  await git(repoPath, 'fetch', 'origin', 'main').catch((e) =>
    console.warn(`[Worktree] Failed to fetch origin/main:`, e)
  );

  // Create fresh worktree from origin/main
  await git(repoPath, 'worktree', 'add', '-b', branchName, worktreePath, 'origin/main');
  console.log(`[Worktree] Created: ${worktreePath} (branch: ${branchName})`);

  return { worktreePath, branchName, originalPath: repoPath, issueId };
}

/** Commit changes + push + gh pr create */
export async function commitAndCreatePR(
  info: WorktreeInfo,
  title: string,
  issueIdentifier: string,
  description: string,
): Promise<string> {
  const { worktreePath, branchName } = info;

  // Check for changes and commit
  const status = await git(worktreePath, 'status', '--porcelain');
  if (status.trim()) {
    await git(worktreePath, 'add', '-A');
    const commitMsg = [
      `feat(${issueIdentifier}): ${title.slice(0, 72)}`,
      '',
      '🤖 Generated with OpenSwarm',
      '',
      'Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>',
    ].join('\n');

    // Validate conventional commit format (warning only)
    const commitCheck = runConventionalCommitGuard(commitMsg);
    if (!commitCheck.passed) {
      console.warn(`[Worktree] Commit format warning: ${commitCheck.issues.join('; ')}`);
    }

    await git(worktreePath, 'commit', '-m', commitMsg);
  }

  // push
  await git(worktreePath, 'push', '-u', 'origin', branchName, '--force-with-lease');

  // If PR already exists, just return the URL
  const existing = await gh('pr', 'list', '--head', branchName, '--state', 'open', '--json', 'url', '--jq', '.[0].url')
    .catch((e) => { console.warn(`[Worktree] PR list check failed for ${branchName}:`, e); return ''; });

  if (existing.trim()) {
    console.log(`[Worktree] PR already exists: ${existing.trim()}`);
    return existing.trim();
  }

  // Create PR
  const prBody = [
    '## Summary',
    description || `${issueIdentifier}: ${title}`,
    '',
    '## Linear',
    `Closes ${issueIdentifier}`,
    '',
    '---',
    '🤖 Generated with [OpenSwarm](https://github.com/Intrect-io/OpenSwarm)',
  ].join('\n');

  const prUrl = await gh('pr', 'create', '--head', branchName, '--base', 'main', '--title', title, '--body', prBody);

  const url = prUrl.trim();
  console.log(`[Worktree] PR created: ${url}`);

  // Register PR ownership for conflict auto-resolution
  const prNumberMatch = url.match(/\/pull\/(\d+)/);
  if (prNumberMatch) {
    const repoMatch = url.match(/github\.com\/([^/]+\/[^/]+)/);
    const repo = repoMatch ? repoMatch[1] : '';
    if (repo) {
      await registerOwnedPR({
        repo,
        prNumber: parseInt(prNumberMatch[1], 10),
        branch: branchName,
        createdAt: new Date().toISOString(),
        issueIdentifier: issueIdentifier,
      }).catch((err) => console.warn(`[Worktree] Failed to register PR ownership:`, err));
    }
  }

  return url;
}

/** Clean up worktree */
export async function removeWorktree(info: WorktreeInfo): Promise<void> {
  try {
    await git(info.originalPath, 'worktree', 'remove', '--force', info.worktreePath);
    console.log(`[Worktree] Removed: ${info.worktreePath}`);
  } catch {
    // fallback: direct removal
    rmSync(info.worktreePath, { recursive: true, force: true });
    console.log(`[Worktree] Force removed: ${info.worktreePath}`);
  }
}

/** Clean up dangling worktrees on service start */
export async function pruneWorktrees(repoPath: string): Promise<void> {
  await git(repoPath, 'worktree', 'prune').catch((e) => console.warn(`[Worktree] Prune failed for ${repoPath}:`, e));
  console.log(`[Worktree] Pruned stale worktrees for: ${repoPath}`);
}

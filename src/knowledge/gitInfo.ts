// ============================================
// OpenSwarm - Git Info for Knowledge Graph
// Git log based churn score, recent changes, contributor tracking
// ============================================

import { spawn } from 'node:child_process';
import type { KnowledgeGraph } from './graph.js';
import type { GitInfo } from './types.js';

// Git Command Runner (same pattern as gitTracker.ts)

function runGitCommand(cwd: string, args: string[], timeoutMs: number = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('git', args, { cwd });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`git command timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`git ${args.join(' ')} failed: ${stderr}`));
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// Churn Calculation

interface FileChurn {
  path: string;
  commitCount: number;
  lastCommitDate: number;
}

/**
 * Calculate per-file commit count over the last 30 days
 */
async function getFileChurns(projectPath: string, sinceDays: number = 30): Promise<Map<string, FileChurn>> {
  const churns = new Map<string, FileChurn>();

  try {
    // git log --since="30 days ago" --name-only --format="%ct"
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '-z',
      '--format=%ct',
    ]);

    let currentTimestamp = 0;

    for (const token of output.split('\0')) {
      if (!token) continue;
      const timestampToken = token.trim();

      // If numeric, it's a commit timestamp
      if (/^\d+$/.test(timestampToken)) {
        currentTimestamp = parseInt(timestampToken, 10) * 1000; // Convert to ms
        continue;
      }

      // `-z` preserves embedded newlines and other whitespace in filenames.
      const filePath = token.startsWith('\n') ? token.slice(1) : token;
      if (!filePath) continue;
      const existing = churns.get(filePath);
      if (existing) {
        existing.commitCount++;
        if (currentTimestamp > existing.lastCommitDate) {
          existing.lastCommitDate = currentTimestamp;
        }
      } else {
        churns.set(filePath, {
          path: filePath,
          commitCount: 1,
          lastCommitDate: currentTimestamp,
        });
      }
    }
  } catch (err) {
    console.warn(`[GitInfo] Failed to get file churns:`, err);
  }

  return churns;
}

/**
 * Enrich all modules in the graph with Git info
 */
export async function enrichWithGitInfo(
  graph: KnowledgeGraph,
  projectPath: string,
  sinceDays: number = 30,
): Promise<void> {
  const churns = await getFileChurns(projectPath, sinceDays);

  if (churns.size === 0) return;

  // Maximum value for churn score normalization
  const maxCommits = Math.max(...Array.from(churns.values()).map(c => c.commitCount), 1);

  const modules = [
    ...graph.getNodesByType('module'),
    ...graph.getNodesByType('test_file'),
  ];

  for (const mod of modules) {
    const churn = churns.get(mod.path);
    if (churn) {
      const gitInfo: GitInfo = {
        lastCommitDate: churn.lastCommitDate,
        commitCount30d: churn.commitCount,
        churnScore: Math.round((churn.commitCount / maxCommits) * 1000) / 1000,
      };
      mod.gitInfo = gitInfo;
    } else {
      // File not in git history (no changes in 30 days)
      mod.gitInfo = {
        lastCommitDate: 0,
        commitCount30d: 0,
        churnScore: 0,
      };
    }
  }

  console.log(`[GitInfo] Enriched ${modules.length} modules with git data (${churns.size} files had changes in ${sinceDays}d)`);
}

/**
 * List of recently changed files (for incremental update trigger)
 */
export async function getRecentlyChangedFiles(
  projectPath: string,
  sinceTimestamp: number,
): Promise<string[]> {
  const files = new Set<string>();
  try {
    const sinceDate = new Date(sinceTimestamp).toISOString();
    const committed = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDate}`,
      '--name-only',
      '--format=',
    ]);
    for (const line of committed.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }

    const untracked = await runGitCommand(projectPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    for (const token of untracked.split('\0')) {
      const trimmed = token.trim();
      if (trimmed) files.add(trimmed);
    }

    return Array.from(files);
  } catch {
    return [];
  }
}

/**
 * Older form kept for callers that already have a since-date string.
 */
export async function getFilesChangedSince(
  projectPath: string,
  sinceDate: string,
): Promise<string[]> {
  const files = new Set<string>();
  try {
    const committed = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDate}`,
      '--name-only',
      '--format=',
    ]);
    for (const line of committed.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }

    const untracked = await runGitCommand(projectPath, [
      'ls-files',
      '--others',
      '--exclude-standard',
      '-z',
    ]);
    for (const token of untracked.split('\0')) {
      const trimmed = token.trim();
      if (trimmed) files.add(trimmed);
    }

    return Array.from(files);
  } catch {
    return [];
  }
}

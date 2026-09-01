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
 * Calculate per-file commit count over the last 30 days using NUL-delimited
 * `git log` output.  The format emits alternating timestamp\0filename\0…
 * tokens; position in the split determines which is which, so a numeric
 * filename like "12345" is never mistaken for a timestamp.
 */
async function getFileChurns(projectPath: string, sinceDays: number = 30): Promise<Map<string, FileChurn>> {
  const churns = new Map<string, FileChurn>();

  try {
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '-z',
      '--format=%ct',
    ]);

    let currentTimestamp = 0;
    // `git log --format='%ct' -z --name-only` emits alternating
    // timestamp\0filename\0timestamp\0filename\0…  Using position in the
    // split (even = timestamp, odd = filename) avoids misclassifying a
    // numeric filename like "12345" as a timestamp.
    const tokens = output.split('\0');

    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;

      // Even indices (0, 2, 4, …) are commit timestamps
      if (i % 2 === 0) {
        const parsed = parseInt(token.trim(), 10);
        if (isNaN(parsed)) {
          continue; // Skip invalid timestamps, though they shouldn't occur
        }
        currentTimestamp = parsed * 1000; // Convert to ms
        continue;
      }

      // `-z` preserves embedded newlines and other whitespace in filenames.
      // Do not attempt to parse the token as a number; treat as filename unconditionally.
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
    const path = mod.path || mod.id;
    const churn = churns.get(path);
    if (!churn) continue;

    const gitInfo: GitInfo = {
      churnScore: churn.commitCount / maxCommits,
      lastCommitDate: churn.lastCommitDate,
      commitCount: churn.commitCount,
    };

    mod.setMetadata('gitInfo', gitInfo);
  }
}

/**
 * Get recently changed files since a given timestamp
 * (used for incremental update trigger)
 */
export async function getRecentlyChangedFiles(
  projectPath: string,
  sinceTimestamp: number,
): Promise<string[]> {
  try {
    const sinceDate = new Date(sinceTimestamp).toISOString();
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDate}`,
      '--name-only',
      '--format=',
    ]);

    const files = new Set<string>();
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (trimmed) files.add(trimmed);
    }

    return Array.from(files);
  } catch {
    return [];
  }
}
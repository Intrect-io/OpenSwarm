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
 * Calculate per-file commit count over the last 30 days.
 */
export async function getFileChurns(projectPath: string, sinceDays: number = 30): Promise<Map<string, FileChurn>> {
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();
  const output = await runGitCommand(projectPath, [
    'log',
    `--since=${since}`,
    '--name-only',
    '--format=',
  ]);

  const counts = new Map<string, number>();
  const lastDates = new Map<string, number>();

  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    lastDates.set(trimmed, Date.now());
  }

  const result = new Map<string, FileChurn>();
  for (const [path, commitCount] of counts) {
    result.set(path, { path, commitCount, lastCommitDate: lastDates.get(path) ?? 0 });
  }
  return result;
}

/**
 * Enrich graph nodes with git churn data.
 */
export async function enrichWithGitInfo(graph: KnowledgeGraph, projectPath: string): Promise<void> {
  const churns = await getFileChurns(projectPath);
  for (const node of graph.getNodes()) {
    const churn = churns.get(node.path);
    if (churn) {
      node.churnScore = churn.commitCount;
    }
  }
}

/**
 * Get files changed since a given timestamp (for incremental update trigger).
 * Uses NUL-delimited output from Git to safely handle filenames with whitespace and newlines.
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
      '-z',
    ]);

    // NUL-delimited output: split on \0, filter empty strings.
    const files = new Set<string>();
    for (const entry of output.split('\0')) {
      const trimmed = entry.trim();
      if (trimmed) files.add(trimmed);
    }

    return Array.from(files);
  } catch {
    return [];
  }
}
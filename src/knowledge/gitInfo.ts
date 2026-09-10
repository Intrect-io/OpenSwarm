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
 * Parse NUL-delimited `git log -z --format=%ct --name-only` output.
 *
 * Empty tokens reset to "expecting timestamp" (commit boundary). The first
 * non-empty token after reset is the timestamp; subsequent non-empty tokens
 * are filenames and are never parsed as numbers (handles optional leading `\n`).
 *
 * Timestamp tokens are validated as all-digit before parseInt, so a numeric
 * filename like "12345" that somehow lands in the timestamp slot is rejected
 * and treated as a zero-timestamp entry rather than a misclassified date.
 */
export function parseNulDelimitedChurnOutput(
  output: string,
): Map<string, { path: string; commitCount: number; lastCommitDate: number }> {
  const churns = new Map<string, FileChurn>();
  let expectingTimestamp = true;
  let currentTimestamp = 0;

  for (const token of output.split('\0')) {
    if (!token) {
      expectingTimestamp = true;
      continue;
    }

    if (expectingTimestamp) {
      const trimmed = token.trim();
      // Only accept all-digit tokens as timestamps; a numeric filename like
      // "12345" that somehow lands in the timestamp slot is rejected, keeping
      // currentTimestamp at 0 so the file still appears in the churn map.
      if (/^\d+$/.test(trimmed)) {
        const parsed = parseInt(trimmed, 10);
        currentTimestamp = Number.isFinite(parsed) ? parsed * 1000 : 0;
      } else {
        currentTimestamp = 0;
      }
      expectingTimestamp = false;
      continue;
    }

    // Filenames are NEVER parsed as numbers — even if named "12345".
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

  return churns;
}

/**
 * Calculate per-file commit count over the last 30 days
 */
async function getFileChurns(projectPath: string, sinceDays: number = 30): Promise<Map<string, FileChurn>> {
  try {
    // git log --since="30 days ago" --name-only --format="%ct"
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '-z',
      '--format=%ct',
    ]);

    return parseNulDelimitedChurnOutput(output);
  } catch (err) {
    return new Map();
  }
}

/**
 * Enrich the knowledge graph with git-based churn data
 */
export async function enrichWithGitInfo(graph: KnowledgeGraph, projectPath: string): Promise<void> {
  const churns = await getFileChurns(projectPath);
  for (const [filePath, churn] of churns) {
    const node = graph.getNode(filePath);
    if (node) {
      node.metadata = {
        ...node.metadata,
        commitCount: churn.commitCount,
        lastCommitDate: churn.lastCommitDate,
      };
    }
  }
}

/**
 * Get files changed since a given timestamp (for incremental update trigger)
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
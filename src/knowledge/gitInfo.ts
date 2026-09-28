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
    // `%x01` marks each commit record so a purely numeric filename is never
    // mistaken for a timestamp; `-z` preserves embedded newlines in filenames.
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '-z',
      '--format=%x01%ct',
    ]);

    let currentTimestamp = 0;
    let separatorPending = false;

    for (const token of output.split('\0')) {
      if (!token) continue;

      // \x01 marks a commit record here, the same sentinel the `--format` above
      // emits; the control character is the point, not an accident.
      // eslint-disable-next-line no-control-regex
      const record = /^\x01(\d+)$/.exec(token);
      if (record) {
        currentTimestamp = parseInt(record[1], 10) * 1000; // Convert to ms
        separatorPending = true;
        continue;
      }

      // The name token right after a commit record carries git's header/body separator.
      const filePath = separatorPending && token.startsWith('\n') ? token.slice(1) : token;
      separatorPending = false;
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

  // Every query is NUL-delimited and tokens are taken verbatim: git paths may
  // contain newlines, and trimming would corrupt leading/trailing-space names.
  const collect = async (args: string[]): Promise<void> => {
    try {
      for (const token of (await runGitCommand(projectPath, args)).split('\0')) {
        if (token) files.add(token);
      }
    } catch {
      // One failing query (a repo without commits, a non-repo path) must not
      // discard the results of the others.
    }
  };

  const sinceDate = new Date(sinceTimestamp).toISOString();
  // `--format=` omits the commit header, so no separator token precedes the
  // first path of each commit.
  await collect(['log', `--since=${sinceDate}`, '--name-only', '--format=', '-z']);
  await collect(['diff', '--cached', '--name-only', '-z']);
  await collect(['diff', '--name-only', '-z']);
  await collect(['ls-files', '--others', '--exclude-standard', '-z']);

  return Array.from(files);
}

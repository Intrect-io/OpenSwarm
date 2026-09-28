// ============================================
// OpenSwarm - Git Info for Knowledge Graph
// Git log based churn score, recent changes, contributor tracking
// ============================================

import { spawn } from 'node:child_process';
import type { KnowledgeGraph } from './graph.js';
import type { GitInfo } from './types.js';
import { saveGraph } from './store.js';

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
 * `git log --format=%x1e%ct` prefixes every timestamp with an ASCII
 * record-separator, so a timestamp token is self-identifying. Without it a
 * numeric filename (`12345`) is indistinguishable from a commit timestamp —
 * main's parser dropped such files entirely, and a state machine that assumes
 * an empty NUL token between commits misreads the *next* commit's timestamp as
 * a filename, because real `git log -z` output has no such empty token.
 */
const CHURN_TIMESTAMP_SENTINEL = '\x1e';

/**
 * Parse NUL-delimited `git log -z --format=%x1e%ct --name-only` output into
 * per-file churn counts. Tokens prefixed with the sentinel are timestamps;
 * every other token is a filename and is NEVER parsed as a number, even when
 * the file is named `12345`. Git prefixes each commit's first filename with the
 * newline that terminates the format, which is stripped here.
 */
export function parseNulDelimitedChurnOutput(output: string): Map<string, FileChurn> {
  const churns = new Map<string, FileChurn>();
  let currentTimestamp = 0;
  let separatorPending = false;

  for (const token of output.split('\0')) {
    if (!token) continue;

    if (token.startsWith(CHURN_TIMESTAMP_SENTINEL)) {
      const trimmed = token.slice(CHURN_TIMESTAMP_SENTINEL.length).trim();
      currentTimestamp = /^\d+$/.test(trimmed) ? parseInt(trimmed, 10) * 1000 : 0;
      separatorPending = true;
      continue;
    }

    // Only the FIRST name after a commit record carries git's format-terminating
    // newline. Stripping it unconditionally would corrupt a later path that
    // genuinely begins with a newline ('\nmid.ts' → 'mid.ts').
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

  return churns;
}

/**
 * Calculate per-file commit count over the last 30 days
 */
async function getFileChurns(projectPath: string, sinceDays: number = 30): Promise<Map<string, FileChurn>> {
  const churns = new Map<string, FileChurn>();

  try {
    // git log --since="30 days ago" --name-only --format="%x1e%ct"
    const output = await runGitCommand(projectPath, [
      'log',
      `--since=${sinceDays} days ago`,
      '--name-only',
      '-z',
      '--format=%x1e%ct',
    ]);

    return parseNulDelimitedChurnOutput(output);
  } catch (err) {
    console.warn(`[GitInfo] Failed to get file churns:`, err);
    return churns;
  }
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
    const gitInfo: GitInfo = churn
      ? {
        lastCommitDate: churn.lastCommitDate,
        commitCount30d: churn.commitCount,
        churnScore: Math.round((churn.commitCount / maxCommits) * 1000) / 1000,
      }
      : {
        lastCommitDate: 0,
        commitCount30d: 0,
        churnScore: 0,
      };
    // addNode REPLACES the entry — writing mod.gitInfo directly only mutated the
    // copy callers already held, so churn data was recomputed on every load and
    // never survived a process restart. (AGT-3420) metrics is copied so the graph
    // never shares a mutable object with the node a caller still holds.
    graph.addNode({
      ...mod,
      metrics: mod.metrics ? { ...mod.metrics } : undefined,
      gitInfo,
    });
  }

  await saveGraph(graph);

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
  // Staged-but-uncommitted and not-yet-staged edits are invisible to `git log`
  // but still need an incremental refresh (AGT-3490).
  await collect(['diff', '--cached', '--name-only', '-z']);
  await collect(['diff', '--name-only', '-z']);
  await collect(['ls-files', '--others', '--exclude-standard', '-z']);

  return Array.from(files);
}

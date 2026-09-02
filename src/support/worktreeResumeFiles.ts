// ============================================
// OpenSwarm - Resumed worktree file attribution
// ============================================
//
// Which files a resumed worktree should hand back to the worker as "work this
// task has already done". Split out of worktreeManager.ts, which sits at the
// repository's 1500-line file cap.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isEphemeralWorktreeArtifact } from './worktreeEphemeral.js';
import { resolveBaseRef } from './worktreeManager.js';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 60_000;
const PRESERVE_MARKER = '.openswarm-preserved';

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS });
  return stdout;
}

async function getPreservedTaskFiles(worktreePath: string): Promise<string[]> {
  const log = await git(worktreePath, 'log', '--format=%H%x09%s', '-n', '100').catch(() => '');
  const commits = log.split('\n').filter(Boolean).map((line) => {
    const tab = line.indexOf('\t');
    return { hash: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
  // Artifact-purge commits are an internal continuation of the same WIP
  // checkpoint. Treating them as a new base would make the actual source diff
  // disappear on the next resume.
  const isPreservedWip = (subject: string): boolean =>
    subject.startsWith('wip: preserved partial work')
    || subject === 'wip: remove ephemeral runtime artifacts (auto)';
  let preservedCount = 0;
  while (commits[preservedCount] && isPreservedWip(commits[preservedCount].subject)) preservedCount += 1;
  if (preservedCount === 0) return [];

  const base = commits[preservedCount]?.hash;
  const diffArgs = base
    ? ['diff', '--name-only', base, 'HEAD']
    : ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', 'HEAD'];
  return dedupeTaskFiles(await git(worktreePath, ...diffArgs));
}

function dedupeTaskFiles(files: string): string[] {
  return [...new Set(files.split('\n').filter((file) =>
    file && file !== PRESERVE_MARKER && !isEphemeralWorktreeArtifact(file)
  ))];
}

/**
 * Files this task has already written in this worktree, whether they sit in
 * WIP-preserve commits or in the task commits earlier attempts made.
 *
 * Only the WIP case used to count. A resumed branch whose work was already
 * committed therefore looked empty to the worker: it made no new edit (the
 * work is done), Git reported no diff, and the run failed on the zero-diff
 * contract before publication ever saw the branch. vega-agent AGT-3844 sat on
 * five such commits at attempt 53 and cgf-portal AX-868 on six at attempt 27,
 * with no pull request for either — finished work, stranded.
 */
export async function getResumedTaskFiles(worktreePath: string): Promise<string[]> {
  const preserved = await getPreservedTaskFiles(worktreePath);
  if (preserved.length > 0) return preserved;
  const base = await resolveBaseRef(worktreePath).catch(() => null);
  if (!base) return [];
  const committed = await git(worktreePath, 'diff', '--name-only', `${base.ref}...HEAD`).catch(() => '');
  return dedupeTaskFiles(committed);
}

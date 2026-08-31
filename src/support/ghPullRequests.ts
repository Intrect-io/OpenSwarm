// ============================================
// OpenSwarm — GitHub CLI access and the duplicate-issue PR guard
// ============================================
//
// Owns the `gh` invocation so worktreeManager.ts, which sits on the 1500-line
// pre-commit cap, does not have to.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GH_TIMEOUT_MS = 5 * 60_000;

/** A PR as the duplicate guard reads it. */
export interface IssuePullRequest {
  number: number;
  url: string;
  headRefName: string;
}

/**
 * Safe gh command execution (no shell). `cwd` must be inside the target repo —
 * gh infers the repository from the working directory, and the daemon's own
 * cwd is typically NOT a git repo (e.g. started from $HOME), which made every
 * `gh pr create` die with "fatal: not a git repository" while the push (which
 * does pass a cwd) succeeded — completed work stranded on remote branches with
 * no PR. (INT-2321)
 */
export async function gh(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, { cwd, timeout: GH_TIMEOUT_MS });
  return stdout;
}

// Duplicate-issue-PR guard (INT-2544)
//
// Two parallel workers can each independently implement the same Linear issue on
// their own branch and both open PRs — nothing checked whether one already exists.
// Real incident: STONKS STO-1400 (PR #224 merged + PR #226 left open, CONFLICTING)
// and STO-1454 (PR #221 merged + PR #228 left open, CONFLICTING) sat undetected
// until a human noticed the "File overlap with in-flight work" comment and ran
// `git merge-tree` by hand. Every OpenSwarm PR body literally contains
// `Closes <issueIdentifier>`, so a GitHub body search finds siblings regardless of
// branch name or merge state.

/** Other PRs (any state) whose body already closes this Linear issue, excluding
 *  this branch's own PR. Best-effort — any gh failure returns [] rather than
 *  blocking PR creation. */
export async function findDuplicateIssuePRs(
  worktreePath: string,
  issueIdentifier: string,
  selfBranch: string,
): Promise<IssuePullRequest[]> {
  try {
    const raw = await gh(
      worktreePath, 'pr', 'list',
      '--search', `"Closes ${issueIdentifier}" in:body`,
      '--state', 'all',
      '--json', 'number,url,headRefName',
      '--limit', '10',
    );
    const prs: IssuePullRequest[] = JSON.parse(raw || '[]');
    return prs.filter((pr) => pr.headRefName !== selfBranch);
  } catch (err) {
    console.warn('[Worktree] Duplicate-issue-PR check skipped:', err);
    return [];
  }
}

/** Render the duplicate-PR warning as a PR-body markdown section ('' if none). */
export function formatDuplicateIssueSection(
  issueIdentifier: string,
  duplicates: IssuePullRequest[],
): string {
  if (duplicates.length === 0) return '';
  return [
    '## ⚠️ Possible duplicate work',
    '',
    `${duplicates.length} other PR(s) already reference \`Closes ${issueIdentifier}\` — opened as a draft. Verify this isn't redundant with already-merged work before marking ready and merging:`,
    '',
    ...duplicates.map((d) => `- ${d.url} (${d.headRefName})`),
  ].join('\n');
}

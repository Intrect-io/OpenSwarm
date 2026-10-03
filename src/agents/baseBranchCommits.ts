// Created: 2026-10-03
// Purpose: tell the drafter which commits on the base branch already mention the issue (AGT-4674)
// Dependencies: git
// Test Status: baseBranchCommits.test.ts

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Tracker identifiers look like `AX-1828`; anything else is not looked up. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9]{0,15}-\d{1,7}$/;
/** First one that resolves wins: the remote default, then the usual names. */
const BASE_REFS = ['origin/HEAD', 'origin/main', 'origin/master', 'main', 'master'];
const MAX_LISTED = 8;
const SCAN_LIMIT = 40;
const GIT_TIMEOUT_MS = 5_000;
const RECORD = '\x1e';

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 512 * 1024 });
  return String(stdout);
}

/**
 * The newest commits on the base branch whose message mentions `identifier`, as
 * `<short sha> <date> <subject>` lines. A fix for an open issue may already have
 * landed there by a person or another run; without this the worker rebuilds it
 * (AX-1828: seven attempts and a PR over tests `main` already carried).
 *
 * Never throws and never lists more than {@link MAX_LISTED}: a missing ref, a
 * non-repository or a slow git means an empty list, which is the old behaviour.
 */
export async function findBaseCommitsForIssue(
  projectPath: string,
  identifier: string | undefined,
): Promise<string[]> {
  if (!identifier || !IDENTIFIER.test(identifier)) return [];
  try {
    for (const ref of BASE_REFS) {
      try {
        await git(projectPath, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
      } catch {
        continue;
      }
      const log = await git(projectPath, [
        'log', ref, '--fixed-strings', `--grep=${identifier}`, '-n', String(SCAN_LIMIT),
        `--format=${RECORD}%h %cs %s%n%b`,
      ]);
      // `--grep` is a substring match: AX-18281 contains AX-1828.
      const mentions = new RegExp(`(^|[^A-Za-z0-9-])${identifier}(?![0-9])`, 'i');
      return log
        .split(RECORD)
        .filter((record) => mentions.test(record))
        .map((record) => (record.split('\n')[0] ?? '').trim().slice(0, 200))
        .filter(Boolean)
        .slice(0, MAX_LISTED);
    }
  } catch {
    // fall through: no list is the pre-existing behaviour
  }
  return [];
}

/** The brief section, or an empty string when the base branch has nothing for the issue. */
export function formatBaseCommitsSection(commits: readonly string[]): string {
  if (commits.length === 0) return '';
  return `## Already on the base branch for this issue
These commits on the base branch already mention this issue, yet the issue is still open, so part of its work may be done and part may not. Before planning anything, read what they changed, compare that with the issue's checklist, and build only what is missing. If they cover everything, say so in the brief instead of redoing it.
${commits.map((commit) => `- ${commit}`).join('\n')}
`;
}

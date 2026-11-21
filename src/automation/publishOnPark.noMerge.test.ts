// Created: 2026-11-21
// Purpose: Static guard (AGT-4414) that the publish path never merges a pull request; local git merge stays allowed.
// Dependencies: vitest, node:fs, node:url
// Test Status: passing

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/** Source files on the publish path; none may land a PR. */
const PUBLISH_PATH_FILES: readonly string[] = [
  './publishOnPark.ts',
  './publicationReviewHook.ts',
  '../support/worktreeManager.ts',
  '../support/ghPullRequests.ts',
];

const Q = `['"\`]`;

/** PR-merge forms. Local `git merge`, `merge-base` and the word "merged" are not matched. */
const PR_MERGE_FORMS: ReadonlyArray<{ pattern: RegExp; what: string }> = [
  { pattern: /\bgh[ \t]+pr[ \t]+(?:\S+[ \t]+)*?merge\b/, what: 'gh pr merge command text' },
  { pattern: new RegExp(`${Q}pr[ \\t]+(?:\\S+[ \\t]+)*?merge\\b`), what: "'pr merge' string argument" },
  { pattern: new RegExp(`${Q}pr${Q}\\s*,[^)\\]]*?${Q}merge${Q}`), what: "'pr', 'merge' argument list" },
  { pattern: new RegExp(`\\bgh\\w*\\s*\\([^)]*${Q}merge${Q}`), what: "'merge' passed to a gh helper" },
  { pattern: new RegExp(`${Q}gh${Q}\\s*,\\s*\\[[^\\]]*${Q}merge${Q}`), what: "'merge' in a gh argv array" },
  { pattern: /(?:repos|pulls)\/[^'"`\s]*\/merges?\b/, what: 'merge REST endpoint' },
  { pattern: new RegExp(`/merges?${Q}`), what: '/merge or /merges endpoint string' },
  { pattern: /\b(?:mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/, what: 'GraphQL merge mutation' },
  { pattern: new RegExp(`${Q}--(?:auto|squash|merge)${Q}`), what: 'gh pr merge flag' },
  { pattern: /--auto\s+--(?:squash|merge|rebase)\b|--(?:squash|merge|rebase)\s+--auto\b/, what: '--auto merge flags' },
  { pattern: /\.(?:pulls|repos)\.merge\w*\s*\(/, what: 'octokit merge call' },
  { pattern: /\brequest\s*\(\s*['"`][A-Z]+\s+[^'"`]*\/merges?\b/, what: 'octokit request to a merge endpoint' },
];

function prMergeFormsIn(source: string): string[] {
  return PR_MERGE_FORMS.filter(({ pattern }) => pattern.test(source)).map(({ what }) => what);
}

describe('PR-merge matcher self-test', () => {
  it.each([
    "gh(['pr','merge','7'])",
    "gh(cwd, 'pr', 'merge', String(n), '--squash')",
    "execFile('gh', ['pr', 'merge', '7'])",
    "execFile('gh', ['merge', '7'])",
    "gh(cwd, 'pr merge 7')",
    "'repos/o/r/pulls/7/merge'",
    '`repos/${owner}/${repo}/pulls/${n}/merge`',
    "'repos/o/r/merges'",
    '`${base}/merge`',
    'mergePullRequest',
    'enablePullRequestAutoMerge',
    'mergeBranch',
    "runGh(['pr', 'view', '7', '--auto'])",
    'gh pr merge 7 --auto --squash',
    'gh pr -R o/r merge 7',
    'octokit.pulls.merge({ owner, repo, pull_number: 7 })',
    "octokit.request('PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge')",
  ])('flags %s', (snippet) => {
    expect(prMergeFormsIn(snippet)).not.toEqual([]);
  });

  it.each([
    "git(['merge','--abort'])",
    "await git(worktreePath, 'merge', '--abort');",
    "git(worktreePath, 'merge-base', '--is-ancestor', pr.mergeCommit.oid, 'HEAD')",
    "gh(worktreePath, 'pr', 'list', '--state', 'merged', '--json', 'number,headRefName,mergeCommit', '--limit', '30')",
    "state: 'OPEN' | 'CLOSED' | 'MERGED';",
    '// A branch that no longer merges into its base gets no CI from GitHub',
    'gh pr view 7 --json mergeable,state',
  ])('allows %s', (snippet) => {
    expect(prMergeFormsIn(snippet)).toEqual([]);
  });
});

describe('publish path never merges a pull request (AGT-4414)', () => {
  it.each(PUBLISH_PATH_FILES)('%s contains no PR-merge form', (rel) => {
    const source = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    expect(source.length).toBeGreaterThan(0);
    expect(prMergeFormsIn(source)).toEqual([]);
  });
});

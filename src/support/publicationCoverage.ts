// ============================================
// OpenSwarm — what a published PR claims about its issue (AGT-4786)
// ============================================
//
// Every swarm PR body said `Closes <issue>` and carried the whole issue title,
// so a +3/-0 change against a "15 defects" issue claimed to close all fifteen
// (cgf-portal #1329, #1336). The reviewer now states whether the change covers
// the whole issue (`coverage`), and only an approving verdict that says
// `complete` earns `Closes`. Anything else — `partial`, a verdict that did not
// say, an unreviewed park or stuck draft — is `unknown`, published as
// `[partial] <title>` with `Refs <issue>`, so merging it never auto-closes the
// issue.
//
// Split out of worktreeManager.ts, which sits over the 1000-line file cap.

import { gh } from './ghPullRequests.js';

/** What the reviewer said about how much of the issue the change covers. */
export type ReviewCoverage = 'complete' | 'partial';
/** What a publication may claim: `unknown` is treated exactly like `partial`. */
export type PublicationCoverage = ReviewCoverage | 'unknown';

export const PARTIAL_TITLE_PREFIX = '[partial]';

/** A reviewer's `coverage` field, or undefined when it is missing or not one of the two values. */
export function parseReviewCoverage(raw: unknown): ReviewCoverage | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  return value === 'complete' || value === 'partial' ? value : undefined;
}

/** A prose `Coverage: complete|partial` line, for the reviewer's text fallback. */
export function coverageFromText(text: string): ReviewCoverage | undefined {
  const match = text.match(/^[\s>*_-]*coverage[\s*_]*[:—–-]\s*[*_`]*\s*(complete|partial)\b/im);
  return match ? parseReviewCoverage(match[1]) : undefined;
}

/**
 * The coverage a publication may claim. Only an approving verdict counts:
 * `reviewResult` can hold a synthetic entry (validation nudge, HALT) whose
 * fields say nothing about the change.
 */
export function approvedCoverage(review: { decision?: string; coverage?: ReviewCoverage } | undefined): PublicationCoverage {
  return review?.decision === 'approve' && review.coverage ? review.coverage : 'unknown';
}

function stripPartialPrefix(title: string): string {
  let rest = title.trim();
  while (rest.toLowerCase().startsWith(PARTIAL_TITLE_PREFIX)) rest = rest.slice(PARTIAL_TITLE_PREFIX.length).trim();
  return rest;
}

/** PR title: the issue title, prefixed with `[partial]` unless coverage is complete. Idempotent. */
export function publicationTitle(title: string, coverage: PublicationCoverage | undefined): string {
  const bare = stripPartialPrefix(title);
  return coverage === 'complete' ? bare : `${PARTIAL_TITLE_PREFIX} ${bare}`;
}

/** The PR body's issue line: `Closes` only for complete coverage, `Refs` otherwise. */
export function issueLinkLine(issueIdentifier: string, coverage: PublicationCoverage | undefined): string {
  return `${coverage === 'complete' ? 'Closes' : 'Refs'} ${issueIdentifier}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Replace the body's own `Closes|Refs <issue>` line with the one coverage allows. Pure. */
export function withIssueLinkLine(body: string, issueIdentifier: string, coverage: PublicationCoverage | undefined): string {
  const line = new RegExp(`^(?:Closes|Refs) ${escapeRegExp(issueIdentifier)}$`, 'm');
  return line.test(body) ? body.replace(line, issueLinkLine(issueIdentifier, coverage)) : body;
}

/**
 * Bring a reused PR's title and issue line in line with this publication's
 * coverage. A park opened it as `[partial]`/`Refs` before any review; an
 * approved-complete run reusing it by branch name must not stay partial, and an
 * approved-partial run reusing an older `Closes` PR must not keep `Closes`.
 * Best-effort: the PR is already real, so a failed edit is logged, not thrown.
 */
export async function syncPullRequestCoverage(
  worktreePath: string,
  prUrl: string,
  title: string,
  issueIdentifier: string,
  coverage: PublicationCoverage | undefined,
): Promise<void> {
  if (!issueIdentifier) return;
  try {
    const raw = await gh(worktreePath, 'pr', 'view', prUrl, '--json', 'title,body');
    const current = JSON.parse(raw || '{}') as { title?: string; body?: string };
    const nextTitle = publicationTitle(title, coverage);
    const body = current.body ?? '';
    const nextBody = withIssueLinkLine(body, issueIdentifier, coverage);
    const args: string[] = [];
    if (current.title !== nextTitle) args.push('--title', nextTitle);
    if (nextBody !== body) args.push('--body', nextBody);
    if (args.length > 0) await gh(worktreePath, 'pr', 'edit', prUrl, ...args);
  } catch (error) {
    console.warn(`[Worktree] Could not sync coverage on ${prUrl}:`, error instanceof Error ? error.message : error);
  }
}

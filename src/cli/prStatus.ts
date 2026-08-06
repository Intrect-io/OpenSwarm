// ============================================
// OpenSwarm - PR status snapshot + formatting (INT-3282)
// Priority mirrors Cursor autopilot: conflicts → comments → CI
// ============================================

import type { CIStatus, PRReviewComment } from '../github/github.js';

export type PrBlocker = 'conflicts' | 'comments' | 'ci' | 'pending_ci' | 'none';

export interface PrCommentSummary {
  author: string;
  body: string;
  kind: 'changes_requested' | 'critical_comment' | 'inline';
  path?: string;
  line?: number;
}

export interface PrStatusSnapshot {
  repo: string;
  number: number;
  title: string;
  branch: string;
  url: string;
  mergeable: boolean;
  hasConflicts: boolean;
  ci: CIStatus;
  changesRequested: PrCommentSummary[];
  criticalComments: PrCommentSummary[];
  /** Highest-priority open blocker (autopilot order). */
  blocker: PrBlocker;
  /** True when mergeable, CI green, and no actionable review feedback. */
  mergeReady: boolean;
}

const CRITICAL_KEYWORDS = [
  'critical', '버그', 'bug', '수정 필요', 'must fix', '필수', 'required', '🔴',
];

/** True when a comment body looks like actionable critical feedback. Pure. */
export function isCriticalCommentBody(body: string): boolean {
  const lower = body.toLowerCase();
  return CRITICAL_KEYWORDS.some((k) => lower.includes(k.toLowerCase()));
}

/**
 * Pick the highest-priority blocker.
 * Order: conflicts → review comments → CI failure → CI pending → none.
 * Pure.
 */
export function classifyBlocker(input: {
  hasConflicts: boolean;
  changesRequestedCount: number;
  criticalCommentCount: number;
  ci: CIStatus;
}): PrBlocker {
  if (input.hasConflicts) return 'conflicts';
  if (input.changesRequestedCount > 0 || input.criticalCommentCount > 0) return 'comments';
  if (input.ci.status === 'failure') return 'ci';
  if (input.ci.status === 'pending') return 'pending_ci';
  return 'none';
}

/** Build review-feedback summaries from formal reviews. Pure. */
export function summarizeChangesRequested(
  reviews: PRReviewComment[],
): PrCommentSummary[] {
  const latest = new Map<string, PRReviewComment>();
  for (const review of reviews) {
    const existing = latest.get(review.author);
    if (!existing || new Date(review.createdAt) > new Date(existing.createdAt)) {
      latest.set(review.author, review);
    }
  }
  return Array.from(latest.values())
    .filter((r) => r.state === 'CHANGES_REQUESTED')
    .map((r) => ({
      author: r.author,
      body: (r.body || '').slice(0, 500),
      kind: 'changes_requested' as const,
    }));
}

/** Filter issue comments down to critical ones. Pure. */
export function summarizeCriticalComments(
  comments: Array<{ author: string; body: string }>,
): PrCommentSummary[] {
  return comments
    .filter((c) => isCriticalCommentBody(c.body))
    .map((c) => ({
      author: c.author,
      body: c.body.slice(0, 500),
      kind: 'critical_comment' as const,
    }));
}

export interface PrStatusDeps {
  checkConflicts: (repo: string, prNumber: number) => Promise<boolean>;
  checkCI: (repo: string, prNumber: number) => Promise<CIStatus>;
  getReviews: (repo: string, prNumber: number) => Promise<PRReviewComment[]>;
  getComments: (repo: string, prNumber: number) => Promise<Array<{ author: string; body: string; createdAt: string }>>;
}

async function defaultDeps(): Promise<PrStatusDeps> {
  const gh = await import('../github/github.js');
  return {
    checkConflicts: (repo, n) => gh.checkPRConflicts(repo, n),
    checkCI: (repo, n) => gh.checkPRCIStatus(repo, n),
    getReviews: (repo, n) => gh.getPRReviews(repo, n),
    getComments: (repo, n) => gh.getPRComments(repo, n),
  };
}

export interface GatherStatusInput {
  repo: string;
  number: number;
  title: string;
  branch: string;
  url: string;
}

/** Fetch live PR status and classify the blocker. */
export async function gatherPrStatus(
  input: GatherStatusInput,
  deps?: PrStatusDeps,
): Promise<PrStatusSnapshot> {
  const d = deps ?? (await defaultDeps());
  const [hasConflicts, ci, reviews, comments] = await Promise.all([
    d.checkConflicts(input.repo, input.number),
    d.checkCI(input.repo, input.number),
    d.getReviews(input.repo, input.number),
    d.getComments(input.repo, input.number),
  ]);

  const changesRequested = summarizeChangesRequested(reviews);
  const criticalComments = summarizeCriticalComments(comments);
  const blocker = classifyBlocker({
    hasConflicts,
    changesRequestedCount: changesRequested.length,
    criticalCommentCount: criticalComments.length,
    ci,
  });

  return {
    repo: input.repo,
    number: input.number,
    title: input.title,
    branch: input.branch,
    url: input.url,
    mergeable: !hasConflicts,
    hasConflicts,
    ci,
    changesRequested,
    criticalComments,
    blocker,
    mergeReady: blocker === 'none',
  };
}

/** Human-readable status report. Pure. */
export function formatPrStatus(s: PrStatusSnapshot): string {
  const lines: string[] = [];
  lines.push(`${s.repo}#${s.number} — ${s.title}`);
  lines.push(`  url:      ${s.url}`);
  lines.push(`  branch:   ${s.branch}`);
  lines.push(`  conflicts:${s.hasConflicts ? ' YES' : ' no'}`);

  if (s.ci.status === 'success') {
    lines.push('  ci:       green');
  } else if (s.ci.status === 'pending') {
    lines.push('  ci:       pending');
  } else {
    const names = s.ci.failedChecks.map((c) => c.name).join(', ');
    lines.push(`  ci:       FAIL (${names})`);
  }

  if (s.changesRequested.length) {
    lines.push(`  reviews:  ${s.changesRequested.length} CHANGES_REQUESTED`);
    for (const r of s.changesRequested.slice(0, 5)) {
      lines.push(`    - ${r.author}: ${r.body.split('\n')[0].slice(0, 80)}`);
    }
  } else {
    lines.push('  reviews:  none requesting changes');
  }

  if (s.criticalComments.length) {
    lines.push(`  comments: ${s.criticalComments.length} critical`);
  }

  const blockerLabel: Record<PrBlocker, string> = {
    conflicts: 'merge conflicts',
    comments: 'review / critical comments',
    ci: 'failing CI',
    pending_ci: 'CI still running',
    none: 'none — merge-ready',
  };
  lines.push(`  blocker:  ${blockerLabel[s.blocker]}`);
  lines.push(`  ready:    ${s.mergeReady ? 'yes' : 'no'}`);
  return lines.join('\n');
}

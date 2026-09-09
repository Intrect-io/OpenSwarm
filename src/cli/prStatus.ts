// ============================================
// OpenSwarm - PR status snapshot + formatting (INT-3282)
// Priority mirrors Cursor autopilot: conflicts → comments → CI
// ============================================

import type { CIStatus, PRReviewComment } from '../github/github.js';

export type PrBlocker = 'conflicts' | 'comments' | 'ci' | 'pending_ci' | 'unknown_ci' | 'none';

export interface PrCommentSummary {
  author: string;
  body: string;
  kind: 'changes_requested' | 'critical_comment' | 'inline';
  path?: string;
  line?: number;
  /** Stable discussion key for per-discussion resolution tracking. */
  discussionKey?: string;
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
 * Priority: conflicts > comments > CI failure > pending CI > unknown CI > none.
 */
export function classifyBlocker(opts: {
  hasConflicts: boolean;
  changesRequestedCount: number;
  criticalCommentCount: number;
  ci: CIStatus;
}): PrBlocker {
  if (opts.hasConflicts) return 'conflicts';
  if (opts.changesRequestedCount > 0 || opts.criticalCommentCount > 0) return 'comments';
  if (opts.ci.status === 'failure') return 'ci';
  if (opts.ci.status === 'pending') return 'pending_ci';
  if (opts.ci.status === 'unknown') return 'unknown_ci';
  return 'none';
}

/** Extract changes-requested review summaries. Pure. */
export function summarizeChangesRequested(
  reviews: PRReviewComment[],
): PrCommentSummary[] {
  return reviews
    .filter((r) => r.state === 'CHANGES_REQUESTED')
    .map((r) => ({
      author: r.author,
      body: (r.body || '').slice(0, 500),
      kind: 'changes_requested' as const,
      discussionKey: `review:${r.author}:${r.id ?? r.body?.slice(0, 40)}`,
    }));
}

/**
 * Build a stable discussion key for an issue/PR comment.
 * Uses the comment's node_id when available, otherwise falls back to
 * author+createdAt to produce a stable identifier across calls.
 */
function commentDiscussionKey(c: { author: string; body: string; createdAt?: string; id?: string }): string {
  if (c.id) return `comment:${c.id}`;
  if (c.createdAt) return `comment:${c.author}:${c.createdAt}`;
  return `comment:${c.author}:${c.body.slice(0, 40)}`;
}

/** Filter issue comments down to critical ones. Pure. */
export function summarizeCriticalComments(
  comments: Array<{ author: string; body: string; createdAt?: string; id?: string }>,
): PrCommentSummary[] {
  return comments
    .filter((c) => isCriticalCommentBody(c.body))
    .map((c) => ({
      author: c.author,
      body: c.body.slice(0, 500),
      kind: 'critical_comment' as const,
      discussionKey: commentDiscussionKey(c),
    }));
}

export interface PrStatusDeps {
  checkConflicts: (repo: string, prNumber: number) => Promise<boolean>;
  checkCI: (repo: string, prNumber: number) => Promise<CIStatus>;
  getReviews: (repo: string, prNumber: number) => Promise<PRReviewComment[]>;
  getComments: (repo: string, prNumber: number) => Promise<Array<{ author: string; body: string; createdAt: string; id?: string }>>;
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
  const observedHead = s.ci.status === 'unknown' ? s.ci.observedHeadSha : s.ci.headSha;
  lines.push(`  head:     ${observedHead ?? 'unknown'}`);
  lines.push(`  conflicts:${s.hasConflicts ? ' YES' : ' no'}`);

  if (s.ci.status === 'success') {
    lines.push('  ci:       green');
  } else if (s.ci.status === 'pending') {
    lines.push('  ci:       pending');
  } else if (s.ci.status === 'failure') {
    const names = s.ci.failedChecks.map((c) => c.name).join(', ');
    lines.push(`  ci:       FAIL (${names})`);
  } else {
    const expected = s.ci.expectedHeadSha ? ` expected=${s.ci.expectedHeadSha}` : '';
    lines.push(`  ci:       unknown (${s.ci.reason}${expected})`);
  }

  if (s.changesRequested.length) {
    lines.push(`  reviews:  ${s.changesRequested.length} requesting changes`);
    for (const r of s.changesRequested) {
      lines.push(`    - ${r.author}: ${(r.body || '').replace(/\n/g, ' ').slice(0, 80)}`);
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
    unknown_ci: 'CI head identity unknown',
    none: 'none — merge-ready',
  };
  lines.push(`  blocker:  ${blockerLabel[s.blocker]}`);
  lines.push(`  ready:    ${s.mergeReady ? 'yes' : 'no'}`);
  return lines.join('\n');
}
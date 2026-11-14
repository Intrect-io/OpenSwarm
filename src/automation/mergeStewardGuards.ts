// Created: 2026-11-15
// Purpose: merge steward guard engine, dry-run only — decides whether a factory PR may be merged and why (AGT-4879)
// Dependencies: ../agents/siblingWorkFormat (bookkeeping paths)
// Test Status: mergeStewardGuards.test.ts

/**
 * The merge steward is the only actor allowed to merge a factory PR (AGT-4803,
 * after AGT-4414: an agent merged its own PR seven seconds after opening it).
 * This module is the decision only. It never merges, never shells out and never
 * talks to GitHub: it reads a snapshot gathered elsewhere and returns a verdict
 * with reasons. `evaluateMergeSteward` refuses `dryRun: false` until a real merge
 * path has its own review.
 *
 * Every guard is fail-closed. Evidence that is missing, unknown, truncated, or
 * recorded on a commit other than the current head counts as a failure, so a
 * stale snapshot can never approve a newer push.
 */

import { isBookkeepingPath } from '../agents/siblingWorkFormat.js';

/** Local mirror of the publisher's class (AGT-4804); kept here so the engine does not depend on that PR. */
export type StewardRiskLevel = 'low' | 'medium' | 'high';

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'skipped' | 'cancelled' | 'neutral' | 'unknown';

export interface StewardCheck {
  name: string;
  conclusion: CheckConclusion;
  /** Commit the check ran on. */
  headSha: string;
}

/**
 * One PR's changed paths. `files: null` or `complete: false` means the list could not be read
 * in full. A rename must list both its old and its new path: a sibling editing the old path
 * conflicts just as much.
 */
export interface StewardFileList {
  files: readonly string[] | null;
  /** False when the host truncated the list (e.g. paged API cut off). */
  complete: boolean;
}

export interface StewardSiblingPr extends StewardFileList {
  number: number;
  headRefName: string;
}

export interface StewardReview {
  verdict: 'approve' | 'reject' | 'revise' | 'unknown';
  /** Commit the reviewer looked at. */
  headSha: string;
}

export interface StewardCompleteness {
  verdict: 'complete' | 'partial' | 'unknown';
  headSha: string;
}

export interface StewardRisk {
  level: StewardRiskLevel | null;
  /** Commit whose final diff was classified. */
  headSha: string;
}

/** One submitted GitHub PR review. */
export interface StewardPrReview {
  login: string;
  /** GitHub user type: `User`, `Bot`, `Organization`, … Missing is treated as not human. */
  userType?: string;
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | 'PENDING';
  /** Commit the review was submitted against. */
  commitId: string;
  /** ISO timestamp; reviews are ordered by it. */
  submittedAt: string;
}

export interface StewardSnapshot extends StewardFileList {
  prNumber: number;
  /** Login that opened the PR. Its own approval never counts. */
  author: string;
  /** Submitted reviews on the PR (any order). */
  prReviews: readonly StewardPrReview[];
  /**
   * Logins the factory itself acts as (steward, worker, publisher). Agents here can act
   * under an account whose GitHub type is `User`, so the type alone proves nothing.
   * Empty means "not configured", and then no approval can be trusted.
   */
  automationAccounts: readonly string[];
  /** The PR's current head commit. All evidence must be for this SHA. */
  headSha: string;
  title: string;
  /** Names of the branch-protection required checks. Empty is not "nothing to wait for": it is refused. */
  requiredChecks: readonly string[];
  checks: readonly StewardCheck[];
  risk: StewardRisk | null;
  /** Other open swarm PRs in the same repository. */
  siblings: readonly StewardSiblingPr[];
  review: StewardReview | null;
  completeness: StewardCompleteness | null;
}

export type StewardGuardName = 'required-checks' | 'risk' | 'sibling-overlap' | 'review-completeness';

export interface StewardGuardResult {
  guard: StewardGuardName;
  pass: boolean;
  reason: string;
}

export interface StewardGuard {
  name: StewardGuardName;
  check(snapshot: StewardSnapshot): StewardGuardResult;
}

export interface StewardDecision {
  prNumber: number;
  /** The head the decision was computed for; a different head invalidates it. */
  headSha: string;
  mergeable: boolean;
  dryRun: true;
  results: StewardGuardResult[];
  /** Reasons of the failing guards, in guard order. */
  blockedBy: string[];
}

const pass = (guard: StewardGuardName, reason: string): StewardGuardResult => ({ guard, pass: true, reason });
const fail = (guard: StewardGuardName, reason: string): StewardGuardResult => ({ guard, pass: false, reason });

function short(sha: string): string {
  return sha.slice(0, 12);
}

const requiredChecksGuard: StewardGuard = {
  name: 'required-checks',
  check(s) {
    const name = 'required-checks';
    if (s.requiredChecks.length === 0) {
      return fail(name, 'no required checks are configured; an empty set proves nothing (AGT-4414)');
    }
    const problems: string[] = [];
    for (const required of s.requiredChecks) {
      const runs = s.checks.filter((c) => c.name === required);
      const onHead = runs.filter((c) => c.headSha === s.headSha);
      if (onHead.length === 0) {
        problems.push(runs.length > 0 ? `${required}: only ran on another commit` : `${required}: missing`);
        continue;
      }
      // Any non-success run on the head (a re-run that failed, a pending one) blocks.
      const bad = onHead.find((c) => c.conclusion !== 'success');
      if (bad) problems.push(`${required}: ${bad.conclusion}`);
    }
    return problems.length > 0
      ? fail(name, `required checks not green on ${short(s.headSha)}: ${problems.join('; ')}`)
      : pass(name, `${s.requiredChecks.length} required check(s) green on ${short(s.headSha)}`);
  },
};

/**
 * The human approval a medium/high change needs (AGT-4881): at least one reviewer
 * whose latest decisive review is APPROVED on the head SHA, who is a `User`, is not
 * the PR author and is not one of the factory's own accounts. COMMENTED reviews do
 * not change a reviewer's standing (GitHub semantics); a later CHANGES_REQUESTED or
 * DISMISSED withdraws an earlier approval.
 */
export function humanApprovalOnHead(s: StewardSnapshot): { approvedBy: string[]; reason: string } {
  if (s.automationAccounts.length === 0) {
    return { approvedBy: [], reason: 'automation account list is not configured, so no approval can be trusted' };
  }
  const automation = new Set(s.automationAccounts.map((login) => login.toLowerCase()));
  const author = s.author.toLowerCase();
  const latest = new Map<string, StewardPrReview>();
  const ordered = [...s.prReviews].sort((a, b) => Date.parse(a.submittedAt) - Date.parse(b.submittedAt));
  for (const review of ordered) {
    if (review.state === 'COMMENTED' || review.state === 'PENDING') continue;
    latest.set(review.login.toLowerCase(), review);
  }
  const approvedBy: string[] = [];
  const ignored: string[] = [];
  for (const [login, review] of latest) {
    if (review.state !== 'APPROVED') continue;
    if (review.commitId !== s.headSha) ignored.push(`${review.login} approved ${short(review.commitId)}, not the head`);
    else if (review.userType !== 'User') ignored.push(`${review.login} is ${review.userType ?? 'of unknown type'}`);
    else if (login === author) ignored.push(`${review.login} is the PR author`);
    else if (automation.has(login)) ignored.push(`${review.login} is a factory account`);
    else approvedBy.push(review.login);
  }
  if (approvedBy.length > 0) return { approvedBy, reason: `approved on the head by ${approvedBy.join(', ')}` };
  return {
    approvedBy,
    reason: ignored.length > 0 ? `no valid human approval (${ignored.join('; ')})` : 'no human approval',
  };
}

const riskGuard: StewardGuard = {
  name: 'risk',
  check(s) {
    const name = 'risk';
    if (!s.risk || s.risk.level === null) return fail(name, 'risk class unknown');
    if (s.risk.headSha !== s.headSha) {
      return fail(name, `risk was classified on ${short(s.risk.headSha)}, not the head ${short(s.headSha)}`);
    }
    if (s.risk.level === 'low') return pass(name, 'risk is low');
    // medium and high: the steward merges only after a person approved this exact head.
    const approval = humanApprovalOnHead(s);
    if (approval.approvedBy.length === 0) {
      return fail(name, `risk is ${s.risk.level} and needs one human approval on the head: ${approval.reason}`);
    }
    return pass(name, `risk is ${s.risk.level}; ${approval.reason}`);
  },
};

function readableFiles(list: StewardFileList): string[] | null {
  if (!list.complete || list.files === null) return null;
  return list.files.filter((file) => !isBookkeepingPath(file));
}

const siblingOverlapGuard: StewardGuard = {
  name: 'sibling-overlap',
  check(s) {
    const name = 'sibling-overlap';
    const own = readableFiles(s);
    if (own === null) return fail(name, 'this PR\'s changed-file list is unknown or truncated');
    const ownSet = new Set(own);
    const problems: string[] = [];
    for (const sibling of s.siblings) {
      if (sibling.number === s.prNumber) continue;
      const theirs = readableFiles(sibling);
      if (theirs === null) {
        problems.push(`#${sibling.number} (${sibling.headRefName}): file list unknown or truncated`);
        continue;
      }
      const shared = theirs.filter((file) => ownSet.has(file));
      if (shared.length > 0) {
        const shown = shared.slice(0, 5).join(', ');
        problems.push(`#${sibling.number} (${sibling.headRefName}) also touches ${shown}${shared.length > 5 ? ', …' : ''}`);
      }
    }
    return problems.length > 0
      ? fail(name, `open sibling PRs overlap: ${problems.join('; ')}`)
      : pass(name, `no open sibling PR touches the same files (${s.siblings.length} checked)`);
  },
};

const PARTIAL_MARKER = /\[partial\]/i;

const reviewCompletenessGuard: StewardGuard = {
  name: 'review-completeness',
  check(s) {
    const name = 'review-completeness';
    if (!s.review) return fail(name, 'no reviewer verdict recorded');
    if (s.review.headSha !== s.headSha) {
      return fail(name, `review was for ${short(s.review.headSha)}, not the head ${short(s.headSha)}`);
    }
    if (s.review.verdict !== 'approve') return fail(name, `reviewer verdict is ${s.review.verdict}`);
    if (PARTIAL_MARKER.test(s.title)) return fail(name, 'PR title is marked [partial]');
    if (!s.completeness) return fail(name, 'no completeness verdict recorded');
    if (s.completeness.headSha !== s.headSha) {
      return fail(name, `completeness was judged on ${short(s.completeness.headSha)}, not the head ${short(s.headSha)}`);
    }
    if (s.completeness.verdict !== 'complete') return fail(name, `completeness verdict is ${s.completeness.verdict}`);
    return pass(name, 'reviewer approved and the run is complete');
  },
};

/** Every guard, in report order. The steward always runs all of them. */
export const STEWARD_GUARDS: readonly StewardGuard[] = Object.freeze([
  requiredChecksGuard,
  riskGuard,
  siblingOverlapGuard,
  reviewCompletenessGuard,
]);

/**
 * Apply a guard list to a snapshot. Exported for tests that prove each guard is
 * load-bearing by removing it; production goes through `evaluateMergeSteward`,
 * which always uses `STEWARD_GUARDS`.
 */
export function applyStewardGuards(snapshot: StewardSnapshot, guards: readonly StewardGuard[]): StewardDecision {
  const results = guards.map((guard) => {
    try {
      return guard.check(snapshot);
    } catch (err) {
      return fail(guard.name, `guard threw: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  const failing = results.filter((r) => !r.pass);
  return {
    prNumber: snapshot.prNumber,
    headSha: snapshot.headSha,
    mergeable: guards.length > 0 && failing.length === 0,
    dryRun: true,
    results,
    blockedBy: failing.map((r) => `${r.guard}: ${r.reason}`),
  };
}

export interface EvaluateMergeStewardOptions {
  /** Defaults to true. There is no merge path yet, so false is refused. */
  dryRun?: boolean;
}

/** Decide whether the steward would merge this PR. Never merges. */
export function evaluateMergeSteward(
  snapshot: StewardSnapshot,
  options: EvaluateMergeStewardOptions = {},
): StewardDecision {
  if (options.dryRun === false) {
    throw new Error('merge steward: only --dry-run is implemented; there is no merge path (AGT-4879)');
  }
  return applyStewardGuards(snapshot, STEWARD_GUARDS);
}

/**
 * A decision is only valid for the head it was computed on. A push after the
 * snapshot makes every piece of evidence stale.
 */
export function isDecisionCurrent(decision: StewardDecision, currentHeadSha: string): boolean {
  return decision.headSha === currentHeadSha;
}

/** One log line per decision: the verdict and why. */
export function formatStewardDecision(decision: StewardDecision): string {
  const head = `[steward dry-run] PR #${decision.prNumber} @ ${short(decision.headSha)}: `;
  return decision.mergeable
    ? `${head}would merge — ${decision.results.map((r) => r.reason).join('; ')}`
    : `${head}would NOT merge — ${decision.blockedBy.join(' | ')}`;
}

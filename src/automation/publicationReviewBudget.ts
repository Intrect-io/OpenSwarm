// ============================================
// OpenSwarm — the PR-time fresh review runs on the reviewer role's budget (AGT-4410)
// ============================================
//
// `freshReview` used to hand `runReviewCommand` only the adapter, so the
// reviewer ran on the adapter's default model with the CLI's diff-scaled
// defaults: 20 turns and a 300s wall clock. Measured on macstudio (usage
// ledger 2026-09-17): 41 PR-time review sessions, 20 of them cut at 265–298s;
// 17 of the last 25 cgf-portal PRs carried "Fresh review did not run —
// openrouter timeout after 300000ms". Every one of those left the PR without
// the verdict that drives the rollback → retry-with-feedback loop, so the loop
// looked absent when it was merely never reached.
//
// With the in-pipeline reviewer stage disabled (the usual configuration —
// one semantic review per publication, not one per worker attempt), the
// `roles.reviewer` model/timeoutMs/maxTurns had no consumer at all. Now they
// budget this review.
import type { ProcessContext } from '../adapters/types.js';
import type { RoleConfig } from '../core/types.js';

/** Ledger stage for the reviewer's calls; `openswarm pr review --fresh` was untagged before. */
export const PUBLICATION_REVIEW_STAGE = 'pr-review';

export interface PublicationReviewBudget {
  /** The scratch checkout is the reviewed repository, whose config discovery would pick that repository's (or no) adapter. */
  adapter?: RoleConfig['adapter'];
  model?: string;
  /** `undefined` keeps `runReviewCommand`'s diff-scaled default. */
  timeoutMs?: number;
  /** `0` is the agentic loop's "no ceiling" (AGT-4388); `undefined` keeps the scaled default. */
  maxTurns?: number;
  processContext: ProcessContext;
}

export function publicationReviewBudget(
  reviewer: Partial<Pick<RoleConfig, 'adapter' | 'model' | 'timeoutMs' | 'maxTurns'>> | undefined,
  prKey: string,
): PublicationReviewBudget {
  return {
    adapter: reviewer?.adapter,
    model: reviewer?.model,
    // RoleConfig's 0 means "unlimited"; the CLI has no such value, and an
    // unbounded review holding a scheduler slot is not what 0 asked for. Leave
    // the scaled default in place and let a positive value override it.
    timeoutMs: reviewer?.timeoutMs && reviewer.timeoutMs > 0 ? reviewer.timeoutMs : undefined,
    maxTurns: reviewer?.maxTurns,
    processContext: { taskId: prKey, stage: PUBLICATION_REVIEW_STAGE },
  };
}

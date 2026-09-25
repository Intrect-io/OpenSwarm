import { describe, expect, it } from 'vitest';
import {
  draftPullRequestCause,
  isReviewRollbackDetail,
  PR_REVIEW_ROLLBACK_CODE,
  PR_REVIEW_ROLLBACK_PREFIX,
} from './draftPullRequestCause.js';

describe('draftPullRequestCause (AGT-4272)', () => {
  it('trusts the rollback code before any sibling count', () => {
    expect(draftPullRequestCause(PR_REVIEW_ROLLBACK_CODE, 0)).toBe('review_rollback');
    expect(draftPullRequestCause(PR_REVIEW_ROLLBACK_CODE, 2)).toBe('review_rollback');
  });

  it('reads a sibling PR as the deliberate INT-2544 draft', () => {
    expect(draftPullRequestCause('lease_expired', 1)).toBe('duplicate_implementation');
    expect(draftPullRequestCause('publication_reconcile', 3)).toBe('duplicate_implementation');
  });

  it('leaves everything else to a human', () => {
    expect(draftPullRequestCause('lease_expired', 0)).toBe('parked_publication');
    expect(draftPullRequestCause('publication_reconcile', 0)).toBe('parked_publication');
    expect(draftPullRequestCause(undefined, 0)).toBe('parked_publication');
  });

  it('recognises the rollback marker only at the start of the detail', () => {
    expect(isReviewRollbackDetail(`${PR_REVIEW_ROLLBACK_PREFIX}: needs tests`)).toBe(true);
    expect(isReviewRollbackDetail(`worker: ${PR_REVIEW_ROLLBACK_PREFIX}`)).toBe(false);
    expect(isReviewRollbackDetail(undefined)).toBe(false);
  });
});

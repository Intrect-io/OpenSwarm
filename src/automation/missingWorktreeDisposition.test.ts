import { describe, expect, it } from 'vitest';
import { missingWorktreeDisposition } from './missingWorktreeDisposition.js';

const base = { hasPullRequest: true, pullRequestIsDraft: false, siblingPullRequestCount: 0 };

describe('missingWorktreeDisposition (AGT-4664)', () => {
  it('drops the pointer of a row with no PR, and asks a person about a READY one', () => {
    expect(missingWorktreeDisposition({ ...base, hasPullRequest: false, state: 'RETRY_AT' })).toBe('clear');
    expect(missingWorktreeDisposition({ ...base, hasPullRequest: false, state: 'NEEDS_HUMAN' })).toBe('clear');
    expect(missingWorktreeDisposition({ ...base, hasPullRequest: false, state: 'READY' })).toBe('needs_human');
  });

  // The runner publishes a draft for an unfinished run and then removes its
  // tree. That is not an unrecorded publication; the retry is still owed.
  it('keeps a RETRY_AT row retrying when the PR is the draft of its unfinished attempt', () => {
    expect(missingWorktreeDisposition({ ...base, state: 'RETRY_AT', pullRequestIsDraft: true })).toBe('clear');
  });

  it('still sends an unrecorded ready PR to the artifact reconciler', () => {
    expect(missingWorktreeDisposition({ ...base, state: 'RETRY_AT' })).toBe('published');
    expect(missingWorktreeDisposition({ ...base, state: 'READY' })).toBe('published');
    expect(missingWorktreeDisposition({ ...base, state: 'NEEDS_HUMAN' })).toBe('published');
  });

  it('only exempts a draft on a RETRY_AT row', () => {
    expect(missingWorktreeDisposition({ ...base, state: 'READY', pullRequestIsDraft: true })).toBe('published');
    expect(missingWorktreeDisposition({ ...base, state: 'NEEDS_HUMAN', pullRequestIsDraft: true })).toBe('published');
  });

  it('keeps the old path when a sibling PR already closes the issue', () => {
    // That draft is deliberate and no retry can make it ready.
    expect(missingWorktreeDisposition({ ...base, state: 'RETRY_AT', pullRequestIsDraft: true, siblingPullRequestCount: 1 })).toBe('published');
  });
});

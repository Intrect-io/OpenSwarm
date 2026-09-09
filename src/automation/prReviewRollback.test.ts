// ============================================
// OpenSwarm — a rejected PR-time review must undo the publication (AGT-4270)
// ============================================
//
// The loop publishes before it knows whether the work is good, so the PR-time
// review is the last gate before a human sees it. Until this, the hook that ran
// it logged the verdict and returned: a PR the reviewer had just asked changes
// on still finished the run as 'approved', closing the issue and deleting the
// worktree. Measured 2026-09-09: 2 of 28 published PRs were mergeable as they
// stood (AGT-4263).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const convertPRToDraft = vi.hoisted(() => vi.fn());
const broadcastEvent = vi.hoisted(() => vi.fn());

vi.mock('../github/index.js', () => ({ convertPRToDraft }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent }));

const TASK = { id: 'AGT-1', issueId: 'AGT-1', issueIdentifier: 'AGT-1' };
const PR_URL = 'https://github.com/Intrect-io/OpenSwarm/pull/123';

describe('rollBackReviewedPublication (AGT-4270)', () => {
  beforeEach(() => {
    convertPRToDraft.mockReset().mockResolvedValue(undefined);
    broadcastEvent.mockReset();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  async function rollBack(result: Record<string, unknown>, error?: string) {
    const { rollBackReviewedPublication } = await import('./prReviewRollback.js');
    await rollBackReviewedPublication({
      prUrl: PR_URL,
      task: TASK,
      result: result as Parameters<typeof rollBackReviewedPublication>[0]['result'],
      error,
    });
    return result;
  }

  it('drops the run out of approved so the worktree is preserved and the task returns', async () => {
    // executeTask reads exactly this to decide: `keepWorktree = !(result.success
    // && result.finalStatus === 'approved')`. Leaving either in place deletes
    // the partial work, so the next attempt starts from nothing instead of
    // fixing what the reviewer objected to.
    const result = await rollBack(
      { success: true, finalStatus: 'approved' },
      'error handling on the retry path is missing',
    );

    expect(result.success).toBe(false);
    expect(result.finalStatus).toBe('failed');
    expect(result.failureDetail).toContain('pr-review: changes requested');
    expect(result.failureDetail).toContain('error handling on the retry path is missing');
  });

  it('moves the pull request back to draft', async () => {
    await rollBack({ success: true, finalStatus: 'approved' });

    expect(convertPRToDraft).toHaveBeenCalledWith('Intrect-io/OpenSwarm', 123);
  });

  it('still fails the run when the PR cannot be moved to draft, and says so', async () => {
    // A PR left marked ready after a rejected review is precisely the state
    // this exists to prevent someone merging — so the failure has to be loud,
    // and it must not talk the run back into looking delivered.
    convertPRToDraft.mockRejectedValue(new Error('gh: 403 Forbidden'));

    const result = await rollBack({ success: true, finalStatus: 'approved' });

    expect(result.success).toBe(false);
    const lines = broadcastEvent.mock.calls.map(([event]) => event?.data?.line).join('\n');
    expect(lines).toContain('could NOT move the PR to draft');
    expect(lines).toContain('gh: 403 Forbidden');
  });

  it('records a reason even when the review returned no error text', async () => {
    // The ledger reads failureDetail. An empty one is how AGT-4237's 88%
    // reasonless infra_error rows happened.
    const result = await rollBack({ success: true, finalStatus: 'approved' }, '   ');

    expect(result.failureDetail).toBe('pr-review: changes requested: the reviewer asked for changes');
  });

  it('leaves a PR URL it cannot parse alone rather than guessing a repo', async () => {
    const { rollBackReviewedPublication } = await import('./prReviewRollback.js');
    const result: Record<string, unknown> = { success: true, finalStatus: 'approved' };

    await rollBackReviewedPublication({
      prUrl: 'https://example.com/not/a/pull/request',
      task: TASK,
      result: result as Parameters<typeof rollBackReviewedPublication>[0]['result'],
    });

    expect(convertPRToDraft).not.toHaveBeenCalled();
    // The verdict still stands even though the draft flip could not be tried.
    expect(result.success).toBe(false);
  });
});

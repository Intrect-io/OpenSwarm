// ============================================
// OpenSwarm — every publication gets a verdict, or says why it did not (AGT-4278)
// ============================================
//
// Measured on vela 2026-09-10: of nine published pull requests, two carried a
// reviewer verdict. The gate was not weak, it was narrow. Draft publications —
// the output of runs that STOPPED, i.e. the least finished work the daemon
// emits — never reached it at all, and the ones that did failed open silently
// when the reviewer timed out.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const reviewPublishedPullRequest = vi.hoisted(() => vi.fn());
vi.mock('./prPublicationReview.js', () => ({ reviewPublishedPullRequest }));
const commentOnPR = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('../github/github.js', () => ({ commentOnPR }));
const rollBackReviewedPublication = vi.hoisted(() => vi.fn(async () => {}));
vi.mock('./prReviewRollback.js', () => ({ rollBackReviewedPublication }));
vi.mock('../core/eventHub.js', () => ({ broadcastEvent: vi.fn() }));

import { buildPublicationReviewHook, resetReviewedPublicationsForTests } from './publicationReviewHook.js';

const PR = 'https://github.com/Intrect-io/OpenSwarm/pull/580';
const ctx = { prUrl: PR, headSha: 'abc1234', worktreeInfo: { originalPath: '/work/OpenSwarm' } };

function hook(rollbackOnRejection: boolean) {
  return buildPublicationReviewHook({
    task: { id: 't1', issueId: 'AGT-1', issueIdentifier: 'AGT-1', title: 'x' },
    result: { success: true, finalStatus: 'approved' },
    rollbackOnRejection,
  } as Parameters<typeof buildPublicationReviewHook>[0]);
}

describe('publication review hook (AGT-4278)', () => {
  beforeEach(() => {
    reviewPublishedPullRequest.mockReset();
    commentOnPR.mockClear();
    rollBackReviewedPublication.mockClear();
    resetReviewedPublicationsForTests();
  });
  afterEach(() => vi.restoreAllMocks());

  it('says on the PR when the reviewer produced no verdict, naming the reason', async () => {
    // #579 and #580 both died on `openrouter timeout after 300000ms` and were
    // published anyway. An unreviewed PR looked exactly like a reviewed one.
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: false, error: 'openrouter timeout after 300000ms',
    });

    await hook(true)(ctx);

    expect(commentOnPR).toHaveBeenCalledTimes(1);
    const [repo, number, body] = commentOnPR.mock.calls[0];
    expect(repo).toBe('Intrect-io/OpenSwarm');
    expect(number).toBe(580);
    expect(body).toContain('without a reviewer verdict');
    expect(body).toContain('openrouter timeout after 300000ms');
    // A review that never ran said nothing about the code, so nothing rolls back.
    expect(rollBackReviewedPublication).not.toHaveBeenCalled();
  });

  it('does not roll back a draft, but still gets it reviewed', async () => {
    // The verdict cannot undo a draft — it is already a draft, and the run
    // already parked. It is the starting point for whoever picks it up.
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'drops four passing tests',
    });

    await hook(false)(ctx);

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
    expect(rollBackReviewedPublication).not.toHaveBeenCalled();
    expect(commentOnPR).not.toHaveBeenCalled();
  });

  it('rolls back a ready publication the reviewer rejected', async () => {
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'drops four passing tests',
    });

    await hook(true)(ctx);

    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(1);
    expect(rollBackReviewedPublication.mock.calls[0][0]).toMatchObject({
      prUrl: PR, error: 'drops four passing tests',
    });
  });

  it('stays quiet when the reviewer approved', async () => {
    reviewPublishedPullRequest.mockResolvedValue({ success: true, gateRan: true, changesRequested: false });

    await hook(true)(ctx);

    expect(commentOnPR).not.toHaveBeenCalled();
    expect(rollBackReviewedPublication).not.toHaveBeenCalled();
  });

  it('does not fail the run when it cannot post the did-not-run notice', async () => {
    // The reviewer already failed; failing to say so must not also fail the
    // run. Guarded at this call site rather than relying on `commentOnPR`'s
    // own swallow, so swapping it for `commentOnPROrThrow` cannot turn a
    // courtesy note into a run failure.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reviewPublishedPullRequest.mockResolvedValue({ success: false, gateRan: false, error: 'boom' });
    commentOnPR.mockRejectedValueOnce(new Error('403 from GitHub'));

    await expect(hook(true)(ctx)).resolves.toBeUndefined();
  });

  it('reviews a given PR+sha once, however many times the run re-parks on it', async () => {
    // A parked run resumes on the same branch and reuses the open PR, so a task
    // that parks five times paid five full reviews of an unchanged diff and
    // appended five identical notices.
    reviewPublishedPullRequest.mockResolvedValue({ success: false, gateRan: false, error: 'timeout' });

    const h = hook(false);
    await h(ctx);
    await h(ctx);
    await hook(false)(ctx);

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
    expect(commentOnPR).toHaveBeenCalledTimes(1);
  });

  it('re-reviews an approved republication at the same sha, so the rollback still fires', async () => {
    // A rolled-back run resumes the preserved worktree, commits nothing new —
    // the implementation is already there and looks finished — and
    // republishes the SAME PR at the SAME sha. Skipping the review there
    // finishes it `approved` with the reviewer's objection unaddressed, which
    // is AGT-4270's failure arriving through a cache.
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'still wrong',
    });

    await hook(true)(ctx);
    await hook(true)(ctx);

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(2);
    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(2);
  });

  it('does not let a draft review suppress the approved review of the same sha', async () => {
    // Same key, two different contracts: one may roll back, the other may not.
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'still wrong',
    });

    await hook(false)(ctx);
    await hook(true)(ctx);

    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(1);
  });

  it('does not mark a sha reviewed when the review never produced anything', async () => {
    reviewPublishedPullRequest.mockRejectedValueOnce(new Error('import failed'));

    await expect(hook(false)(ctx)).rejects.toThrow('import failed');

    reviewPublishedPullRequest.mockResolvedValue({ success: true, gateRan: true, changesRequested: false });
    await hook(false)(ctx);

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent reviews of the same draft into one', async () => {
    // The key goes in before the review, not after, so two callers arriving in
    // the same tick do not both pay for it.
    let release: (v: unknown) => void = () => {};
    reviewPublishedPullRequest.mockImplementation(() => new Promise(r => { release = r; }));

    const h = hook(false);
    const both = Promise.all([h(ctx), h(ctx)]);
    // Both callers must actually REACH the mock before it resolves, or the
    // test would pass on ordering rather than on the dedup.
    await vi.waitFor(() => expect(reviewPublishedPullRequest).toHaveBeenCalled());
    release({ success: true, gateRan: true, changesRequested: false });
    await both;

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
  });

  it('lets the next park say what this one could not', async () => {
    // The notice failing to post is the mirror of the review throwing: a sha
    // marked done over a PR nobody told anything.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reviewPublishedPullRequest.mockResolvedValue({ success: false, gateRan: false, error: 'timeout' });
    commentOnPR.mockRejectedValueOnce(new Error('403'));

    await hook(false)(ctx);
    await hook(false)(ctx);

    expect(commentOnPR).toHaveBeenCalledTimes(2);
  });

  it('reviews again when the branch moved on', async () => {
    reviewPublishedPullRequest.mockResolvedValue({ success: false, gateRan: false, error: 'timeout' });

    await hook(false)(ctx);
    await hook(false)({ ...ctx, headSha: 'def5678' });

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(2);
  });

  it('reviews an unparseable PR URL nowhere rather than crashing', async () => {
    reviewPublishedPullRequest.mockResolvedValue({ success: false, gateRan: false, error: 'boom' });

    await hook(true)({ ...ctx, prUrl: 'not-a-pr-url' });

    expect(commentOnPR).not.toHaveBeenCalled();
  });
});

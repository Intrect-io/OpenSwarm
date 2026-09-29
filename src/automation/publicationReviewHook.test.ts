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

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPublicationReviewHook, resetReviewedPublicationsForTests } from './publicationReviewHook.js';
import {
  ReviewVerdictStore,
  lookupStoredPublication,
  publicationReviewKey,
  type PublicationReviewOutcome,
} from './reviewVerdictStore.js';

const PR = 'https://github.com/Intrect-io/OpenSwarm/pull/580';
const ctx = { prUrl: PR, headSha: 'abc1234', worktreeInfo: { originalPath: '/work/OpenSwarm' } };

// Every test gets its own store, on its own file. The hook's default store is
// the deployment-shared automation database, and the vitest setup redirects
// that per worker — so a test that ran the review twice in two hooks would
// otherwise be reading the row an earlier test wrote and would pass or fail on
// test order rather than on the hook.
let store: ReviewVerdictStore;
let storeRoot: string;

function hook(rollbackOnRejection: boolean, verdictStore: unknown = store) {
  return buildPublicationReviewHook({
    task: { id: 't1', issueId: 'AGT-1', issueIdentifier: 'AGT-1', title: 'x' },
    result: { success: true, finalStatus: 'approved' },
    rollbackOnRejection,
    verdictStore: verdictStore as never,
  } as Parameters<typeof buildPublicationReviewHook>[0]);
}

beforeEach(() => {
  reviewPublishedPullRequest.mockReset();
  commentOnPR.mockClear();
  rollBackReviewedPublication.mockClear();
  resetReviewedPublicationsForTests();
  storeRoot = mkdtempSync(join(tmpdir(), 'openswarm-hook-verdict-'));
  store = new ReviewVerdictStore(join(storeRoot, 'automation.db'));
});

afterEach(() => {
  store.close();
  rmSync(storeRoot, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('publication review hook (AGT-4278)', () => {
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

  it('replays a republication at the same sha so the rollback still fires', async () => {
    // A rolled-back run resumes the preserved worktree, commits nothing new —
    // the implementation is already there and looks finished — and
    // republishes the SAME PR at the SAME sha. Skipping the review there
    // finishes it `approved` with the reviewer's objection unaddressed, which
    // is AGT-4270's failure arriving through a cache.
    //
    // The durable store replays the OUTCOME rather than skipping past it, so
    // this holds under it too: the second publication re-applies the same
    // rejection, minus the reviewer call that already answered this exact
    // commit. That is the distinction that makes a durable cache safe where a
    // "seen this before" flag is not.
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'still wrong',
    });

    await hook(true)(ctx);
    await hook(true)(ctx);

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
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

// The durable half: what a restarted process does with a review this deployment
// already paid for. The in-process Set above is empty after every daemon
// restart, and the failure census records 141 `owner_process_exited` + 157
// `shutdown_cancelled` — a re-park after a redeploy used to buy the same
// verdict again, at ~$0.26 and p50 93s per call.
describe('publication review hook durable reuse (Tier 1)', () => {
  it('replays a stored rejection including the rollback, without calling the reviewer', async () => {
    // The rollback is the whole point of a verdict being acted on (AGT-4270).
    // Reusing a rejection and skipping the rollback would leave an objected-to
    // publication standing and finish the run approved — a cache that turns a
    // reject into an approve is worse than no cache at all.
    await store.record(
      publicationReviewKey({ prUrl: PR, headSha: 'abc1234' }),
      { success: false, gateRan: true, changesRequested: true, error: 'drops four passing tests' },
    );

    await hook(true)(ctx);

    expect(reviewPublishedPullRequest).not.toHaveBeenCalled();
    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(1);
    expect(rollBackReviewedPublication.mock.calls[0][0]).toMatchObject({
      prUrl: PR, error: 'drops four passing tests',
    });
  });

  it('replays a review that did not run and still says so on the PR', async () => {
    // `gateRan: false` is the state PR #580 shipped in: published without a
    // verdict. An unreviewed PR must not become indistinguishable from a
    // reviewed one just because the "nothing ran" outcome was remembered.
    await store.record(
      publicationReviewKey({ prUrl: PR, headSha: 'abc1234' }),
      { success: false, gateRan: false, error: 'openrouter timeout after 300000ms' },
    );

    await hook(true)(ctx);

    expect(reviewPublishedPullRequest).not.toHaveBeenCalled();
    expect(commentOnPR).toHaveBeenCalledTimes(1);
    expect(commentOnPR.mock.calls[0][2]).toContain('openrouter timeout after 300000ms');
    expect(rollBackReviewedPublication).not.toHaveBeenCalled();
  });

  it('replays a stored approval quietly', async () => {
    await store.record(
      publicationReviewKey({ prUrl: PR, headSha: 'abc1234' }),
      { success: true, gateRan: true, changesRequested: false },
    );

    await hook(true)(ctx);

    expect(reviewPublishedPullRequest).not.toHaveBeenCalled();
    expect(commentOnPR).not.toHaveBeenCalled();
    expect(rollBackReviewedPublication).not.toHaveBeenCalled();
  });

  it('names the reuse on the dashboard rather than reporting it as a fresh review', async () => {
    // An operator reading "the review ran" for a review that never ran cannot
    // tell this cache from a broken gate.
    const { broadcastEvent } = await import('../core/eventHub.js');
    await store.record(
      publicationReviewKey({ prUrl: PR, headSha: 'abc1234' }),
      { success: true, gateRan: true, changesRequested: false },
    );

    await hook(true)(ctx);

    expect(broadcastEvent).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        stage: 'pr-review',
        line: expect.stringContaining('durable reuse'),
      }),
    }));
  });

  it('records what the reviewer returned, so a later process can reuse it', async () => {
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'still wrong',
    });

    await hook(false)(ctx);

    expect(lookupStoredPublication(store, publicationReviewKey({ prUrl: PR, headSha: 'abc1234' })))
      .toEqual({ success: false, gateRan: true, changesRequested: true, error: 'still wrong' });
  });

  it('does not reuse a verdict recorded for a different head sha of the same PR', async () => {
    // A new push is a different diff. This is the case the in-process Set
    // already handles and the durable one must not lose.
    await store.record(
      publicationReviewKey({ prUrl: PR, headSha: 'aaa1111' }),
      { success: true, gateRan: true, changesRequested: false },
    );
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'this commit is wrong',
    });

    await hook(true)({ ...ctx, headSha: 'bbb2222' });

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(1);
  });

  it('runs the review when the store throws on lookup, leaving behaviour unchanged', async () => {
    // A cache that cannot be read must never suppress a review, and must never
    // fail the run. This is the fail-open direction the whole store is built
    // around, asserted where it actually matters — at the call site that would
    // otherwise skip the gate.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reviewPublishedPullRequest.mockResolvedValue({
      success: false, gateRan: true, changesRequested: true, error: 'reviewed anyway',
    });
    const broken = {
      lookupPublication: () => { throw new Error('database is locked'); },
      lookupReview: () => { throw new Error('database is locked'); },
      record: () => { throw new Error('readonly database'); },
    };

    await hook(true, broken)(ctx);

    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(1);
    expect(rollBackReviewedPublication.mock.calls[0][0]).toMatchObject({ error: 'reviewed anyway' });
  });

  it('does not fail the run when the store cannot be written', async () => {
    // The mirror of a failed read: an unwritable database costs a recomputation
    // later, never a broken publication now.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    reviewPublishedPullRequest.mockResolvedValue({ success: true, gateRan: true, changesRequested: false });
    const broken = {
      lookupPublication: () => undefined,
      lookupReview: () => undefined,
      record: () => { throw new Error('readonly database'); },
    };

    await expect(hook(true, broken)(ctx)).resolves.toBeUndefined();
    expect(reviewPublishedPullRequest).toHaveBeenCalledTimes(1);
  });

  it('still rolls back a stored rejection that reaches the approved path', async () => {
    // The in-process Set is draft-only (AGT-4270), and the durable store does
    // not inherit that restriction because it replays the outcome rather than
    // skipping. Without a stored row here the review runs fresh, so this
    // asserts the replay path is the one that acted.
    await store.record(
      publicationReviewKey({ prUrl: PR, headSha: 'abc1234' }),
      { success: false, gateRan: true, changesRequested: true, error: 'objected' },
    );
    const rejection: PublicationReviewOutcome = { success: false, gateRan: true, changesRequested: true, error: 'objected' };

    await hook(true)(ctx);
    await hook(false)(ctx);

    expect(reviewPublishedPullRequest).not.toHaveBeenCalled();
    // Once for the approved path; the draft path has nothing to roll back.
    expect(rollBackReviewedPublication).toHaveBeenCalledTimes(1);
    expect(lookupStoredPublication(store, publicationReviewKey({ prUrl: PR, headSha: 'abc1234' }))).toEqual(rejection);
  });
});


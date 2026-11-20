// Created: 2026-11-21
// Purpose: The one way daemon code outside src/linear moves a tracker issue: post the reason, then change state (AGT-4800).
// Dependencies: none (structural task-source type)
// Test Status: covered by src/linear/daemonSignature.test.ts

/**
 * Every tracker state change the daemon makes must arrive with a comment that says why, and that
 * comment must read as the daemon's (`[OpenSwarm]` lead), because the daemon writes with the
 * operator's credential. `transitionWithReason` posts the reason FIRST through `source.addComment`
 * (Linear's addComment adds the lead, see linear/format signDaemonComment) and then calls
 * `source.updateState`, so a reader of the issue history never sees an unexplained move.
 *
 * When the reason comment fails (`commentFailure`):
 * - `'transition'` (default): log it and still change state. Many of these moves are safety actions
 *   (park to Backlog, stop a stale In Progress, hand a retry back to Todo); losing the explanation
 *   is better than leaving the issue where the daemon decided it must not stay.
 * - `'abort'`: change nothing and throw `ReasonCommentError`. For moves that are only proposals
 *   and must not happen unexplained (backlog grooming closing an issue).
 * - `'rethrow'`: change state, then rethrow the comment error, so a durable outbox effect retries
 *   the comment (with its idempotency key) while the state change itself is not held back.
 *
 * `reasonAlreadyPosted` is for outbox retries whose reason was posted earlier under an effect
 * marker and confirmed on the issue: the helper then changes state only, and does not repeat it.
 *
 * Errors from `updateState` itself propagate unchanged; the return value is what it returned.
 */
export interface TransitionSource<S extends string> {
  addComment(issueId: string, body: string, idempotencyKey?: string): Promise<void>;
  updateState(issueId: string, state: S): Promise<boolean>;
}

export interface TransitionOptions {
  /** Passed to addComment so a retried transition does not post its reason twice. */
  idempotencyKey?: string;
  commentFailure?: 'transition' | 'abort' | 'rethrow';
  reasonAlreadyPosted?: boolean;
}

/** The reason comment failed and `commentFailure: 'abort'` left the state unchanged. */
export class ReasonCommentError extends Error {
  constructor(issueId: string, readonly cause: unknown) {
    super(`Reason comment for ${issueId} failed; state left unchanged`);
  }
}

export async function transitionWithReason<S extends string>(
  source: TransitionSource<S>,
  issueId: string,
  state: S,
  reason: string,
  options: TransitionOptions = {},
): Promise<boolean> {
  let commentError: unknown;
  if (!options.reasonAlreadyPosted) {
    try {
      // Keep the call shape of the callers this replaced: the key is passed only when one was given.
      await ('idempotencyKey' in options
        ? source.addComment(issueId, reason, options.idempotencyKey)
        : source.addComment(issueId, reason));
    } catch (error) {
      if (options.commentFailure === 'abort') throw new ReasonCommentError(issueId, error);
      console.warn(`[TrackerTransition] Reason comment for ${issueId} → ${state} failed; changing state anyway:`, error);
      commentError = error;
    }
  }
  const accepted = await source.updateState(issueId, state);
  if (commentError !== undefined && options.commentFailure === 'rethrow') throw commentError;
  return accepted;
}

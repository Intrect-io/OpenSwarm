// ============================================
// OpenSwarm - Reading the board for an operator's answer
// ============================================
//
// A run that stops on `ask_human` is parked with a two-hour backoff, and the
// backoff is also its resume path — so without this the operator's reply lands
// up to two hours after they sent it, which from their side is indistinguishable
// from being ignored (AGT-4033).
//
// The signal is the same fact `askHuman` replays on, so if it holds here the next
// run proceeds instead of parking again.

/**
 * The run-ledger error code a task carries while it is stopped on the operator.
 *
 * Deliberately not a separate flag. The ledger writes `last_error_code` on every
 * transition, so the next attempt overwrites this one — which is exactly the
 * lifecycle the park signal needs and the one a hand-maintained flag kept getting
 * wrong. A task that waits out its backoff normally and then fails for its own
 * reasons carries `failed` here, not this, so an answer from an earlier park
 * cannot pull it forward.
 */
export const OPERATOR_PARK_REASON = 'waiting_on_operator';

/** NEEDS_HUMAN reason whose resume is fenced by an exact correlation set. */
export const OPERATOR_QUESTION_PARK_REASON = 'operator_question';

const MAX_OPERATOR_CORRELATIONS = 100;
const MAX_CORRELATION_ID_LENGTH = 200;

/** One canonical normalization for the tool result, scheduler, and ledger. */
export function normalizeOperatorQuestionCorrelations(ids: readonly string[]): string[] {
  const normalized = ids
    .map((id) => id.trim().slice(0, MAX_CORRELATION_ID_LENGTH))
    .filter(Boolean);
  return [...new Set(normalized)].slice(0, MAX_OPERATOR_CORRELATIONS);
}

/**
 * Whether a backoff may be cut short because the operator replied.
 *
 * The park code is what keeps this from becoming a fast-retry loop: a task
 * backing off from ordinary failures can still carry an answered question from
 * an earlier park, and without it every heartbeat would re-admit it.
 */
export function shouldReadmitEarly(input: {
  parkedOnOperator: boolean;
  allQuestionsAnswered: boolean;
}): boolean {
  return input.parkedOnOperator && input.allQuestionsAnswered;
}

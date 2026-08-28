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
 * Recorded on a task's execution state when a run stops on `ask_human`.
 *
 * Durable on purpose. The answer itself is durable — it lives on the board — so a
 * discriminator that only existed in memory would make a restart the one thing
 * that turns a two-minute reply back into a two-hour one, for no reason the
 * operator could see.
 */
export const OPERATOR_PARK_REASON = 'waiting_on_operator';

/**
 * Whether a backoff may be cut short because the operator replied.
 *
 * The park flag is what keeps this from becoming a fast-retry loop: a task
 * backing off from ordinary failures can still carry an answered question from
 * an earlier park, and without the flag every heartbeat would re-admit it.
 */
export function shouldReadmitEarly(input: {
  parkedOnOperator: boolean;
  allQuestionsAnswered: boolean;
}): boolean {
  return input.parkedOnOperator && input.allQuestionsAnswered;
}

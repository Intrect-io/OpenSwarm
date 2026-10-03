// ============================================
// OpenSwarm — is anything actually executing this task?
// ============================================

/** Ledger states in which an executor holds the run right now. */
const LIVE_RUN_STATES: ReadonlySet<string> = new Set(['CLAIMED', 'EXECUTING', 'VERIFYING', 'PUBLISHING']);

/**
 * Whether a task that the local task-state file marks `in_progress` has a live
 * executor behind that marker.
 *
 * The marker is written when a run starts and nothing clears it when the run
 * dies without finishing: a restart, a SIGKILL, an expired lease. The decision
 * engine read it as "already executing" and dropped the task, so work the
 * ledger had already released sat out of the queue until Linear moved the card
 * (`stalledInProgressHours`, default 6 h). On 2026-10-03, 27 cgf-portal rows
 * were READY for 85 to 192 minutes while 12 of 16 slots were idle (AGT-4667).
 *
 * - The scheduler holds it (running or queued): live.
 * - A ledger row in an executing state: live.
 * - A ledger row in any other state (READY, RETRY_AT, NEEDS_HUMAN, terminal):
 *   the ledger says nobody is executing it — not live, so the marker is stale.
 * - No ledger row: unknown. Keep trusting the marker, as before.
 */
export function isExecutionLive(input: { schedulerHolds: boolean; ledgerState?: string }): boolean {
  if (input.schedulerHolds) return true;
  if (input.ledgerState === undefined) return true;
  return LIVE_RUN_STATES.has(input.ledgerState);
}

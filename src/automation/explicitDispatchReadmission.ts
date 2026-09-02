// ============================================
// OpenSwarm - What an explicit operator dispatch may reopen in the ledger
// ============================================

import { OPERATOR_QUESTION_PARK_REASON } from '../coordination/operatorAnswers.js';
import type { RunRecord } from './runLedgerTypes.js';

/** Legacy ask_human parks carried this prefix before the exact park code existed. */
export const OPERATOR_QUESTION_PARK_MARKER = '[operator-question]';

export type ExplicitReadmission =
  /** Row is already claimable, or has no durable record: enqueue as-is. */
  | { action: 'none' }
  /** A park that an operator act ends: `resumeNeedsHuman`. */
  | { action: 'resume-needs-human' }
  /** A terminal record or a live backoff the operator is overriding: `markReady`. */
  | { action: 'mark-ready' }
  /** A park only its own answers may end; dispatching it is not that act. */
  | { action: 'refuse'; reason: string };

/**
 * `POST /api/work` and `openswarm work` are the operator's redispatch act.
 * The heartbeat filter honours that act for a parked run, but the explicit
 * path enqueued straight onto the scheduler, so the coordinator then found a
 * NEEDS_HUMAN row it cannot claim and fenced the task as superseded — the
 * very park whose message says "explicitly redispatch to resume" could not be
 * resumed by redispatching it (vela, 2026-09-02: six infra quarantines).
 *
 * Pure so both paths can share one reading of the ledger row.
 */
export function decideExplicitReadmission(run: RunRecord | null | undefined, now = Date.now()): ExplicitReadmission {
  if (!run) return { action: 'none' };
  switch (run.state) {
    case 'NEEDS_HUMAN': {
      const exactQuestionPark = run.lastErrorCode === OPERATOR_QUESTION_PARK_REASON;
      const legacyQuestionPark = run.lastErrorMessage?.startsWith(OPERATOR_QUESTION_PARK_MARKER) ?? false;
      if (exactQuestionPark || legacyQuestionPark) {
        return { action: 'refuse', reason: 'parked on an operator question; answer it instead of redispatching' };
      }
      // Sandbox-outcome quarantine and every other operator park resume here.
      return { action: 'resume-needs-human' };
    }
    case 'RETRY_AT':
      // The ledger refuses to claim a backoff whose time has not come. An
      // explicit dispatch is the operator overriding that heuristic.
      return run.retryAt != null && run.retryAt > now ? { action: 'mark-ready' } : { action: 'none' };
    case 'DONE':
    case 'DECOMPOSED':
    case 'CANCELLED':
      return { action: 'mark-ready' };
    default:
      return { action: 'none' };
  }
}

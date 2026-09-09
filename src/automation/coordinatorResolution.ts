// ============================================
// OpenSwarm — deterministic coordinator resolution plans
// ============================================

import {
  WORKER_NO_CHANGES_PARK_REASON,
  WORKER_NO_CHANGES_STATEMENT_PREFIX,
  type PipelineResult,
} from '../agents/pairPipelineTypes.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import { isEphemeralWorktreeArtifact } from '../support/worktreeEphemeral.js';
import { parseDoDContract } from './dodContract.js';

/** Same value as PUBLICATION_SCOPE_PARK_REASON; kept local so this plan stays pure. */
const PUBLICATION_SCOPE_PARK_REASON = 'publication_scope_mismatch';

export type CoordinatorResolution =
  | { action: 'complete'; reason: string }
  | { action: 'retry'; reason: string; retryAt: number }
  | { action: 'park'; reason: string };

export interface CoordinatorResolutionInput {
  task: Pick<TaskItem, 'description'>;
  result: Pick<PipelineResult, 'operatorPark'>;
  /** Durable attempt number, including the current attempt. */
  attemptNo: number;
  now?: number;
}

const EPHEMERAL_RETRY_DELAY_MS = 30_000;
const DEFAULT_MAX_REPAIRS = 1;

function scopePaths(reason: string): string[] {
  const marker = 'outside reserved write scope:';
  const index = reason.toLowerCase().indexOf(marker);
  if (index < 0) return [];
  return reason.slice(index + marker.length)
    .split(',')
    .map((path) => path.trim())
    .filter(Boolean);
}

/**
 * Decide whether the coordinator can resolve a deterministic park.
 *
 * The plan is pure and bounded. It never broadens a source write scope, runs a
 * command from an issue, or treats a missing contract as business authority.
 * An ephemeral-only publication-scope park is residual defence: the live fence
 * already drops those artifacts before throwing. A silent zero-diff stuck loop
 * is never treated as a proven no-op, even with an explicit complete contract.
 */
export function planCoordinatorResolution(input: CoordinatorResolutionInput): CoordinatorResolution {
  const park = input.result.operatorPark;
  if (!park) return { action: 'park', reason: 'No operator park was supplied' };
  const parsed = parseDoDContract(input.task.description);
  if (parsed.error) {
    return { action: 'park', reason: `Malformed DoD contract: ${parsed.error}` };
  }
  const contract = parsed.contract;

  // Two parks share WORKER_NO_CHANGES_PARK_REASON. Only the publication
  // variant carries the worker's stated no-edit proof. The stuck-loop variant
  // (claimed success, zero diff, no reason) must stay parked even when the
  // contract allows no-change completion.
  const provenNoChange = park.code === WORKER_NO_CHANGES_PARK_REASON
    && park.reason.startsWith(WORKER_NO_CHANGES_STATEMENT_PREFIX);
  if (provenNoChange && contract?.completion.noChanges === 'complete') {
    return {
      action: 'complete',
      reason: 'The issue DoD explicitly declares a no-change completion as acceptable.',
    };
  }

  // assertBranchWithinWriteScope already drops ephemeral artifacts before it
  // throws, so a live fence should never emit an ephemeral-only reason. Keep
  // the residual retry for a park string that still lists only those paths
  // (older daemons, or a constructor that bypassed the fence filter).
  if (park.code === PUBLICATION_SCOPE_PARK_REASON) {
    const paths = scopePaths(park.reason);
    const allEphemeral = paths.length > 0 && paths.every(isEphemeralWorktreeArtifact);
    const policy = contract?.automation.scopeMismatch ?? 'retry_ephemeral';
    const maxRepairs = contract?.automation.maxRepairs ?? DEFAULT_MAX_REPAIRS;
    if (allEphemeral && policy === 'retry_ephemeral' && input.attemptNo <= maxRepairs) {
      return {
        action: 'retry',
        retryAt: (input.now ?? Date.now()) + EPHEMERAL_RETRY_DELAY_MS,
        reason: `Only ephemeral artifacts remain in the publication-scope park (${paths.join(', ')}); the coordinator will retry once.`,
      };
    }
  }

  return { action: 'park', reason: park.reason };
}

export function coordinatorResolutionComment(resolution: CoordinatorResolution): string {
  if (resolution.action === 'complete') {
    return `Coordinator completed this run automatically.\n\n**Evidence:** ${resolution.reason}`;
  }
  if (resolution.action === 'retry') {
    const when = new Date(resolution.retryAt).toISOString();
    return `Coordinator repaired a deterministic blocker and scheduled one bounded retry at ${when}.\n\n**Evidence:** ${resolution.reason}`;
  }
  return `Coordinator left this run parked because it requires an external decision.\n\n**Reason:** ${resolution.reason}`;
}

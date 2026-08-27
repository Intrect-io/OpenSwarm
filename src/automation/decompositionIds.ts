// ============================================
// OpenSwarm - Stable decomposition artifact IDs
// ============================================
//
// Deterministic UUIDs for decomposition children and reviewer follow-ups so a
// partially-completed run converges on the artifacts it already created
// instead of minting a second set. Extracted from runnerExecution.ts.

import { createHash } from 'node:crypto';

export function stableArtifactUuid(seed: string): string {
  const bytes = createHash('sha256')
    .update(seed)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Stable child identity makes a partial decomposition restart converge on the
 * first remote artifacts instead of creating a second set of sub-issues. */
export function decompositionChildId(parentIssueId: string, index: number): string {
  return stableArtifactUuid(`openswarm-decomposition:${parentIssueId}:child:${index}`);
}

export function reviewerFollowupId(
  parentIssueId: string,
  index: number,
  action: { type: string; title: string; location?: string },
): string {
  return stableArtifactUuid(
    `openswarm-review-followup:${parentIssueId}:${index}:${action.type}:${action.title}:${action.location ?? ''}`,
  );
}

// ============================================
// OpenSwarm — fresh review immediately after PR publication
// ============================================

import type { DefaultRolesConfig, SecurityAuditConfig } from '../core/types.js';
import type { PRInfo } from '../github/index.js';
import { PRProcessor } from './prProcessor.js';
import { parsePublishedPullRequest } from './publishedPullRequest.js';
import type { PublicationReviewOutcome } from './reviewVerdictStore.js';

export { parsePublishedPullRequest } from './publishedPullRequest.js';
export type { PublishedPullRequest } from './publishedPullRequest.js';

/**
 * Run the expensive agentic review once the diff is a remotely addressable PR.
 * Worker execution intentionally uses only deterministic guards and verification;
 * this hook is the PR-time replacement for its former per-attempt LLM reviewer.
 *
 * The return type is named rather than inline because it is also what
 * reviewVerdictStore.ts persists and replays: one shape, so a field added here
 * is one the durable store already carries instead of one silently dropped on
 * the way back out.
 */
export async function reviewPublishedPullRequest(input: {
  prUrl: string;
  projectPath: string;
  roles?: DefaultRolesConfig;
  securityAudit?: SecurityAuditConfig;
}): Promise<PublicationReviewOutcome> {
  const pr = parsePublishedPullRequest(input.prUrl);
  if (!pr) {
    return { success: false, error: `Unsupported published PR URL: ${input.prUrl}`, gateRan: false };
  }

  const processor = new PRProcessor({
    repos: [pr.repo],
    schedule: '0 0 1 1 *', // This instance is one-shot; its scheduler is never started.
    maxIterations: 1,
    roles: input.roles,
    securityAudit: input.securityAudit,
  });
  const result = await processor.freshReview(pr as PRInfo, input.projectPath);
  return {
    success: result.success,
    error: result.error,
    gateRan: result.gateRan,
    changesRequested: result.changesRequested,
  };
}

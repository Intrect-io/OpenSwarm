// ============================================
// OpenSwarm — fresh review immediately after PR publication
// ============================================

import type { DefaultRolesConfig, SecurityAuditConfig } from '../core/types.js';
import type { PRInfo } from '../github/index.js';
import { PRProcessor } from './prProcessor.js';

export type PublishedPullRequest = Pick<PRInfo, 'repo' | 'number' | 'url'>;

/** Parse only canonical GitHub pull-request URLs emitted by the publisher. */
export function parsePublishedPullRequest(prUrl: string): PublishedPullRequest | null {
  try {
    const url = new URL(prUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'github.com') return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/?$/);
    if (!match) return null;
    return {
      repo: `${match[1]}/${match[2]}`,
      number: Number(match[3]),
      url: prUrl,
    };
  } catch {
    return null;
  }
}

/**
 * Run the expensive agentic review once the diff is a remotely addressable PR.
 * Worker execution intentionally uses only deterministic guards and verification;
 * this hook is the PR-time replacement for its former per-attempt LLM reviewer.
 */
export async function reviewPublishedPullRequest(input: {
  prUrl: string;
  projectPath: string;
  roles?: DefaultRolesConfig;
  securityAudit?: SecurityAuditConfig;
}): Promise<{ success: boolean; error?: string; gateRan?: boolean }> {
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
  return { success: result.success, error: result.error, gateRan: result.gateRan };
}

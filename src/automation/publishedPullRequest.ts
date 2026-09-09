// ============================================
// OpenSwarm — the canonical PR URL the publisher emits
// ============================================

import type { PRInfo } from '../github/index.js';

export type PublishedPullRequest = Pick<PRInfo, 'repo' | 'number' | 'url'>;

/**
 * Parse only canonical GitHub pull-request URLs emitted by the publisher.
 *
 * Its own module on purpose: this is a pure string parse, and every consumer
 * that needed it from `prPublicationReview.ts` was dragging `PRProcessor` —
 * and through it the conflict resolver and the whole PR pipeline — into its
 * import graph for the sake of one regex.
 */
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

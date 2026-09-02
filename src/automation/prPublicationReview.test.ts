import { describe, expect, it, vi } from 'vitest';

const freshReview = vi.hoisted(() => vi.fn());
vi.mock('./prProcessor.js', () => ({
  PRProcessor: class { freshReview = freshReview; },
}));

import { parsePublishedPullRequest, reviewPublishedPullRequest } from './prPublicationReview.js';

describe('PR-time publication review', () => {
  it('accepts only canonical GitHub pull-request URLs', () => {
    expect(parsePublishedPullRequest('https://github.com/acme/repo/pull/42')).toEqual({
      repo: 'acme/repo', number: 42, url: 'https://github.com/acme/repo/pull/42',
    });
    expect(parsePublishedPullRequest('https://github.com/acme/repo/issues/42')).toBeNull();
    expect(parsePublishedPullRequest('https://example.test/acme/repo/pull/42')).toBeNull();
  });

  it('reviews the published PR once from the repository root', async () => {
    freshReview.mockResolvedValue({ success: true, iterations: 0, gateRan: true });
    await expect(reviewPublishedPullRequest({
      prUrl: 'https://github.com/acme/repo/pull/42', projectPath: '/work/repo',
    })).resolves.toEqual({ success: true, error: undefined, gateRan: true });
    expect(freshReview).toHaveBeenCalledWith(
      expect.objectContaining({ repo: 'acme/repo', number: 42 }),
      '/work/repo',
    );
  });
});

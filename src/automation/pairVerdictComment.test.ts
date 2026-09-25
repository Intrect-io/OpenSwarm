import { describe, expect, it, vi } from 'vitest';
import { PAIR_VERDICT_MARKER_PREFIX, pairVerdictComment, postPairVerdictOnPullRequest } from './pairVerdictComment.js';
import type { PairCompleteStats } from './taskSource.js';

const marker = 'complete:issue-1:attempt:3';
const task = { issueIdentifier: 'AX-1013', issueUrl: 'https://linear.app/intrect/issue/AX-1013' };

function stats(overrides: Partial<PairCompleteStats> = {}): PairCompleteStats {
  return {
    attempts: 3, duration: 96, filesChanged: ['src/a.ts'], prUrl: 'https://github.com/Intrect-io/cgf-portal/pull/163',
    reviewerDecision: 'approve', reviewerName: 'Lexmechanic Kaledon-Astra',
    reviewerFeedback: 'DoD 충족을 확인했습니다. test_a3_notion_job.py:257-368이 preserve를 검증합니다.',
    ...overrides,
  } as PairCompleteStats;
}

describe('pairVerdictComment (AGT-4044)', () => {
  it('names the verdict, the reviewer, the linked issue and carries the idempotency marker', () => {
    const body = pairVerdictComment(stats(), task, marker)!;
    expect(body.startsWith('## 🤝 Pair review — approve')).toBe(true);
    expect(body).toContain('**Reviewer:** Lexmechanic Kaledon-Astra');
    expect(body).toContain('[AX-1013](https://linear.app/intrect/issue/AX-1013)');
    expect(body).toContain('DoD 충족을 확인했습니다.');
    expect(body).toContain(`<!-- ${PAIR_VERDICT_MARKER_PREFIX}${marker} -->`);
  });

  it('is nothing when the completion carries no reviewer decision (recovered publication, reviewer off)', () => {
    expect(pairVerdictComment(stats({ reviewerDecision: undefined }), task, marker)).toBeNull();
  });

  it('bounds the reviewer excerpt so the issue, not the PR, holds the full exchange', () => {
    const body = pairVerdictComment(stats({ reviewerFeedback: 'x'.repeat(5_000) }), task, marker)!;
    expect(body.length).toBeLessThan(2_000);
    expect(body).toContain('…');
  });
});

describe('postPairVerdictOnPullRequest (AGT-4044)', () => {
  it('posts once, and a retry that finds its own marker on the PR posts nothing', async () => {
    const posted: string[] = [];
    const deps = {
      getPRComments: vi.fn(async () => posted.map((body) => ({ author: 'bot', body, createdAt: '' }))),
      commentOnPR: vi.fn(async (_repo: string, _n: number, body: string) => { posted.push(body); }),
    };
    expect(await postPairVerdictOnPullRequest(stats(), task, marker, deps)).toBe('posted');
    expect(deps.commentOnPR).toHaveBeenCalledWith('Intrect-io/cgf-portal', 163, expect.stringContaining(marker));
    expect(await postPairVerdictOnPullRequest(stats(), task, marker, deps)).toBe('duplicate');
    expect(deps.commentOnPR).toHaveBeenCalledTimes(1);
    // A different attempt of the same issue is a different verdict.
    expect(await postPairVerdictOnPullRequest(stats(), task, 'complete:issue-1:attempt:4', deps)).toBe('posted');
  });

  it('skips a completion with no PR or no verdict without touching GitHub', async () => {
    const deps = { getPRComments: vi.fn(), commentOnPR: vi.fn() };
    expect(await postPairVerdictOnPullRequest(stats({ prUrl: undefined }), task, marker, deps)).toBe('skipped');
    expect(await postPairVerdictOnPullRequest(stats({ reviewerDecision: undefined }), task, marker, deps)).toBe('skipped');
    expect(deps.getPRComments).not.toHaveBeenCalled();
  });

  it('reports a GitHub failure instead of throwing into completion delivery', async () => {
    const deps = {
      getPRComments: vi.fn(async () => []),
      commentOnPR: vi.fn(async () => { throw new Error('gh pr comment exited with code 1'); }),
    };
    expect(await postPairVerdictOnPullRequest(stats(), task, marker, deps)).toBe('failed');
  });
});

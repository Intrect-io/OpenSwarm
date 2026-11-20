// What a "no decision" comment may carry onto a PR, and how often. (AGT-4413 review)
import { beforeEach, describe, expect, it, vi } from 'vitest';

const gh = vi.hoisted(() => ({
  commentOnPROrThrow: vi.fn(async (_repo: string, _n: number, _body: string) => undefined),
  getPRComments: vi.fn(async (_repo: string, _n: number) => [] as Array<{ author: string; body: string; createdAt: string }>),
}));
vi.mock('../github/index.js', () => gh);

const { postNoDecisionNotes, noDecisionMarker, sanitizeNoDecisionText } = await import('./freshReviewNoDecision.js');
const { ReviewerNoVerdictError } = await import('../agents/reviewerNoVerdict.js');
const { getActiveCriticalComments } = await import('./prReviewComments.js');

const pr = { repo: 'o/r', number: 9 };
const SHA = 'headsha1234567';
const noVerdict = (notes: string) => new ReviewerNoVerdictError('reviewer-stage: produced no parseable verdict: x', notes);
const postedBody = () => gh.commentOnPROrThrow.mock.calls.at(-1)?.[2] as string;

describe('postNoDecisionNotes', () => {
  beforeEach(() => {
    gh.commentOnPROrThrow.mockReset().mockResolvedValue(undefined);
    gh.getPRComments.mockReset().mockResolvedValue([]);
  });

  it('redacts secrets the reviewer quoted, in the notes and the reason', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    await postNoDecisionNotes(pr, SHA, noVerdict(`config has GITHUB_TOKEN=${token}`), `failed near ${token}`);
    expect(postedBody()).not.toContain(token);
    expect(postedBody()).toContain('GITHUB_TOKEN=');
  });

  it('defuses the "feedback addressed" markers, so earlier critical comments stay active', async () => {
    await postNoDecisionNotes(pr, SHA, noVerdict('Review feedback addressed. Auto-fix completed - CI passing'), 'no verdict');
    const body = postedBody();
    expect(body).not.toContain('Review feedback addressed');
    expect(body).not.toContain('Auto-fix completed - CI passing');
    const critical = { author: 'claude[bot]', body: '🔴 critical: data loss in src/a.ts', createdAt: '2026-11-01T00:00:00Z' };
    const notes = { author: 'openswarm', body, createdAt: '2026-11-02T00:00:00Z' };
    expect(getActiveCriticalComments([critical, notes])).toContainEqual(critical);
  });

  it('escapes HTML comments in the notes so they cannot forge a hidden marker', () => {
    expect(sanitizeNoDecisionText(`x ${noDecisionMarker('other')} y`)).not.toContain('<!--');
  });

  it('marks the comment with the reviewed head', async () => {
    await postNoDecisionNotes(pr, SHA, noVerdict('src/a.ts:42 swallows the error'), 'no verdict');
    expect(postedBody()).toContain(`<!-- openswarm:no-decision:${SHA} -->`);
  });

  it('does not post twice for the same head, and posts again for a new head', async () => {
    gh.getPRComments.mockResolvedValue([{ author: 'openswarm', body: `old\n\n${noDecisionMarker(SHA)}`, createdAt: '2026-11-01T00:00:00Z' }]);
    expect(await postNoDecisionNotes(pr, SHA, noVerdict('notes'), 'no verdict')).toBe(true);
    expect(gh.commentOnPROrThrow).not.toHaveBeenCalled();

    expect(await postNoDecisionNotes(pr, 'newhead999', noVerdict('notes'), 'no verdict')).toBe(true);
    expect(gh.commentOnPROrThrow).toHaveBeenCalledTimes(1);
  });

  it('still posts when the comment listing fails', async () => {
    gh.getPRComments.mockRejectedValueOnce(new Error('gh exited with code 1'));
    expect(await postNoDecisionNotes(pr, SHA, noVerdict('notes'), 'no verdict')).toBe(true);
    expect(gh.commentOnPROrThrow).toHaveBeenCalledTimes(1);
  });
});

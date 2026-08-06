import { describe, it, expect } from 'vitest';
import { isReviewBotComment, getActiveCriticalComments, type PRIssueComment } from './prProcessor.js';

function comment(over: Partial<PRIssueComment> = {}): PRIssueComment {
  return {
    author: 'claude',
    body: '🔴 critical: fix the off-by-one',
    createdAt: '2026-08-05T00:00:00.000Z',
    ...over,
  };
}

// Regression: critical-comment detection only ever matched "claude" (the
// claude-review action), so a repo also running a Codex-based review action
// had its feedback silently invisible to `openswarm pr fix`/`pr review` —
// codex left a comment, nothing ever picked it up.
describe('isReviewBotComment', () => {
  it('matches claude and codex authors, case-insensitively', () => {
    expect(isReviewBotComment(comment({ author: 'claude' }))).toBe(true);
    expect(isReviewBotComment(comment({ author: 'claude-review[bot]' }))).toBe(true);
    expect(isReviewBotComment(comment({ author: 'Codex' }))).toBe(true);
    expect(isReviewBotComment(comment({ author: 'chatgpt-codex-connector[bot]' }))).toBe(true);
  });

  it('does not match an unrelated human or bot author', () => {
    expect(isReviewBotComment(comment({ author: 'unohee' }))).toBe(false);
    expect(isReviewBotComment(comment({ author: 'dependabot[bot]' }))).toBe(false);
  });

  it('does not match a human account whose name merely contains "claude" or "codex"', () => {
    // Substring-only matching (no [bot] anchor) would misattribute a human
    // comment as automated reviewer feedback — a name collision, not a bot.
    expect(isReviewBotComment(comment({ author: 'claudex' }))).toBe(false);
    expect(isReviewBotComment(comment({ author: 'codexfan99' }))).toBe(false);
  });
});

describe('getActiveCriticalComments', () => {
  it('picks up a critical Codex comment the same way it would a Claude one', () => {
    const comments = [comment({ author: 'chatgpt-codex-connector[bot]', body: 'bug: null deref on line 42' })];
    expect(getActiveCriticalComments(comments)).toEqual(comments);
  });

  it('ignores a critical-sounding comment from a non-review-bot author', () => {
    const comments = [comment({ author: 'unohee', body: 'this looks like a critical bug to me' })];
    expect(getActiveCriticalComments(comments)).toEqual([]);
  });

  it('does not treat a keyword embedded in an unrelated word as critical', () => {
    // Bare substring matching used to fire inside "debug"/"bugfix"/"prerequisite".
    expect(getActiveCriticalComments([comment({ author: 'codex', body: 'left a debug log statement in, non-blocking' })])).toEqual([]);
    expect(getActiveCriticalComments([comment({ author: 'codex', body: 'a small prerequisite change would help' })])).toEqual([]);
  });

  it('still matches the keyword as a standalone word', () => {
    const comments = [comment({ author: 'codex', body: 'this is required before merge' })];
    expect(getActiveCriticalComments(comments)).toEqual(comments);
  });

  it('drops comments already superseded by a "Review feedback addressed" marker', () => {
    const comments = [
      comment({ author: 'codex', body: 'critical: fix this', createdAt: '2026-08-05T00:00:00.000Z' }),
      comment({ author: 'openswarm-bot', body: 'Review feedback addressed', createdAt: '2026-08-05T01:00:00.000Z' }),
    ];
    expect(getActiveCriticalComments(comments)).toEqual([]);
  });

  it('keeps a critical comment posted after the last "addressed" marker', () => {
    const addressed = comment({ author: 'openswarm-bot', body: 'Review feedback addressed', createdAt: '2026-08-05T00:00:00.000Z' });
    const fresh = comment({ author: 'codex', body: 'critical: new issue found', createdAt: '2026-08-05T01:00:00.000Z' });
    expect(getActiveCriticalComments([addressed, fresh])).toEqual([fresh]);
  });
});

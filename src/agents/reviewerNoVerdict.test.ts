import { describe, expect, it } from 'vitest';
import { MAX_PARTIAL_REVIEW_CHARS, noDecisionComment, partialReviewerText, transcriptNotes } from './reviewerNoVerdict.js';

describe('partialReviewerText (AGT-4413)', () => {
  it('returns nothing for empty output', () => {
    expect(partialReviewerText(undefined)).toBeUndefined();
    expect(partialReviewerText('   \n ')).toBeUndefined();
  });

  it('keeps plain prose', () => {
    expect(partialReviewerText('  src/a.ts:42 swallows the error.\n')).toBe('src/a.ts:42 swallows the error.');
  });

  it('drops a CLI JSON event stream', () => {
    const stream = ['{"type":"system"}', '{"type":"assistant","text":"x"}', '{"type":"result"}'].join('\n');
    expect(partialReviewerText(stream)).toBeUndefined();
  });

  it('bounds long text and says it was cut', () => {
    const out = partialReviewerText('x'.repeat(MAX_PARTIAL_REVIEW_CHARS + 50))!;
    expect(out.length).toBeLessThan(MAX_PARTIAL_REVIEW_CHARS + 30);
    expect(out).toMatch(/truncated\)$/);
  });
});

describe('noDecisionComment', () => {
  it('states there is no decision before any partial note', () => {
    const body = noDecisionComment({ reviewedSha: 'abcdef1234', reason: 'no verdict', partialText: 'note A' });
    expect(body.split('\n')[0]).toContain('abcdef1: no decision');
    expect(body.indexOf('**Decision: NONE.**')).toBeLessThan(body.indexOf('note A'));
    expect(body).toContain('**Reason:** no verdict');
  });
});

describe('transcriptNotes (AGT-4413)', () => {
  it('labels a digest so it is not read as a conclusion', () => {
    const notes = transcriptNotes('- tool `read_file` {"path":"a.ts"}')!;
    expect(notes).toMatch(/^_The reviewer's final message was empty/);
    expect(notes).toContain('- tool `read_file`');
  });

  it('returns nothing for an empty digest', () => {
    expect(transcriptNotes(undefined)).toBeUndefined();
    expect(transcriptNotes('  ')).toBeUndefined();
  });
});

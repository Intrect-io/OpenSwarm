import { describe, expect, it } from 'vitest';
import { answerHint, correlationIdFromHint } from './answerHint.js';

// AGT-4070: a posted question is the agent's own words followed by a generated
// instruction, and a reply is matched back by reading that instruction. The
// agent's text comes FIRST, so an unanchored scan would let a question that
// merely discusses `!answer` hand the reply the wrong correlation id.
// (Caught by the commit-gate review.)
describe('answerHint / correlationIdFromHint', () => {
  it('round-trips the correlation id it wrote', () => {
    expect(correlationIdFromHint(answerHint('hq-abc123'))).toBe('hq-abc123');
  });

  it('reads the generated line, not a correlation id mentioned in the question body', () => {
    const posted = [
      'OpenSwarm needs a decision for AX-1 (asked by kestrel_build).',
      'The runbook says to use !answer hq-WRONG when a job stalls — should we keep that?',
      '',
      answerHint('hq-RIGHT'),
    ].join('\n');
    expect(correlationIdFromHint(posted)).toBe('hq-RIGHT');
  });

  it('ignores a hint-shaped line the body only quotes in passing', () => {
    // A prefix match is not enough: the whole line has to be the hint.
    const posted = `See the note: ${answerHint('hq-QUOTED')} (do not do this yet)\n\n${answerHint('hq-REAL')}`;
    expect(correlationIdFromHint(posted)).toBe('hq-REAL');
  });

  it('prefers the generated line over an earlier one the body reproduces in full', () => {
    // An agent that quotes a previous question verbatim puts a complete,
    // well-formed hint line in the body — above the generated one. The last
    // line wins because ours is always appended last.
    const posted = [
      'OpenSwarm needs a decision for AX-1.',
      'Last time you told me:',
      answerHint('hq-OLD'),
      'Does that still apply?',
      '',
      answerHint('hq-CURRENT'),
    ].join('\n');
    expect(correlationIdFromHint(posted)).toBe('hq-CURRENT');
  });

  it('rejects a line that opens like the hint but does not end like it', () => {
    // Agent text is untrusted and can start with anything, including our own
    // prefix. Without the closing anchor this hands back `hq-BAD`.
    expect(correlationIdFromHint(
      'Reply to this message with your answer, or: !answer hq-BAD and hurry',
    )).toBeUndefined();
  });

  it('finds nothing in a message that carries no hint', () => {
    expect(correlationIdFromHint('Build finished in 41s')).toBeUndefined();
    expect(correlationIdFromHint('!answer hq-abc123 yes')).toBeUndefined();
    expect(correlationIdFromHint(undefined)).toBeUndefined();
    expect(correlationIdFromHint('')).toBeUndefined();
  });
});

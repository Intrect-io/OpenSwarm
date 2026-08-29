// ============================================
// OpenSwarm - The one place the operator answer hint is written and read (AGT-4070)
// ============================================
//
// A posted question is agent-authored text followed by a generated instruction,
// and a reply is matched back to its question by reading that instruction out of
// the message Discord stores. So the two sides must agree exactly, and the match
// must be anchored to the generated line rather than scanning the whole message:
// the agent's own words come FIRST, and a question that happens to discuss
// `!answer <something>` would otherwise hand the reply a different correlation
// id — or none. (Caught by the commit-gate review.)
//
// Imports nothing on purpose: both the coordination and Discord layers take it
// statically, and anything heavier here would close a cycle between them.

const HINT_PREFIX = 'Reply to this message with your answer, or: !answer ';
const HINT_SUFFIX = ' <your answer>';

/** The instruction appended to a question posted to the operator. */
export function answerHint(correlationId: string): string {
  return `${HINT_PREFIX}${correlationId}${HINT_SUFFIX}`;
}

/**
 * The correlation id carried by a posted question, or undefined if the text
 * carries no hint of ours.
 *
 * Anchored to a whole line, and the LAST such line wins: the generated hint is
 * appended after the agent's text, so a body that quotes an older hint cannot
 * outrank the real one.
 */
export function correlationIdFromHint(text: string | undefined): string | undefined {
  if (!text) return undefined;
  const pattern = new RegExp(
    `^${escapeRegExp(HINT_PREFIX)}(\\S+)${escapeRegExp(HINT_SUFFIX)}$`,
  );
  for (const line of text.split('\n').reverse()) {
    const match = pattern.exec(line.trim());
    if (match) return match[1];
  }
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

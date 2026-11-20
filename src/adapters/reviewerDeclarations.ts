/**
 * How a reviewer writes its verdict down in prose, in one place.
 *
 * The text-fallback parser, the "declared a non-approval" detector and the
 * decision-phrase stripper used three hand-written regexes that only knew
 * `Decision: X`. A reviewer writing `**Decision:** REJECT` (markdown bold, the
 * most common shape from chat-tuned models) matched none of them: the parser
 * saw no verdict, the format repair ran, and a repaired `{"decision":"approve"}`
 * was accepted over the written-down reject. All three now come from the same
 * pieces, so they cannot drift apart again. (AGT-4313 review)
 */

/** Emphasis, quotes and whitespace that may surround a label or a verdict. */
const DECOR = String.raw`[*_\x60"'\s]*`;

/**
 * `Decision` followed by at most one separator (`:`, `=`, `-`, an en or em
 * dash), which may be omitted as it always could be (`Decision approve`).
 * Not the word "is": "the decision is approved by …" is prose about the code.
 */
const LOOSE = String.raw`${DECOR}(?:[:=\-–—])?${DECOR}`;

/**
 * `Verdict` and `Recommendation` are ordinary English words, so they declare
 * only with a real separator or a line break (a `## Verdict` heading): "the
 * earlier verdict approved the old API" is prose, not a verdict.
 */
const STRICT = String.raw`[*_\x60"'\s]*?(?:[:=\-–—]|\n)${DECOR}`;

/**
 * Label plus separator. Letter lookarounds instead of `\b`: `_` is a word
 * character, so `\bdecision\b` cannot match `__Decision__`. `afterLabel` is
 * inserted right after the label word (DECLARED_VERDICT uses it to leave a
 * quoted JSON key to the JSON parser).
 */
const declaration = (afterLabel = '') =>
  String.raw`(?:(?<![A-Za-z])decision(?![A-Za-z])${afterLabel}${LOOSE}`
    + String.raw`|(?<![A-Za-z])(?:verdict|recommendation)(?![A-Za-z])${afterLabel}${STRICT})`;

const APPROVE = String.raw`approve[d]?`;
// Inflected stems spelled out: the old prefix match read `Decision: revisions
// needed` and `Decision: rejection`, and a bare `revis\w*` would read "revisit".
const NON_APPROVE = String.raw`reject(?:s|ed|ion|ions)?|revis(?:e|es|ed|ing|ion|ions)|request(?:ed|ing)?[- ]?changes|changes[- ]requested`;
const END = String.raw`(?![A-Za-z])`;

/**
 * Every declared verdict in a text; group 1 is the verdict word. A quoted key
 * (`"decision": …`) is left to the JSON parser: a JSON block that failed to
 * parse is the format repair's job, not something to half-read as prose.
 */
export const DECLARED_VERDICT = new RegExp(`${declaration(`(?!["'])`)}(${APPROVE}|${NON_APPROVE})${END}`, 'gi');

/** A declared reject/revise/request-changes, in any of the shapes above or a malformed JSON block. */
export const DECLARED_NON_APPROVAL = new RegExp(`${declaration()}(?:${NON_APPROVE})${END}`, 'i');

/** The declaration itself (label + verdict), to strip when asking whether anything else was said. */
export const DECISION_PHRASE = new RegExp(`${declaration()}(?:${APPROVE}|${NON_APPROVE})${END}[*_\x60"']*`, 'gi');

/**
 * Any sign in the text that the reviewer did NOT consider the change
 * approvable, declared or not. A format repair exists to recover a verdict the
 * reviewer never emitted, so it may only yield `approve` from a text with none
 * of these. Deliberately broad: a false positive ("no blocking issues") only
 * refuses the repaired approve and leaves the caller's fail-closed "no verdict"
 * outcome, while a false negative ships an approval the reviewer argued against.
 */
export const NON_APPROVAL_SIGNAL = new RegExp(
  String.raw`(?<![A-Za-z])(?:`
    + String.raw`reject(?:s|ed|ing|ion|ions)?|revis(?:e|es|ed|ing|ion|ions)|request(?:s|ed|ing)?[- ]changes|changes[- ]requested`
    + String.raw`|needs?[- ](?:changes|work|fix(?:es|ing)?)|blocking|blockers?|must[- ]fix|must be fixed`
    + String.raw`|do not merge|don'?t merge|not (?:safe|ready) to merge|critical|major`
    + String.raw`)(?![A-Za-z])`,
  'i',
);

export type DeclaredVerdict = 'approve' | 'revise' | 'reject';

/**
 * The verdict declared in the text, or null. Any declared non-approval beats a
 * declared approve, so "Recommendation: approve once fixed … Decision: REJECT"
 * cannot read as an approval because the softer phrase came first. Among
 * non-approvals the FIRST one wins, as before: a later hit inside quoted code
 * or prose ("the handler's `decision: 'reject'` branch") must not escalate a
 * leading `Decision: revise` into a terminal reject (INT-2485).
 */
export function declaredVerdict(text: string): DeclaredVerdict | null {
  let sawApprove = false;
  for (const match of text.matchAll(DECLARED_VERDICT)) {
    const word = match[1].toLowerCase();
    if (word.startsWith('approv')) { sawApprove = true; continue; }
    return word.startsWith('reject') ? 'reject' : 'revise';
  }
  return sawApprove ? 'approve' : null;
}

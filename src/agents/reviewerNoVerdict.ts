/**
 * A reviewer that ran but produced no verdict, with whatever it did say. (AGT-4413)
 *
 * On cgf-portal PR 521 the reviewer spent 24 API calls reading the diff, then
 * ended without a `Decision:` line. The gate reported "no parseable verdict"
 * and nothing else, so the reading was lost, and a human review then found
 * four major defects. The format repair (AGT-4313) and the empty-final retry
 * (AGT-4450) make that rarer. When it still happens, the reviewer's last text
 * travels with the error so `pr review --fresh` can post it under an explicit
 * "no decision" header. "No verdict" then stops meaning "no information".
 */

/** Longest partial text carried to a PR comment. */
export const MAX_PARTIAL_REVIEW_CHARS = 6000;

export class ReviewerNoVerdictError extends Error {
  /** The reviewer's final text, bounded; undefined when it said nothing usable. */
  readonly partialText?: string;

  constructor(message: string, partialText: string | undefined, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReviewerNoVerdictError';
    this.partialText = partialText;
  }
}

/**
 * The part of a reviewer's raw output worth showing a human, or undefined.
 *
 * In-process adapters return the final assistant text. A CLI adapter can return
 * a JSON event stream, which would be noise on a PR, so output that is mostly
 * JSON lines is dropped rather than posted.
 */
export function partialReviewerText(stdout: string | undefined): string | undefined {
  const text = (stdout ?? '').trim();
  if (!text) return undefined;
  const lines = text.split('\n').filter((line) => line.trim());
  const jsonLines = lines.filter((line) => line.trimStart().startsWith('{')).length;
  if (lines.length > 1 && jsonLines * 2 > lines.length) return undefined;
  return text.length > MAX_PARTIAL_REVIEW_CHARS
    ? `${text.slice(0, MAX_PARTIAL_REVIEW_CHARS)}\n\n… (truncated)`
    : text;
}

/**
 * Partial notes built from the loop's transcript digest, for a reviewer whose
 * final message was empty (cgf-portal PR 521: the forced final turn and its
 * retry both came back empty). Labelled, so nobody reads a list of tool calls
 * as the reviewer's conclusion. (AGT-4413)
 */
export function transcriptNotes(digest: string | undefined): string | undefined {
  if (!digest?.trim()) return undefined;
  return partialReviewerText(
    "_The reviewer's final message was empty. Below is a digest of what it said and which tools it called._\n\n"
      + digest.trim(),
  );
}

/** PR comment body for a fresh review that ended without a decision. */
export function noDecisionComment(input: { reviewedSha: string; reason: string; partialText: string }): string {
  return [
    `## 🔍 Fresh review of ${input.reviewedSha.slice(0, 7)}: no decision (\`openswarm pr review --fresh\`)`,
    '',
    '**Decision: NONE.** The reviewer ran but did not reach a verdict, so this pull request is **not reviewed**. '
      + 'Do not read the notes below as an approval or a complete list of findings.',
    '',
    `**Reason:** ${input.reason}`,
    '',
    '### Partial reviewer notes',
    '',
    input.partialText,
  ].join('\n');
}

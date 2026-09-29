// ============================================
// OpenSwarm - PR review comment classification
// Which PR comments count as actionable review feedback?
//
// Split out of prProcessor.ts, which sits on the 1500-line pre-commit cap.
// Pure and self-contained: no git, no GitHub calls, no PR state.
// ============================================

export type PRIssueComment = {
  author: string;
  body: string;
  createdAt: string;
};

const CRITICAL_COMMENT_KEYWORDS = ['🔴', 'critical', '버그', 'bug', '수정 필요', 'must fix', '필수', 'required'];

/**
 * Bare substring matching on 'bug'/'critical'/'required' also fires inside
 * "debug", "bugfix", "prerequisite" — words with no bearing on whether a
 * comment is actionable review feedback. Word-boundary matching for the
 * single-token ASCII keywords fixes that without touching the multi-word
 * phrase or the Korean/emoji tokens, where `\b` isn't meaningful.
 */
function matchesCriticalKeyword(bodyLower: string): boolean {
  return CRITICAL_COMMENT_KEYWORDS.some((keyword) => {
    const kw = keyword.toLowerCase();
    return /^[a-z]+$/.test(kw) ? new RegExp(`\\b${kw}\\b`).test(bodyLower) : bodyLower.includes(kw);
  });
}

const FEEDBACK_ADDRESSED_MARKERS = [
  'Review feedback addressed',
  'Auto-fix completed - CI passing',
];

/** Known AI review-bot author name fragments. Codex comments were previously
 * invisible to critical-comment detection because this check only matched
 * "claude" — the `claude-review` action was the only bot in mind when it was
 * written, so a repo also running a Codex-based review action never had its
 * feedback picked up here at all. */
const REVIEW_BOT_AUTHOR_FRAGMENTS = ['claude', 'codex'];

export function isReviewBotComment(comment: PRIssueComment): boolean {
  const author = comment.author.toLowerCase();
  // Exact bare name (e.g. a PAT-based integration posting as "codex"), or a
  // GitHub App/bot account (GitHub always suffixes those "[bot]") whose name
  // contains the fragment. Plain substring matching without the [bot] anchor
  // would also treat a human account that merely contains "claude"/"codex" in
  // its username as an automated reviewer.
  return REVIEW_BOT_AUTHOR_FRAGMENTS.some((fragment) =>
    author === fragment || (author.endsWith('[bot]') && author.includes(fragment)));
}

export function getActiveCriticalComments(comments: PRIssueComment[]): PRIssueComment[] {
  const lastAddressedAt = comments.reduce<number | null>((latest, comment) => {
    if (!FEEDBACK_ADDRESSED_MARKERS.some((marker) => comment.body.includes(marker))) {
      return latest;
    }
    const createdAt = new Date(comment.createdAt).getTime();
    if (Number.isNaN(createdAt)) return latest;
    return latest === null || createdAt > latest ? createdAt : latest;
  }, null);

  return comments.filter((comment) => {
    const createdAt = new Date(comment.createdAt).getTime();
    if (lastAddressedAt !== null && (!Number.isNaN(createdAt) && createdAt <= lastAddressedAt)) {
      return false;
    }
    return isReviewBotComment(comment) && matchesCriticalKeyword(comment.body.toLowerCase());
  });
}

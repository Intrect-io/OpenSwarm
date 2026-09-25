// ============================================
// OpenSwarm — the subject line of the daemon's own publication commit (AGT-4410)
// ============================================
//
// `commitAndCreatePRWithHead` wrote `feat(<issue>): <title>` for every commit
// it made, whatever the change was. Two shapes reached cgf-portal on
// 2026-09-17: a title that already carried its own type produced the double
// prefix `feat(AX-1420): fix(integrations): make external writes idempotent…`
// (#488), and a docs-only diff shipped as `feat(AX-1439)` (#503). The type is
// derived here instead — from the title when the issue author chose one, and
// from what was actually staged when they did not.

const CONVENTIONAL_TYPES = ['feat', 'fix', 'docs', 'style', 'refactor', 'perf', 'test', 'build', 'ci', 'chore', 'revert'] as const;
type ConventionalType = (typeof CONVENTIONAL_TYPES)[number];

const TITLE_PREFIX_RE = new RegExp(`^(${CONVENTIONAL_TYPES.join('|')})(?:\\(([^)]*)\\))?(!?):\\s*(.+)$`, 'i');

/** The staged path is documentation: Markdown/text anywhere, or anything under a docs tree. */
const DOC_FILE_RE = /(?:^|\/)(?:docs?|documentation)\/|\.(?:md|mdx|rst|txt|adoc)$/i;
/** The staged path is a test: named like one, or under a test tree. */
const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?|spec)\/|(?:^|\/)test_[^/]+\.py$|[._-](?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb)$/i;

/** Commit type from the change itself, used only when the title names none. */
export function inferCommitType(files: readonly string[]): ConventionalType {
  if (files.length === 0) return 'feat';
  if (files.every((file) => DOC_FILE_RE.test(file))) return 'docs';
  if (files.every((file) => TEST_FILE_RE.test(file))) return 'test';
  return 'feat';
}

/**
 * Subject line for the daemon's publication commit.
 *
 * A title that already has a conventional prefix keeps its type (and its `!`)
 * and yields the issue as the scope, so the original scope survives in the
 * description: `fix(integrations): make …` for AX-1420 becomes
 * `fix(AX-1420): integrations: make …`. Otherwise the type comes from the
 * staged files. Always ≤ 72 characters of description, as before.
 */
export function publicationCommitSubject(
  issueIdentifier: string,
  title: string,
  stagedFiles: readonly string[],
): string {
  const match = TITLE_PREFIX_RE.exec(title.trim());
  if (match) {
    const [, type, scope, bang, rest] = match;
    // A scope that is the issue itself would only repeat the one added here.
    const description = scope && scope.toLowerCase() !== issueIdentifier.toLowerCase() ? `${scope}: ${rest}` : rest;
    return `${type.toLowerCase()}(${issueIdentifier})${bang}: ${description.slice(0, 72)}`;
  }
  return `${inferCommitType(stagedFiles)}(${issueIdentifier}): ${title.trim().slice(0, 72)}`;
}

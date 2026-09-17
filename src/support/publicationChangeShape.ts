// ============================================
// OpenSwarm — what kind of change a PR actually carries, stated on the PR (AGT-4407 / AGT-4408)
// ============================================
//
// cgf-portal 2026-09-17: 9 of 11 PRs added code with no test; #503 was titled
// "재처리·회귀 검증" and changed two docs files. A title is the issue's claim;
// this section is the diff's answer, computed from the file list so it cannot
// be argued with.

const DOC_FILE_RE = /(?:^|\/)(?:docs?|documentation)\/|\.(?:md|mdx|rst|txt|adoc)$/i;
const TEST_FILE_RE = /(?:^|\/)(?:__tests__|tests?|spec)\/|(?:^|\/)test_[^/]+\.py$|[._-](?:test|spec)\.[cm]?[jt]sx?$|_test\.(?:go|py|rb)$/i;
const SOURCE_FILE_RE = /\.(?:[cm]?[jt]sx?|py|go|rb|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|scala|sh)$/i;

export interface ChangeShape {
  source: number;
  tests: number;
  docs: number;
  other: number;
  /** Source changed, no test file did. */
  testsNone: boolean;
  /** Nothing but documentation changed. */
  docsOnly: boolean;
}

export function changeShape(files: readonly string[]): ChangeShape {
  let source = 0, tests = 0, docs = 0, other = 0;
  for (const file of files) {
    if (TEST_FILE_RE.test(file)) tests++;
    else if (DOC_FILE_RE.test(file)) docs++;
    else if (SOURCE_FILE_RE.test(file)) source++;
    else other++;
  }
  return {
    source, tests, docs, other,
    testsNone: source > 0 && tests === 0,
    docsOnly: files.length > 0 && docs === files.length,
  };
}

/** Markdown section for the PR body, or '' when the diff is empty. */
export function changeShapeSection(files: readonly string[]): string {
  if (files.length === 0) return '';
  const shape = changeShape(files);
  const lines = [
    '## Change shape',
    `${files.length} file(s): ${shape.source} source · ${shape.tests} test · ${shape.docs} docs · ${shape.other} other`,
  ];
  if (shape.testsNone) lines.push('⚠ **tests: none** — source changed and no test file did.');
  if (shape.docsOnly) lines.push('⚠ **docs-only** — no code or tests changed; anything the title claims to have run, wired or verified is not in this diff.');
  return lines.join('\n');
}

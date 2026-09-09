// ============================================
// OpenSwarm — a diff that removes test cases has to say why (AGT-4277)
// ============================================
//
// PR #580, written by the loop and green on all eight CI checks, deleted four
// tests from `planCommand.test.ts`. They had not broken: main's originals pass
// unmodified against that PR's own production code. Three mutations of
// `planCommand.ts` — dropping the `decision === 'no'` early return, neutering
// the drop filter, disabling the `mode === 'linear'` branch — survived the
// PR's suite and died against main's.
//
// No gate saw it. The coverage threshold is a repository-wide ratio, so four
// tests in one file move it by nothing, and the reviewer reads added code.
// This check is deterministic on purpose: "the diff removes test cases" is a
// property of the text, and does not need a model to have an opinion about it.

/** A test file's `it(`/`test(` case count, before and after. */
export interface TestCaseDelta {
  file: string;
  before: number;
  after: number;
}

export interface DeletedTestFinding {
  /** Files that lost cases, worst first. */
  files: TestCaseDelta[];
  /** Total cases removed across the diff. */
  removed: number;
}

// `it(`, `test(`, `it.each(`, `test.only(`, … but not `it.skip` being counted
// twice via `describe`. Deliberately loose: this counts declarations, and the
// only thing it has to get right is the DIRECTION of the change between two
// versions of the same file, which a consistent undercount preserves.
const TEST_CASE = /(?:^|[\s;{}])(?:it|test)(?:\.\w+)*\s*(?:\(|`)/g;

/** How many test cases a file declares. */
export function countTestCases(source: string): number {
  return source.match(TEST_CASE)?.length ?? 0;
}

/**
 * Report the test cases a change removes.
 *
 * A file that disappears entirely counts all of its cases as removed — that is
 * the same loss, arrived at by a bigger deletion.
 */
export function findDeletedTests(
  changed: Array<{ file: string; before: string | null; after: string | null }>,
): DeletedTestFinding {
  const files: TestCaseDelta[] = [];
  for (const { file, before, after } of changed) {
    if (!/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) continue;
    const from = before === null ? 0 : countTestCases(before);
    const to = after === null ? 0 : countTestCases(after);
    if (to < from) files.push({ file, before: from, after: to });
  }
  files.sort((a, b) => (b.before - b.after) - (a.before - a.after));
  return { files, removed: files.reduce((n, f) => n + (f.before - f.after), 0) };
}

/**
 * The note that goes on the pull request.
 *
 * Not a block: renaming a suite, merging two cases, or deleting genuinely
 * obsolete coverage are all legitimate, and a gate that refused them would be
 * routed around within a day. What was missing was anyone *noticing* — so this
 * states the loss, in the one place a reviewer is already looking, and puts
 * the burden of saying why on the change.
 */
export function deletedTestNotice(finding: DeletedTestFinding): string {
  const rows = finding.files
    .map(f => `| \`${f.file}\` | ${f.before} | ${f.after} | −${f.before - f.after} |`)
    .join('\n');
  return `## ⚠️ This change removes ${finding.removed} test case(s)\n\n`
    + '| File | Before | After | Change |\n| --- | ---: | ---: | ---: |\n'
    + `${rows}\n\n`
    + 'Deleting a test is a legitimate thing to do — a rename, a merge, coverage '
    + 'that is genuinely obsolete. It is also the cheapest way to make a suite '
    + 'pass, and a repository-wide coverage threshold does not move enough to '
    + 'notice.\n\n'
    + '**If these were removed to get green, restore them.** If they were '
    + 'removed deliberately, say so in the description — a later reader cannot '
    + 'tell the two apart from the diff alone.';
}

/**
 * Read the test-case delta a branch introduces, from the worktree that holds it.
 *
 * Runs against the branch's own worktree, which still exists at publication
 * time (cleanup is the caller's `finally`), so no fetch or scratch checkout is
 * needed — the daemon already paid for this checkout.
 */
export async function collectTestCaseDeltas(
  baseRef: string,
  /** `git` in the branch's worktree. Injected so this stays testable and cwd-explicit. */
  run: (args: string[]) => Promise<string>,
): Promise<DeletedTestFinding> {
  let base: string;
  try {
    base = (await run(['merge-base', baseRef, 'HEAD'])).trim();
  } catch {
    // No shared history to compare against says nothing about deleted tests.
    return { files: [], removed: 0 };
  }
  if (!base) return { files: [], removed: 0 };

  const names = (await run(['diff', '--name-only', `${base}..HEAD`])).split('\n')
    .map(n => n.trim())
    .filter(n => /\.(test|spec)\.[cm]?[jt]sx?$/.test(n));

  const changed: Array<{ file: string; before: string | null; after: string | null }> = [];
  for (const file of names) {
    // A file absent on one side is a genuine outcome (added, or deleted), not
    // an error — `git show` exits non-zero for both.
    const at = async (ref: string) => { try { return await run(['show', `${ref}:${file}`]); } catch { return null; } };
    changed.push({ file, before: await at(base), after: await at('HEAD') });
  }
  return findDeletedTests(changed);
}

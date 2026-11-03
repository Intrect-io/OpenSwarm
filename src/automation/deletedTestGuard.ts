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

/** A test file's active case count, before and after. */
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

// What counts is ACTIVE cases. Turning `it(` into `it.skip(` removes a test
// from the suite as surely as deleting it, and an earlier version of this
// guard counted both the same (round-1 redteam, 2026-11-03). Deliberately
// loose otherwise: this counts declarations, and the only thing it has to get
// right is the DIRECTION of the change between two versions of the same file,
// which a consistent undercount preserves.

/** Test files the guard reads: JS/TS `*.test.*`/`*.spec.*`, pytest modules, Go `_test.go`. */
export type TestFileKind = 'js' | 'python' | 'go';

export function testFileKind(file: string): TestFileKind | null {
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(file)) return 'js';
  if (/(^|\/)test_[^/]*\.py$/.test(file) || file.endsWith('_test.py')) return 'python';
  if (file.endsWith('_test.go')) return 'go';
  return null;
}

// `it(`, `test(`, `it.each(`, `test.only(`, `xit(` … not `submit(` or `foo.it(`.
const JS_CASE = /(?<![\w$.])(x?)(?:it|test)((?:\.\w+)*)\s*[(`]/g;
const JS_SUITE = /(?<![\w$.])(x?)describe((?:\.\w+)*)\s*\(/g;
const INACTIVE_MODIFIER = /\.(?:skip|todo|skipIf)\b/;

/** Index just past the `)` that closes the `(` at `open`, skipping string literals. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i++; i < source.length && source[i] !== ch; i++) if (source[i] === '\\') i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) return i + 1;
  }
  return source.length;
}

function countJsCases(source: string): number {
  const skippedSuites: Array<[number, number]> = [];
  for (const m of source.matchAll(JS_SUITE)) {
    if (m[1] || INACTIVE_MODIFIER.test(m[2])) {
      const open = m.index + m[0].length - 1;
      skippedSuites.push([open, closingParen(source, open)]);
    }
  }
  let count = 0;
  for (const m of source.matchAll(JS_CASE)) {
    if (m[1] || INACTIVE_MODIFIER.test(m[2])) continue;
    if (skippedSuites.some(([from, to]) => m.index > from && m.index < to)) continue;
    count++;
  }
  return count;
}

const PY_SKIP_DECORATOR = /^\s*@(?:pytest\.mark\.skip(?:if)?|unittest\.skip\w*)\b/;

/** The decorator lines directly above line `index`. */
function decoratorsAbove(lines: string[], index: number): string[] {
  const found: string[] = [];
  for (let i = index - 1; i >= 0 && /^\s*@/.test(lines[i]); i--) found.push(lines[i]);
  return found;
}

function countPythonCases(source: string): number {
  if (/^pytestmark\s*=.*pytest\.mark\.skip/m.test(source)) return 0;
  const lines = source.split('\n');
  let count = 0;
  for (let i = 0; i < lines.length; i++) {
    const def = lines[i].match(/^(\s*)(?:async\s+)?def\s+test\w*\s*\(/);
    if (!def) continue;
    if (decoratorsAbove(lines, i).some(d => PY_SKIP_DECORATOR.test(d))) continue;
    // A method inherits a skip on its class.
    const indent = def[1].length;
    let skippedByClass = false;
    if (indent > 0) {
      for (let j = i - 1; j >= 0; j--) {
        const cls = lines[j].match(/^(\s*)class\s+\w+/);
        if (cls && cls[1].length < indent) {
          skippedByClass = decoratorsAbove(lines, j).some(d => PY_SKIP_DECORATOR.test(d));
          break;
        }
      }
    }
    if (!skippedByClass) count++;
  }
  return count;
}

const GO_TEST = /^func\s+Test\w*\s*\(\s*(\w+)\s+\*testing\.T\s*\)[^{]*\{/gm;

function countGoCases(source: string): number {
  let count = 0;
  for (const m of source.matchAll(GO_TEST)) {
    const body = source.slice(m.index + m[0].length).replace(/^\s+/, '');
    if (body.startsWith(`${m[1]}.Skip`)) continue;
    count++;
  }
  return count;
}

/** How many active test cases a file declares (JS/TS unless `file` says otherwise). */
export function countTestCases(source: string, file = 'file.test.ts'): number {
  const kind = testFileKind(file) ?? 'js';
  if (kind === 'python') return countPythonCases(source);
  if (kind === 'go') return countGoCases(source);
  return countJsCases(source);
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
    if (!testFileKind(file)) continue;
    const from = before === null ? 0 : countTestCases(before, file);
    const to = after === null ? 0 : countTestCases(after, file);
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
  } catch (err) {
    // No shared history says nothing about deleted tests — but say that it did
    // not run. A check that quietly never fires is the failure it exists to
    // catch, wearing the check's own badge.
    console.warn(`[DeletedTests] No merge base with ${baseRef}; skipping the check:`, err);
    return { files: [], removed: 0 };
  }
  if (!base) {
    console.warn(`[DeletedTests] Empty merge base with ${baseRef}; skipping the check`);
    return { files: [], removed: 0 };
  }

  const names = (await run(['diff', '--name-only', `${base}..HEAD`])).split('\n')
    .map(n => n.trim())
    .filter(n => testFileKind(n) !== null);

  const changed: Array<{ file: string; before: string | null; after: string | null }> = [];
  for (const file of names) {
    // A file absent on one side is a genuine outcome (added, or deleted), not
    // an error — `git show` exits non-zero for both.
    const at = async (ref: string) => { try { return await run(['show', `${ref}:${file}`]); } catch { return null; } };
    changed.push({ file, before: await at(base), after: await at('HEAD') });
  }
  return findDeletedTests(changed);
}

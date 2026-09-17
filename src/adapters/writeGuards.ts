// ============================================
// OpenSwarm — guards on the worker's file writes (AGT-4406)
// ============================================
//
// cgf-portal batch 2026-09-17: a worker asked to add three fields to
// `Settings` wrote the whole file back with 68 of its 95 fields (#501); two
// runs replaced an acceptance ledger with only their own section (#503, #511);
// six PRs stripped the final newline from every file they touched. None of
// those is a judgement call — a rewrite that drops a third of an existing
// file, a Python file that no longer parses, a file that lost its trailing
// newline — so they are refused or repaired at the tool layer, where the
// model cannot talk its way past them.
import { spawn } from 'node:child_process';

/** Existing files shorter than this may be rewritten freely: a rewrite of a 10-line file is an edit. */
export const REWRITE_GUARD_MIN_LINES = 20;
/** Above the line floor, a write that drops more than this share of the original's lines is refused. */
export const REWRITE_GUARD_MAX_REMOVED_RATIO = 0.3;

/** A file that ended with a newline keeps ending with one. */
export function preserveTrailingNewline(original: string, content: string): string {
  if (original.length === 0 || !original.endsWith('\n')) return content;
  if (content.length === 0 || content.endsWith('\n')) return content;
  return `${content}\n`;
}

function nonBlankLines(text: string): string[] {
  return text.split('\n').map((line) => line.trimEnd()).filter((line) => line.trim() !== '');
}

/**
 * Why a whole-file write of an existing file is refused, or null to allow it.
 *
 * Counts the original's non-blank lines that do not survive (as a multiset)
 * into the new content. A targeted change keeps almost every line; the #501
 * rewrite kept 68 of 95 fields and would have failed this at ~30% removed
 * before counting the reordering. Small files are exempt — see the floor.
 */
export function wholeFileRewriteVerdict(original: string, content: string): string | null {
  const before = nonBlankLines(original);
  if (before.length < REWRITE_GUARD_MIN_LINES) return null;
  const remaining = new Map<string, number>();
  for (const line of nonBlankLines(content)) remaining.set(line, (remaining.get(line) ?? 0) + 1);
  let removed = 0;
  for (const line of before) {
    const count = remaining.get(line) ?? 0;
    if (count > 0) remaining.set(line, count - 1);
    else removed++;
  }
  const ratio = removed / before.length;
  if (ratio <= REWRITE_GUARD_MAX_REMOVED_RATIO) return null;
  return `REFUSED: this would drop ${removed} of ${before.length} non-blank lines (${Math.round(ratio * 100)}%) of an existing file. `
    + 'Whole-file rewrites lose content outside the task (AGT-4406). Change the file with targeted edits — '
    + 'edit_file / SEARCH-REPLACE blocks whose SEARCH text is copied exactly from the file — one region at a time. '
    + 'Nothing was written.';
}

const PYTHON_PARSE = 'import ast, sys\nsrc = sys.stdin.read()\ntry:\n    ast.parse(src)\nexcept SyntaxError as e:\n    print(f"line {e.lineno}: {e.msg}")\n    sys.exit(1)\n';

/**
 * Syntax error message for a Python file's new content, or null when it parses
 * (or when no interpreter is available — the check must never block a host
 * that has no python3; the verify stage's compileall gate still runs there).
 */
export function pythonSyntaxError(filePath: string, content: string): Promise<string | null> {
  if (!/\.pyi?$/.test(filePath)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let stdout = '';
    let settled = false;
    const done = (value: string | null) => {
      if (!settled) { settled = true; resolve(value); }
    };
    const child = spawn('python3', ['-c', PYTHON_PARSE], { stdio: ['pipe', 'pipe', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); done(null); }, 5_000);
    child.on('error', () => { clearTimeout(timer); done(null); });
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.on('close', (code) => {
      clearTimeout(timer);
      const message = stdout.trim();
      done(code === 1 && message ? `SyntaxError at ${message}` : null);
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(content);
  });
}

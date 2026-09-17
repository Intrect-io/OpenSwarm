// ============================================
// OpenSwarm — the whole-file rewrite guard (AGT-4406)
// ============================================
//
// cgf-portal batch 2026-09-17: an issue asking for three new `Settings` fields
// came back as +255/−290 on config.py with 68 of the 95 fields left (#501);
// two runs replaced an acceptance ledger with only their own section (#503,
// #511); six PRs stripped the trailing newline from every file they touched.
// The worker gets there through bash — a Python script in /tmp that reads the
// file, rebuilds it and writes it back — so a tool-level check on write_file
// cannot see it. What can is the working tree after the worker stage: a file
// that lost a third of its lines, and a file whose last byte changed from
// "\n" to something else.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getWorkingDiffDetail, type FileDiffDetail } from '../support/gitTracker.js';

const execFileAsync = promisify(execFile);

/** Existing files shorter than this may be rewritten freely: rewriting a 15-line file is an edit. */
export const REWRITE_MIN_LINES = 20;
/** Above the floor, deleting more than this share of a file's lines is a rewrite. */
export const REWRITE_MAX_DELETED_RATIO = 0.3;

/**
 * The worker's escape hatch. A task really can be "rewrite this module"; the
 * worker then says so, per file, in its summary: `REWRITE: path/to/file`.
 * The guard checks for the exact path so the acknowledgement cannot be a
 * blanket one.
 */
export function acknowledgedRewrites(summary: string): Set<string> {
  const files = new Set<string>();
  for (const match of summary.matchAll(/REWRITE:\s*([^\s`'"]+)/g)) files.add(match[1].replace(/^\.\//, ''));
  return files;
}

export interface RewriteFinding {
  file: string;
  originalLines: number;
  deleted: number;
  ratio: number;
}

/** Files whose deletions exceed the ratio, judged against HEAD's line count. */
export function findRewrites(
  details: readonly FileDiffDetail[],
  headLineCounts: ReadonlyMap<string, number>,
): RewriteFinding[] {
  const findings: RewriteFinding[] = [];
  for (const d of details) {
    if (d.isNew || d.whitespaceOnly || d.deleted === 0) continue;
    const originalLines = headLineCounts.get(d.file) ?? 0;
    if (originalLines < REWRITE_MIN_LINES) continue;
    const ratio = d.deleted / originalLines;
    if (ratio > REWRITE_MAX_DELETED_RATIO) findings.push({ file: d.file, originalLines, deleted: d.deleted, ratio });
  }
  return findings;
}

async function headLineCount(projectPath: string, file: string): Promise<number> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'cat-file', '-p', `HEAD:${file}`], { maxBuffer: 64 << 20 });
    return stdout.length === 0 ? 0 : stdout.split('\n').length - (stdout.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

async function headEndsWithNewline(projectPath: string, file: string): Promise<boolean | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', projectPath, 'cat-file', '-p', `HEAD:${file}`], { maxBuffer: 64 << 20 });
    return stdout.length > 0 && stdout.endsWith('\n');
  } catch {
    return null;
  }
}

/**
 * Put back the trailing newline on modified text files that had one at HEAD.
 * Returns the files repaired. Deterministic and content-preserving, so it is a
 * repair rather than a finding — the six "\ No newline at end of file" PRs
 * needed a person to do exactly this.
 */
export async function restoreTrailingNewlines(
  projectPath: string,
  details: readonly FileDiffDetail[],
): Promise<string[]> {
  const repaired: string[] = [];
  for (const d of details) {
    if (d.isNew) continue;
    const path = join(projectPath, d.file);
    let content: string;
    try {
      content = await readFile(path, 'utf8');
    } catch {
      continue; // deleted or unreadable — not ours to touch
    }
    if (content.length === 0 || content.endsWith('\n') || content.includes('\0')) continue;
    if (await headEndsWithNewline(projectPath, d.file) !== true) continue;
    await writeFile(path, `${content}\n`, 'utf8');
    repaired.push(d.file);
  }
  return repaired;
}

export interface RewriteGuardOutcome {
  /** Blocking: rewrites the worker did not acknowledge. */
  unacknowledged: RewriteFinding[];
  /** Advisory: rewrites the worker declared with `REWRITE: <file>`. */
  acknowledged: RewriteFinding[];
  /** Repaired in place. */
  newlineRestored: string[];
}

export async function inspectRewrites(projectPath: string, workerSummary: string): Promise<RewriteGuardOutcome> {
  const details = await getWorkingDiffDetail(projectPath);
  const newlineRestored = await restoreTrailingNewlines(projectPath, details);
  const counts = new Map<string, number>();
  for (const d of details) {
    if (!d.isNew && d.deleted > 0) counts.set(d.file, await headLineCount(projectPath, d.file));
  }
  const findings = findRewrites(details, counts);
  const acknowledged = acknowledgedRewrites(workerSummary);
  return {
    unacknowledged: findings.filter((f) => !acknowledged.has(f.file)),
    acknowledged: findings.filter((f) => acknowledged.has(f.file)),
    newlineRestored,
  };
}

export function describeRewrite(f: RewriteFinding): string {
  return `[${f.file}] deleted ${f.deleted} of ${f.originalLines} lines (${Math.round(f.ratio * 100)}%) — that is a rewrite, not the task's change. `
    + `Restore it (\`git checkout -- ${f.file}\`) and re-apply only the intended change with targeted edits; `
    + `if the task really is to rewrite this file, say \`REWRITE: ${f.file}\` in your summary.`;
}

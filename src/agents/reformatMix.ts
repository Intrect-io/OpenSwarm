// ============================================
// OpenSwarm — reformat mixed with substantive changes (AGT-4899)
// ============================================
//
// AGT-4190 defence 3. The uncommitted change becomes one publication commit;
// cgf-portal #218 buried four real edits among seven reformats there — the same
// outcome as dodging review. A formatting-only change and a substantive-only
// change both pass. The worker cannot split commits (the harness commits the
// whole tree once), so the way out is reverting the formatting, or declaring
// it per file with `REFORMAT: <path>` in the summary.

import type { FileDiffDetail } from '../support/gitTracker.js';

const MIXED_PREFIX = 'Reformat mixed with substantive changes:';

/**
 * Files where leading whitespace is meaning (Python blocks, YAML nesting,
 * Makefile tabs, Markdown lists/code, CoffeeScript, Haml/Pug/Slim). `git diff -w`
 * cannot tell a re-indent from a logic change there, so a whitespace-only diff
 * counts as substantive.
 */
const INDENT_SENSITIVE = /(\.(py|pyi|ya?ml|mk|mdx?|coffee|haml|pug|slim)$)|(^|\/)(GNUm|m|M)akefile$/;

/** Lockfiles and build output: tool-written, never the worker's formatting choice. */
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|uv\.lock)$|\.min\.js$|(^|\/)(dist|build)\//;

/** True for the issue `mixedReformatIssues` produces — the one that blocks. */
export function isMixedReformatIssue(issue: string): boolean {
  return issue.startsWith(MIXED_PREFIX);
}

/** Files the worker declared as intended formatting with `REFORMAT: <path>` (same shape as `REWRITE:`). */
export function acknowledgedReformats(summary: string): Set<string> {
  const files = new Set<string>();
  for (const match of summary.matchAll(/REFORMAT:\s*([^\s`'"]+)/g)) files.add(match[1].replace(/^\.\//, ''));
  return files;
}

function isIndentSensitiveReformat(d: FileDiffDetail): boolean {
  return d.whitespaceOnly && INDENT_SENSITIVE.test(d.file);
}

/** Whitespace-only changes that really are formatting: not indentation-sensitive, not generated. */
export function reformatOnlyFiles(details: readonly FileDiffDetail[]): FileDiffDetail[] {
  return details.filter(d => d.whitespaceOnly && !INDENT_SENSITIVE.test(d.file) && !GENERATED.test(d.file));
}

/**
 * The blocking issue for a change that mixes unacknowledged reformat-only files
 * with real ones (empty when not mixed). A whitespace-only generated file is
 * neither formatting nor substance and is ignored.
 */
export function mixedReformatIssues(details: readonly FileDiffDetail[], workerSummary = ''): string[] {
  const acknowledged = acknowledgedReformats(workerSummary);
  const reformatOnly = reformatOnlyFiles(details).filter(d => !acknowledged.has(d.file));
  const substantive = details.filter(d => isIndentSensitiveReformat(d)
    || (!d.whitespaceOnly && (d.isNew || d.added + d.deleted > 0)));
  if (reformatOnly.length === 0 || substantive.length === 0) return [];
  const edited = substantive.filter(d => !d.isNew).map(d => d.file);
  const created = substantive.filter(d => d.isNew).map(d => d.file);
  const parts = [
    ...(edited.length > 0 ? [`substantive ${edited.join(', ')}`] : []),
    ...(created.length > 0 ? [`new: ${created.join(', ')}`] : []),
  ];
  const files = reformatOnly.map(d => d.file).join(', ');
  return [`${MIXED_PREFIX} reformat-only ${files}; ${parts.join('; ')}. Publication is held — revert the `
    + `formatting-only changes in ${files} (they will not be part of this change). If the formatting is intended, `
    + 'acknowledge each file with a `REFORMAT: <path>` line in your summary.'];
}

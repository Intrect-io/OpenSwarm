// ============================================
// OpenSwarm — reformat mixed with substantive changes (AGT-4899)
// ============================================
//
// AGT-4190 defence 3. The uncommitted change becomes one publication commit;
// cgf-portal #218 buried four real edits among seven reformats there — the same
// outcome as dodging review. A formatting-only change and a substantive-only
// change both pass, so committing the formatting separately clears it.

import type { FileDiffDetail } from '../support/gitTracker.js';

const MIXED_PREFIX = 'Reformat mixed with substantive changes:';

/** True for the issue `mixedReformatIssues` produces — the one that blocks. */
export function isMixedReformatIssue(issue: string): boolean {
  return issue.startsWith(MIXED_PREFIX);
}

/** The blocking issue for a change that mixes reformat-only files with real ones (empty when not mixed). */
export function mixedReformatIssues(details: FileDiffDetail[]): string[] {
  const reformatOnly = details.filter(d => d.whitespaceOnly);
  const substantive = details.filter(d => !d.whitespaceOnly && (d.isNew || d.added + d.deleted > 0));
  if (reformatOnly.length === 0 || substantive.length === 0) return [];
  return [`${MIXED_PREFIX} reformat-only ${reformatOnly.map(d => d.file).join(', ')}; `
    + `substantive ${substantive.map(d => d.file).join(', ')}. Publication is held — commit the formatting `
    + 'separately (its own commit, or revert it), so the substantive diff can be reviewed on its own.'];
}

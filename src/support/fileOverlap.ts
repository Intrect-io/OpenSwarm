// ============================================
// OpenSwarm - Branch/PR file-overlap reporting
// Pure set arithmetic and rendering, no git or gh
// ============================================

export interface BranchScope {
  /** Human label, e.g. "PR #206 (feat/int-2389-…)". */
  label: string;
  /** Files this scope changes relative to main. */
  files: string[];
}

export interface FileOverlap {
  label: string;
  files: string[];
}

/** Pure: intersect this branch's changed files with each other scope's files. */
export function computeFileOverlaps(selfFiles: string[], others: BranchScope[]): FileOverlap[] {
  const selfSet = new Set(selfFiles);
  const out: FileOverlap[] = [];
  for (const o of others) {
    const shared = o.files.filter(f => selfSet.has(f));
    if (shared.length > 0) out.push({ label: o.label, files: shared });
  }
  return out;
}

/** Pure: render overlaps as a PR-body markdown section (empty string if none). */
export function formatOverlapReport(overlaps: FileOverlap[]): string {
  if (overlaps.length === 0) return '';
  const lines = [
    '## ⚠️ File overlap with in-flight work',
    '',
    'This branch changes files that other open PRs / active branches also touch. Coordinate before merging to avoid divergent parallel edits (INT-2388 #3):',
    '',
  ];
  for (const o of overlaps) {
    const shown = o.files.slice(0, 8).map(f => `\`${f}\``).join(', ');
    const more = o.files.length > 8 ? ` (+${o.files.length - 8} more)` : '';
    lines.push(`- **${o.label}** — ${o.files.length} file(s): ${shown}${more}`);
  }
  return lines.join('\n');
}

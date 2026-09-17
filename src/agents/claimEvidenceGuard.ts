// ============================================
// OpenSwarm — numbers and approvals a change asserts must have come from somewhere (AGT-4408)
// ============================================
//
// cgf-portal 2026-09-17: a docs-only PR (#503) replaced verified figures —
// 20,706,700 became 13,955,000, run 13570 became run 132 — with no code
// change and no command in the run that could have produced the new values;
// a code comment (#508) cited "CGF approval reference: <doc>" where the doc's
// last section is "pending approval". A reviewer can only catch these by
// re-deriving every number. Two things ARE mechanical: whether the run's own
// output contains the new number, and whether an approval claim carries a
// citation.

/** A figure worth tracing: two or more digits, optional thousands separators and decimals. Not a date part. */
const FIGURE_RE = /(?<![\d.-])\d[\d,]*(?:\.\d+)?(?![\d-])/g;

function figuresIn(line: string): string[] {
  return (line.match(FIGURE_RE) ?? []).map((n) => n.replace(/,/g, '')).filter((n) => n.replace('.', '').length >= 2);
}

/** The line with its figures blanked, so two versions of "the same line" compare equal. */
function skeleton(line: string): string {
  return line.replace(FIGURE_RE, '#').replace(/\s+/g, ' ').trim();
}

export interface ChangedFigure {
  line: string;
  before: string[];
  after: string[];
}

/**
 * Lines whose figures changed in place: a removed line and an added line with
 * the same skeleton but different numbers. Pure text; no git.
 */
export function figuresChangedInPlace(removedLines: string[], addedLines: string[]): ChangedFigure[] {
  const removedBySkeleton = new Map<string, string[]>();
  for (const line of removedLines) {
    if (figuresIn(line).length === 0) continue;
    const key = skeleton(line);
    removedBySkeleton.set(key, [...(removedBySkeleton.get(key) ?? []), line]);
  }
  const changed: ChangedFigure[] = [];
  for (const added of addedLines) {
    const candidates = removedBySkeleton.get(skeleton(added));
    if (!candidates || candidates.length === 0) continue;
    const removed = candidates.shift()!;
    const before = figuresIn(removed);
    const after = figuresIn(added);
    if (before.join(' ') !== after.join(' ')) changed.push({ line: added.trim(), before, after });
  }
  return changed;
}

/** New figures the worker's own report (summary + tool output) never printed. */
export function unsourcedFigures(changes: ChangedFigure[], reportText: string): Array<ChangedFigure & { missing: string[] }> {
  const normalized = reportText.replace(/,/g, '');
  return changes
    .map((c) => ({ ...c, missing: c.after.filter((n) => !c.before.includes(n) && !normalized.includes(n)) }))
    .filter((c) => c.missing.length > 0);
}

/** An added line that asserts an approval without naming where it came from. */
const APPROVAL_CLAIM_RE = /\b(?:approved(?:\s+by)?|approval(?:\s+reference)?)\b|승인(?:됨|\s*완료|\s*참조|\s*근거)/i;
const APPROVAL_NEGATION_RE = /\b(?:pending|awaiting|needs?|requires?|not|un)\W{0,3}approv|approval\s+(?:pending|required|needed)|승인\s*(?:대기|필요|전|요청)|미승인/i;
// A date inside a file name (`…-INVENTORY-2026-09-15.md`) is not a citation —
// #508's "approval reference" pointed at exactly such a file, whose last
// section was "pending approval".
const CITATION_RE = /https?:\/\/|(?<![\w/-])20\d\d-\d\d-\d\d(?![\w-])|(?:^|\s)#\d{2,}\b/;

export function uncitedApprovalClaims(addedLines: string[]): string[] {
  return addedLines
    .filter((line) => APPROVAL_CLAIM_RE.test(line) && !APPROVAL_NEGATION_RE.test(line) && !CITATION_RE.test(line))
    .map((line) => line.trim());
}

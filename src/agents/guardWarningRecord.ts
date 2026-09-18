/**
 * Making a non-blocking guard warning readable after the run.
 *
 * A blocking guard needs no record: it sends the worker back with the reason in
 * its feedback. A non-blocking one has only its readers, and both designed
 * readers are absent in the daemon. The reviewer receives them
 * (`pairPipeline.ts`, INT-2388) but `defaultRoles.reviewer.enabled` is false,
 * and the `log` event carrying the full text has exactly one subscriber,
 * `cliRunner.ts`, behind a verbose flag the daemon never uses. What reached the
 * daemon's stdout was the guard's own name and nothing else: `bsDetector` fired
 * on three cgf-portal tasks on 2026-09-18 and what it objected to was
 * unrecoverable (AGT-4439).
 */

import type { GuardResult } from './pipelineGuards.js';

/** Issues quoted on the stdout line. The rest are counted, not printed. */
export const GUARD_WARNING_LOG_CAP = 6;
/** Per-issue length on the stdout line; a guard may quote a whole file. */
export const GUARD_WARNING_ISSUE_CHARS = 300;
/** Issues kept per guard in the durable record. */
export const GUARD_WARNING_RECORD_CAP = 40;

export interface GuardWarningRecord {
  guard: string;
  issues: string[];
  /** Issues this guard reported beyond the cap, so a count is never wrong. */
  omitted: number;
}

/** The warnings a run should report: failed, and not blocking. */
export function nonBlockingWarnings(results: readonly GuardResult[] = []): GuardResult[] {
  return results.filter((result) => !result.passed && !result.blocking);
}

function clip(issue: string): string {
  const flat = issue.replace(/\s+/g, ' ').trim();
  return flat.length <= GUARD_WARNING_ISSUE_CHARS ? flat : `${flat.slice(0, GUARD_WARNING_ISSUE_CHARS)}…`;
}

/**
 * The durable form: every warning guard, its issues up to the cap, and how
 * many it had beyond that. Returns an empty array when nothing warned, so a
 * caller can omit the field entirely rather than storing `[]`.
 */
export function guardWarningRecords(results: readonly GuardResult[] = []): GuardWarningRecord[] {
  return nonBlockingWarnings(results).map((result) => ({
    guard: result.guard,
    issues: result.issues.slice(0, GUARD_WARNING_RECORD_CAP).map(clip),
    omitted: Math.max(0, result.issues.length - GUARD_WARNING_RECORD_CAP),
  }));
}

/**
 * The same records for a `PipelineResult`, or `undefined` when nothing warned,
 * so a clean run's durable record stays as it was rather than gaining `[]`.
 */
export function guardWarningsForResult(results: readonly GuardResult[] = []): GuardWarningRecord[] | undefined {
  const records = guardWarningRecords(results);
  return records.length > 0 ? records : undefined;
}

/**
 * The stdout form. Names each guard, how many issues it raised, and the issues
 * themselves up to `GUARD_WARNING_LOG_CAP` — the count is always the real one
 * even when the list is cut, so a truncated line cannot understate the problem.
 * Returns an empty string when nothing warned.
 */
export function formatGuardWarningLine(results: readonly GuardResult[] = []): string {
  const warnings = nonBlockingWarnings(results);
  if (warnings.length === 0) return '';

  const parts = warnings.map((result) => {
    const shown = result.issues.slice(0, GUARD_WARNING_LOG_CAP).map(clip);
    const omitted = result.issues.length - shown.length;
    const tail = omitted > 0 ? ` (+${omitted} more)` : '';
    return `${result.guard} (${result.issues.length}): ${shown.join(' | ')}${tail}`;
  });

  return `Guard warnings: ${parts.join(' || ')}`;
}

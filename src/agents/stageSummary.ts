// ============================================
// OpenSwarm - Stage result summaries for the pipeline event stream
// ============================================

import type { WorkerResult, ReviewResult } from './agentPair.js';
import type { TesterResult } from './tester.js';
import type { DocumenterResult } from './documenter.js';
import type { AuditorResult } from './auditor.js';
import type { SkillDocumenterResult } from './skillDocumenter.js';
import type { PipelineStage } from '../core/types.js';

/**
 * Extract a worker-readable summary of what the agent did during a stage so
 * the dashboard can display "wrote 4 files / approved / reviewed N issues"
 * instead of just "stage=worker status=complete".
 *
 * Returns a plain object suitable for inclusion in the SSE `pipeline:stage`
 * broadcast payload. Fields are optional — missing ones are simply omitted.
 */
export function summarizeStageResult(
  stage: PipelineStage,
  result: WorkerResult | ReviewResult | TesterResult | DocumenterResult | AuditorResult | SkillDocumenterResult,
): Record<string, unknown> {
  // Cap arrays/strings before broadcasting so a chatty agent cannot blow up
  // the SSE channel with a 10MB stage event.
  const MAX_FILES = 12;
  const MAX_COMMANDS = 8;
  const SUMMARY_CAP = 240;
  const FEEDBACK_CAP = 480;
  const cap = (s: string | undefined, n: number): string | undefined =>
    s == null ? undefined : (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  switch (stage) {
    case 'worker': {
      const r = result as WorkerResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.filesChanged) ? r.filesChanged.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.filesChanged?.length ?? 0,
        commands: Array.isArray(r.commands) ? r.commands.slice(0, MAX_COMMANDS) : undefined,
        commandsCount: r.commands?.length ?? 0,
        confidencePercent: r.confidencePercent,
        haltReason: r.haltReason,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'reviewer': {
      const r = result as ReviewResult;
      return {
        decision: r.decision,
        feedback: cap(r.feedback, FEEDBACK_CAP),
        issuesCount: r.issues?.length ?? 0,
        issues: Array.isArray(r.issues) ? r.issues.slice(0, MAX_COMMANDS) : undefined,
        suggestionsCount: r.suggestions?.length ?? 0,
      };
    }

    case 'tester': {
      const r = result as TesterResult;
      return {
        passed: r.testsPassed,
        failed: r.testsFailed,
        coverage: r.coverage,
        failedTests: Array.isArray(r.failedTests) ? r.failedTests.slice(0, MAX_FILES) : undefined,
        deterministic: r.deterministic,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'documenter': {
      const r = result as DocumenterResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.updatedFiles) ? r.updatedFiles.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.updatedFiles?.length ?? 0,
        changelogEntry: cap(r.changelogEntry, SUMMARY_CAP),
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'auditor': {
      const r = result as AuditorResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        bsScore: r.bsScore,
        criticalCount: r.criticalCount,
        warningCount: r.warningCount,
        issues: Array.isArray(r.issues) ? r.issues.slice(0, MAX_COMMANDS) : undefined,
        issuesCount: r.issues?.length ?? 0,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    case 'skill-documenter': {
      const r = result as SkillDocumenterResult;
      return {
        summary: cap(r.summary, SUMMARY_CAP),
        filesChanged: Array.isArray(r.updatedFiles) ? r.updatedFiles.slice(0, MAX_FILES) : undefined,
        filesChangedCount: r.updatedFiles?.length ?? 0,
        error: r.error ? cap(r.error, FEEDBACK_CAP) : undefined,
      };
    }

    default:
      return {};
  }
}

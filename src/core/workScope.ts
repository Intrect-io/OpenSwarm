// Created: 2026-11-15
// Purpose: the autonomous work scope (AGT-3188) the daemon is running with, readable by the dashboard and TUI
// Dependencies: none
// Test Status: workScope.test.ts

/**
 * What the daemon may pick from: a Linear project milestone, or (null) every issue in the allowed projects.
 *
 * The milestone is matched by name across every allowed project. If two allowed projects each have a
 * milestone with that name, issues from both are in scope; that is accepted rather than an error.
 *
 * Known limit: narrowing the scope (or switching milestones) does not release In Progress issues the
 * daemon claimed under the earlier scope. The scoped fetch no longer returns them, so the stalled
 * In Progress reconciler (AutonomousRunner.reconcileStalledInProgress) never sees them either; they
 * stay In Progress until a person moves them or the scope is widened again.
 */
export interface WorkScope {
  milestone: string | null;
  /**
   * False when the last successful scoped fetch returned no open issues in any state, which usually
   * means the milestone name is wrong, renamed, archived or completed. Undefined until a scoped
   * fetch has run, and always undefined without a milestone.
   */
  matched?: boolean;
}

let current: WorkScope = { milestone: null };
/** Milestones already warned about, so an idle daemon logs once per scope rather than every heartbeat. */
const warnedUnmatched = new Set<string>();

/** Set once at service start from `autonomous.scope`. */
export function setWorkScope(scope: { milestone?: string } | undefined): WorkScope {
  current = { milestone: scope?.milestone?.trim() || null };
  return current;
}

export function getWorkScope(): WorkScope {
  return current;
}

/**
 * Record the outcome of a successful scoped fetch. A failed fetch must not be recorded: it says
 * nothing about whether the milestone matches.
 */
export function recordScopedFetch(milestone: string | null | undefined, issueCount: number, warn: (message: string) => void = console.warn): void {
  if (!milestone || milestone !== current.milestone) return;
  const matched = issueCount > 0;
  current = { ...current, matched };
  if (matched || warnedUnmatched.has(milestone)) return;
  warnedUnmatched.add(milestone);
  warn(`[WorkScope] Milestone "${milestone}" matched no open issues in the allowed projects; the daemon will pick nothing. Check the name, or whether it was renamed, archived or completed.`);
}

/** One line a person reads to know what the work queue is. */
export function describeWorkScope(scope: WorkScope | null | undefined): string {
  return scope?.milestone
    ? `milestone "${scope.milestone}" only`
    : 'all issues in the allowed projects';
}

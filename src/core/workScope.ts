// Created: 2026-11-15
// Purpose: the autonomous work scope (AGT-3188) the daemon is running with, readable by the dashboard and TUI
// Dependencies: none
// Test Status: workScope.test.ts

/** What the daemon may pick from: a Linear project milestone, or (null) every issue in the allowed projects. */
export interface WorkScope {
  milestone: string | null;
}

let current: WorkScope = { milestone: null };

/** Set once at service start from `autonomous.scope`. */
export function setWorkScope(scope: { milestone?: string } | undefined): WorkScope {
  current = { milestone: scope?.milestone?.trim() || null };
  return current;
}

export function getWorkScope(): WorkScope {
  return current;
}

/** One line a person reads to know what the work queue is. */
export function describeWorkScope(scope: WorkScope | null | undefined): string {
  return scope?.milestone
    ? `milestone "${scope.milestone}" only`
    : 'all issues in the allowed projects';
}

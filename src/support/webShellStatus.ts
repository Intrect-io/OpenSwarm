// The four facts every dashboard page states in its status line: is the
// daemon reachable (the client knows that from this call succeeding), is it
// running and if not why, which provider the fleet defaults to, and what is
// waiting on the operator.
//
// One endpoint so every page states the same facts. The design review
// (2026-10-19) found the Supervisor saying "All issues healthy" beside a feed
// of failures and two pages disagreeing about how many agents were placed —
// each panel computed its own number from its own source. This one reads only
// in-process state (coordination board, run ledger, runner config), never a
// tracker API, so polling it from every open page stays cheap.

import type { CoordinationEvent } from '../coordination/coordinationStore.js';

export type DaemonState = 'running' | 'stopped' | 'dashboard-only';

export interface ShellStatus {
  daemon: { state: DaemonState; reason: string | null; uptimeMs: number | null };
  provider: { adapter: string; model: string | null } | null;
  needsYou: { questions: number; parked: number; total: number };
  generatedAt: number;
}

/** The slice of AutonomousRunner this reads; kept narrow so tests need no daemon. */
export interface ShellStatusRunner {
  getStats(): { isRunning?: boolean; automationLedger?: { byState?: Record<string, number> } | null };
  getState(): { startedAt?: number | null };
  getAdapterSummary(): Promise<{ defaultAdapter: string; worker?: { model?: string | null } }>;
}

export async function buildShellStatus(deps: {
  runner?: ShellStatusRunner;
  pendingEvents: () => readonly CoordinationEvent[];
  now?: () => number;
}): Promise<ShellStatus> {
  const now = deps.now?.() ?? Date.now();
  // A human question is the one pending exchange that waits on the operator;
  // the board holds it until a human-answer or an expiry settles it.
  const questions = deps.pendingEvents().filter((event) => event.kind === 'human-question').length;

  if (!deps.runner) {
    return {
      daemon: { state: 'dashboard-only', reason: 'No daemon runner is attached to this dashboard', uptimeMs: null },
      provider: null,
      needsYou: { questions, parked: 0, total: questions },
      generatedAt: now,
    };
  }

  const stats = deps.runner.getStats();
  const startedAt = deps.runner.getState().startedAt ?? null;
  const summary = await deps.runner.getAdapterSummary().catch(() => null);
  // NEEDS_HUMAN is the run ledger's operator park: the run will not move
  // until someone resolves it, which is exactly "needs you".
  const parked = stats.automationLedger?.byState?.NEEDS_HUMAN ?? 0;
  const running = stats.isRunning === true;
  return {
    daemon: {
      state: running ? 'running' : 'stopped',
      reason: running ? null : 'The autonomous loop is not running',
      uptimeMs: running && startedAt ? Math.max(0, now - startedAt) : null,
    },
    provider: summary ? { adapter: summary.defaultAdapter, model: summary.worker?.model ?? null } : null,
    needsYou: { questions, parked, total: questions + parked },
    generatedAt: now,
  };
}

import { safeConsole as console } from '../support/safeLog.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { DurableRunCoordinator } from './durableRunCoordinator.js';
import type { RunRecord } from './runLedger.js';
import {
  TRACKER_RECONCILABLE_STATES,
  type TrackerTerminalState,
} from './runLedgerTrackerCache.js';
import type { ITaskSource, TrackerIssueLookup } from './taskSource.js';

export interface TrackerTerminalReconcileOptions {
  durableRuns: DurableRunCoordinator;
  source: ITaskSource | null;
  /** States already returned by the bulk fetch; these satisfy open-state checks without another API call. */
  knownTasks?: readonly TaskItem[];
  inScope?: (projectPath: string) => boolean;
  now?: number;
  staleAfterMs?: number;
  recheckAfterMs?: number;
  errorRecheckAfterMs?: number;
  maxLookups?: number;
}

export interface TrackerTerminalReconcileResult {
  eligible: number;
  lookedUp: number;
  fromFetch: number;
  cached: number;
  terminal: number;
  failed: number;
}

function terminalState(lookup: TrackerIssueLookup): TrackerTerminalState | undefined {
  if (!lookup.ok || !lookup.issue) return undefined;
  const type = lookup.issue.stateType?.trim().toLowerCase();
  if (type === 'completed') return 'DONE';
  if (type === 'canceled' || type === 'cancelled') return 'CANCELLED';

  // Local trackers and older Linear responses may not expose workflow-state
  // type. Keep the fallback deliberately narrow so a custom open state cannot
  // be closed by a fuzzy name match.
  const name = lookup.issue.state.trim().toLowerCase();
  if (name === 'done' || name === 'completed') return 'DONE';
  if (name === 'canceled' || name === 'cancelled' || name === 'duplicate') return 'CANCELLED';
  return undefined;
}

function dueForLookup(
  run: RunRecord,
  now: number,
  staleAfterMs: number,
  recheckAfterMs: number,
  errorRecheckAfterMs: number,
): boolean {
  if (now - run.updatedAt < staleAfterMs) return false;
  if (run.trackerCheckedAt == null) return true;
  const interval = run.trackerState === 'lookup_error' ? errorRecheckAfterMs : recheckAfterMs;
  return now - run.trackerCheckedAt >= interval;
}

/**
 * Reconcile stale ledger rows from a bounded, durable tracker cache.
 *
 * Terminal issues disappear from the normal slim fetch, so this is the only
 * explicit per-issue read. Results are written back to automation_runs before
 * the next heartbeat; open issues therefore cost at most one lookup per cache
 * interval, while transient failures retry sooner. No row is deleted.
 */
export async function reconcileTrackerTerminalRuns(
  options: TrackerTerminalReconcileOptions,
): Promise<TrackerTerminalReconcileResult> {
  const result: TrackerTerminalReconcileResult = {
    eligible: 0, lookedUp: 0, fromFetch: 0, cached: 0, terminal: 0, failed: 0,
  };
  const { durableRuns, source } = options;
  if (!durableRuns.isPrimary || !source) return result;

  const now = options.now ?? Date.now();
  const staleAfterMs = options.staleAfterMs ?? 60 * 60_000;
  const recheckAfterMs = options.recheckAfterMs ?? 6 * 60 * 60_000;
  const errorRecheckAfterMs = options.errorRecheckAfterMs ?? 15 * 60_000;
  const maxLookups = Math.max(1, Math.floor(options.maxLookups ?? 20));
  const candidates = durableRuns.listRuns(TRACKER_RECONCILABLE_STATES)
    .filter((run) => run.source === source.kind)
    .filter((run) => !run.ownerInstanceId && !run.leaseToken)
    .filter((run) => options.inScope?.(run.projectPath) ?? true)
    .filter((run) => dueForLookup(run, now, staleAfterMs, recheckAfterMs, errorRecheckAfterMs))
    .sort((a, b) => a.updatedAt - b.updatedAt);
  result.eligible = candidates.length;
  const knownTasks = new Map<string, TaskItem>();
  for (const task of options.knownTasks ?? []) {
    knownTasks.set(task.issueId ?? task.id, task);
    if (task.issueIdentifier) knownTasks.set(task.issueIdentifier, task);
  }

  for (const run of candidates) {
    const key = run.source === 'linear' ? (run.identifier ?? run.issueId) : run.issueId;
    let lookup: TrackerIssueLookup;
    const known = knownTasks.get(run.issueId) ?? knownTasks.get(key);
    if (known?.linearState) {
      lookup = { ok: true, issue: { state: known.linearState } };
      result.fromFetch++;
    } else {
      if (result.lookedUp >= maxLookups) continue;
      try {
        lookup = await source.lookupIssueState(key);
      } catch (error) {
        lookup = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      result.lookedUp++;
    }
    if (!lookup.ok) {
      result.failed++;
      if (durableRuns.cacheTrackerObservation(run, { lookupError: true }, undefined, now)) result.cached++;
      console.warn(`[TrackerReconciler] Lookup failed for ${run.identifier ?? run.issueId}; cached for bounded retry`);
      continue;
    }

    const observation = lookup.issue
      ? { state: lookup.issue.state, stateType: lookup.issue.stateType }
      : {};
    const terminal = terminalState(lookup);
    if (durableRuns.cacheTrackerObservation(run, observation, terminal, now)) {
      result.cached++;
      if (terminal) result.terminal++;
    }
  }
  return result;
}

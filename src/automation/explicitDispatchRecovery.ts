import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { RunRecord } from './runLedgerTypes.js';

const RESUMABLE_TRACKER_STATES = new Set(['todo', 'backlog', 'in progress']);

export interface ExplicitDeferredRecovery {
  run: RunRecord;
  task: TaskItem;
  projectPath: string;
  retryAt: number;
}

function metadataMarksExplicitDispatch(metadata: unknown): boolean {
  return metadata != null
    && typeof metadata === 'object'
    && !Array.isArray(metadata)
    && (metadata as { explicitDispatch?: unknown }).explicitDispatch === true;
}

/**
 * Only a durable admission deferral represents scheduler-owned work that was
 * lost with the in-memory queue. Other RETRY_AT reasons have their own wake-up
 * contracts and must not be pulled forward by restart recovery.
 */
export function isExplicitAdmissionRetry(
  run: RunRecord,
  inScope?: (projectPath: string) => boolean,
): boolean {
  return run.state === 'RETRY_AT'
    && run.lastErrorCode === 'claim_deferred'
    && run.retryAt != null
    && Number.isFinite(run.retryAt)
    && run.ownerInstanceId == null
    && run.leaseToken == null
    && metadataMarksExplicitDispatch(run.metadata)
    && (inScope == null || inScope(run.projectPath));
}

/**
 * Join durable intent to the current tracker snapshot. The tracker is the
 * authority for whether the card is still executable; the ledger is the
 * authority for its repository and retry deadline.
 */
export function planExplicitDeferredRecovery(
  runs: readonly RunRecord[],
  trackerTasks: readonly TaskItem[],
  inScope?: (projectPath: string) => boolean,
): ExplicitDeferredRecovery[] {
  const taskByIssueId = new Map<string, TaskItem>();
  for (const task of trackerTasks) {
    taskByIssueId.set(task.issueId || task.id, task);
  }

  const planned: ExplicitDeferredRecovery[] = [];
  for (const run of runs) {
    if (!isExplicitAdmissionRetry(run, inScope)) continue;
    const trackerTask = taskByIssueId.get(run.issueId);
    if (!trackerTask) continue;
    const trackerState = (trackerTask.linearState ?? '').trim().toLowerCase();
    if (!RESUMABLE_TRACKER_STATES.has(trackerState)) continue;

    planned.push({
      run,
      projectPath: run.projectPath,
      retryAt: run.retryAt!,
      task: {
        ...trackerTask,
        id: run.issueId,
        issueId: run.issueId,
        issueIdentifier: trackerTask.issueIdentifier ?? run.identifier,
        projectPath: run.projectPath,
        explicitDispatch: true,
      },
    });
  }
  return planned;
}

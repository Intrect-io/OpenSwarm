// ============================================
// OpenSwarm - Results the durable coordinator returns without running a task
// ============================================
//
// Moved out of durableRunCoordinator.ts (AGT-4808) so the coordinator can gain
// the kill-switch gate without growing past the repository's file-size ceiling.

import type { PipelineResult } from '../agents/pairPipeline.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

/** A run that was admitted to the coordinator but not executed: deferred to a deadline, or superseded. */
export function nonExecutingResult(
  task: TaskItem,
  projectPath: string,
  reason: string,
  disposition: { status: 'deferred'; retryAt: number } | { status: 'superseded' },
): PipelineResult {
  return {
    success: false,
    sessionId: `durable-admission-${Date.now()}`,
    stages: [],
    finalStatus: disposition.status,
    retryAt: disposition.status === 'deferred' ? disposition.retryAt : undefined,
    totalDuration: 0,
    iterations: 0,
    taskContext: {
      issueIdentifier: task.issueIdentifier || task.issueId,
      projectName: task.linearProject?.name,
      projectPath,
      taskTitle: `${task.title} (${reason})`,
    },
  };
}

/** A result from an owner whose lease was replaced: never committed as its own outcome. */
export function fencedResult(result: PipelineResult): PipelineResult {
  return {
    ...result,
    success: false,
    finalStatus: 'infra_error',
    failureDetail: 'durable completion: lease fence rejected result from an expired or replaced owner',
    failureSignal: result.failureSignal ?? 'timeout',
  };
}

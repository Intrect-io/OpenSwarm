// ============================================
// OpenSwarm - Pipeline presence on the coordination board (AGT-4013)
// ============================================
//
// Who is deployed on a run, and what they are doing. Split out of pairPipeline
// so the pipeline keeps to its own job and stays under the module size cap.

import type { PipelineContext } from './pairPipelineTypes.js';
import { assignCallSign, type AgentRole } from '../coordination/agentNames.js';
import { taskEventKey } from '../orchestration/decisionEngine.js';

/**
 * Roles that appear on the coordination board as deployed agents.
 *
 * Board presence used to depend on an agent choosing to call a coordination
 * tool, so a worker that simply did its job never appeared and the
 * orchestration view showed only the daemon. Publishing the stage lifecycle
 * makes deployment observable without relying on optional tool use.
 */
const BOARD_STAGES: ReadonlySet<string> = new Set(['worker', 'reviewer']);

/** Stable per-attempt id so a stage's start and result join into one exchange. */
export function stageCorrelationId(context: PipelineContext, stage: string): string {
  return `stage:${context.session.id}:${stage}:${context.currentIteration}`;
}

/** The board identity an agent publishes under, shared with its MCP tools. */
export function coordinationContextFor(context: PipelineContext, role: AgentRole) {
  const taskId = taskEventKey(context.task);
  const callSign = assignCallSign({ repository: context.projectPath, executionId: taskId, role });
  return {
    repository: context.projectPath,
    taskId,
    taskLabel: context.task.issueIdentifier,
    actor: callSign.address,
    actorName: callSign.name,
    actorRole: role,
  };
}

/**
 * Record a stage on the coordination board so the orchestration view shows
 * which agents are deployed and what they are doing.
 *
 * Best-effort by design: the board is an observation surface, and a failure to
 * record must never fail the stage it describes.
 */
export async function publishStageToBoard(
  context: PipelineContext,
  stage: string,
  status: 'running' | 'completed' | 'failed',
  summary: string,
  model?: string,
): Promise<void> {
  if (!BOARD_STAGES.has(stage)) return;
  try {
    const actor = coordinationContextFor(context, stage as AgentRole);
    const { publishCoordination } = await import('../coordination/runCoordination.js');
    await publishCoordination({
      ...actor,
      // The daemon delegates the stage and the agent reports back, which is
      // exactly what these two kinds mean elsewhere on the board.
      kind: status === 'running' ? 'delegation-request' : 'delegation-result',
      status,
      correlationId: stageCorrelationId(context, stage),
      summary: `${stage}: ${summary}`,
      metadata: model ? { model, iteration: context.currentIteration } : { iteration: context.currentIteration },
    });
  } catch {
    // Observation only — never let it break the run.
  }
}

// ============================================
// OpenSwarm - Run-scoped coordination preparation
// ============================================
//
// Everything the daemon resolves once per pipeline run before agents start:
// the frozen instruction capsule and the role-filtered MCP grants, each
// mirrored to the coordination board for the dashboard. Extracted from
// runnerExecution.ts, which is execution orchestration — this is the
// coordination plane's edge of it.

import type { CoordinationStore } from './coordinationStore.js';
import type { InstructionCapsule } from '../agents/instructionCapsule.js';
import type { ToolDefinition } from '../adapters/tools.js';
import type { RoleMcpPolicy } from './mcpPolicy.js';
import type { AdapterRoutePolicy } from './routingPolicy.js';
import type { AutonomousConfig } from '../automation/runnerTypes.js';

/** Config-shaped routing (optional primary) → the worker's strict policy shape. */
export function normalizeAdapterRouting(
  routing: AutonomousConfig['adapterRouting'],
): AdapterRoutePolicy | undefined {
  if (!routing) return undefined;
  return { primary: routing.primary ?? 'codex', fallbacks: routing.fallbacks, allowReasons: routing.allowReasons };
}

/**
 * Coordination visibility is observability, not execution truth: a store write
 * that fails must be logged, never allowed to abort the pipeline.
 */
export async function publishCoordination(
  event: Parameters<CoordinationStore['publish']>[0],
): Promise<void> {
  try {
    const { getCoordinationStore } = await import('./coordinationStore.js');
    await getCoordinationStore().publish(event);
  } catch (error) {
    console.warn('[Coordination] publish failed:', error instanceof Error ? error.message : String(error));
  }
}

export interface RunCoordinationSetup {
  instructionCapsule: InstructionCapsule;
  roleMcpTools: { worker: ToolDefinition[]; reviewer: ToolDefinition[] };
}

/**
 * Resolve the per-run instruction capsule and role MCP grants, and record both
 * on the board.
 *
 * The capsule is snapshotted once so every role in the run reads the same rules
 * even if a file changes mid-run; a capsule that cannot be built is reported,
 * never silently replaced with no rules. Each denied MCP tool is published so
 * the dashboard shows what a role asked the policy for and did not get.
 */
export async function prepareRunCoordination(input: {
  repository: string;
  repoKey?: string;
  taskId: string;
  /** Issue identifier for `taskId`, so board events name the issue, not a UUID. */
  taskLabel?: string;
  /** Where the run actually executes (a worktree), which the capsule resolves from. */
  executionPath: string;
  relevantFiles: string[];
  policies?: { worker?: RoleMcpPolicy; reviewer?: RoleMcpPolicy };
}): Promise<RunCoordinationSetup> {
  const daemonActor = { actor: 'openswarm-daemon', actorName: 'OpenSwarm daemon', actorRole: 'daemon' } as const;
  const instructionCapsule = (await import('../agents/instructionCapsule.js')).buildInstructionCapsule(
    input.executionPath,
    input.relevantFiles,
  );
  await publishCoordination({
    repository: input.repository,
    repoKey: input.repoKey,
    taskId: input.taskId,
    taskLabel: input.taskLabel,
    sourceTaskId: input.taskId,
    sourceTaskLabel: input.taskLabel,
    targetTaskId: input.taskId,
    targetTaskLabel: input.taskLabel,
    ...daemonActor,
    kind: 'instruction-snapshot',
    status: instructionCapsule.errors.length > 0 ? 'failed' : 'completed',
    summary: `Claude Code rules ${instructionCapsule.digest.slice(0, 12)} (${instructionCapsule.sources.length} sources)`,
    metadata: { digest: instructionCapsule.digest, sourceCount: instructionCapsule.sources.length, errorCount: instructionCapsule.errors.length },
  });

  const discovered = await (await import('../mcp/mcpClient.js')).getMcpTools();
  const { filterMcpToolsForRole } = await import('./mcpPolicy.js');
  const worker = filterMcpToolsForRole(discovered, input.policies?.worker);
  const reviewer = filterMcpToolsForRole(discovered, input.policies?.reviewer);
  for (const denied of [...worker.denied, ...reviewer.denied]) {
    await publishCoordination({
      repository: input.repository,
      repoKey: input.repoKey,
      taskId: input.taskId,
      taskLabel: input.taskLabel,
      sourceTaskId: input.taskId,
      sourceTaskLabel: input.taskLabel,
      targetTaskId: input.taskId,
      targetTaskLabel: input.taskLabel,
      ...daemonActor,
      kind: 'mcp-audit',
      status: 'completed',
      summary: `Denied MCP tool ${denied.name}: ${denied.reason}`,
    });
  }

  return { instructionCapsule, roleMcpTools: { worker: worker.tools, reviewer: reviewer.tools } };
}

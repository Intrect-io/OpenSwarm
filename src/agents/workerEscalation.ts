// ============================================
// OpenSwarm - Worker escalation policy
// ============================================
//
// Two escalation triggers share this module:
// - iteration-count: config `worker.escalateAfterIteration` (default 2) with
//   `worker.escalateModel` — every iteration at/past the threshold runs the
//   escalated model.
// - repeated-review-feedback signal (INT-2475): the reviewer said the same
//   thing twice, proving the current tier can't absorb the feedback; escalate
//   ONCE (higher model and/or effort bump) before giving up on the session.

import type { RoleConfig } from '../core/types.js';
import { broadcastEvent } from '../core/eventHub.js';
import { safeConsole } from '../support/safeLog.js';

export type WorkerReasoningEffort = 'low' | 'medium' | 'high';

export interface WorkerStageOverrides {
  model?: string;
  reasoningEffort?: WorkerReasoningEffort;
}

/**
 * Compute the worker stage overrides for the upcoming iteration: base model,
 * iteration-count escalation, then the one-shot signal escalation on top
 * (it takes precedence — the reviewer demonstrated the lower tier failed).
 * Emits the iteration-escalation event/log exactly like the old inline block.
 */
export function resolveWorkerStageOverrides(input: {
  workerCfg: RoleConfig | undefined;
  iteration: number;
  baseModel: string | undefined;
  signalEscalation: WorkerStageOverrides | undefined;
  taskId: string;
  taskPrefix: string;
}): WorkerStageOverrides | undefined {
  const { workerCfg, iteration, baseModel, signalEscalation } = input;
  const escalateThreshold = workerCfg?.escalateAfterIteration ?? 2;
  const escalateModel = workerCfg?.escalateModel;
  const shouldEscalate = iteration >= escalateThreshold && !!escalateModel;

  let overrides: WorkerStageOverrides | undefined = shouldEscalate
    ? { model: escalateModel }
    : (baseModel ? { model: baseModel } : undefined);

  if (shouldEscalate && escalateModel) {
    safeConsole.log(`[${input.taskPrefix}] Escalating worker model → ${escalateModel} (iteration ${iteration})`);
    broadcastEvent({ type: 'pipeline:escalation', data: {
      taskId: input.taskId,
      iteration,
      fromModel: workerCfg?.model,
      toModel: escalateModel,
    } });
  }

  if (signalEscalation) {
    overrides = { ...overrides, ...signalEscalation };
  }
  return overrides;
}

/**
 * What is left to escalate to when the reviewer repeats itself (INT-2475):
 * a configured higher worker model and/or a reasoning-effort bump to 'high'.
 *
 * The model comparison is against the model the NEXT iteration would use
 * anyway: when the iteration-count escalation is already in effect,
 * re-targeting the same escalateModel is a no-op — only the effort bump would
 * add anything, and if that's spent too the caller aborts instead of burning
 * an iteration on an escalation that changes nothing.
 *
 * Returns undefined when no meaningful escalation remains.
 */
export function buildRepeatEscalation(input: {
  workerCfg: RoleConfig | undefined;
  currentIteration: number;
  currentModel: string | undefined;
  currentEffort: WorkerReasoningEffort | undefined;
}): WorkerStageOverrides | undefined {
  const { workerCfg, currentIteration, currentModel, currentEffort } = input;
  const nextIteration = currentIteration + 1;
  const iterationEscalated =
    !!workerCfg?.escalateModel && nextIteration >= (workerCfg?.escalateAfterIteration ?? 2);
  const effectiveNextModel = iterationEscalated ? workerCfg!.escalateModel : currentModel;
  const model = workerCfg?.escalateModel && workerCfg.escalateModel !== effectiveNextModel
    ? workerCfg.escalateModel
    : undefined;
  const reasoningEffort = currentEffort !== 'high' ? 'high' as const : undefined;
  if (!model && !reasoningEffort) return undefined;
  return { model, reasoningEffort };
}

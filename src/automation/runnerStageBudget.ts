// ============================================
// OpenSwarm — which stages an autonomous run enables, and what they may cost
// ============================================
//
// Split out of runnerExecution.ts, which sits at the 1500-line cap.

import { stageTimeoutMs } from '../agents/stageTimeouts.js';
import type { DefaultRolesConfig, PipelineStage, VerifyConfig } from '../core/types.js';

/**
 * Per-iteration wall clock of the enabled stages other than the worker — the
 * rest of what one iteration can cost, for the shared task budget (AGT-4430).
 */
export function otherStageTimeoutsMs(roles?: DefaultRolesConfig, verify?: VerifyConfig): number {
  return getEnabledStages(roles, verify)
    .filter((stage): stage is Exclude<PipelineStage, 'worker'> => stage !== 'worker')
    .reduce((total, stage) => total + stageTimeoutMs(stage, roles?.[stage]?.timeoutMs), 0);
}

export function getEnabledStages(roles?: DefaultRolesConfig, verify?: VerifyConfig): PipelineStage[] {
  const stages: PipelineStage[] = [];
  if (roles?.worker?.enabled !== false) stages.push('worker');
  if (roles?.reviewer?.enabled !== false) stages.push('reviewer');
  if (roles?.tester?.enabled || verify?.enabled) stages.push('tester');
  if (roles?.documenter?.enabled) stages.push('documenter');
  return stages;
}

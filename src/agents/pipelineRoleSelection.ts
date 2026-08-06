import type { AdapterName } from '../adapters/types.js';
import { mapModelForProvider } from '../adapters/modelCompat.js';
import type { JobProfile, PipelineStage } from '../core/types.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PipelineConfig } from './pairPipelineTypes.js';

function matchesProfile(task: TaskItem, profile: JobProfile): boolean {
  const estimate = task.estimatedMinutes ?? 0;
  if (profile.minMinutes != null && estimate < profile.minMinutes) return false;
  if (profile.maxMinutes != null && estimate > profile.maxMinutes) return false;
  if (profile.priority != null && task.priority !== profile.priority) return false;
  return true;
}

function profileForTask(config: PipelineConfig, task: TaskItem): JobProfile | undefined {
  return config.jobProfiles?.find(profile => matchesProfile(task, profile));
}

/** Keep provider/model compatibility checks at every stage-selection boundary. */
export function compatibleStageModel(
  config: PipelineConfig,
  stage: PipelineStage,
  model: string | undefined,
): string | undefined {
  const adapter = config.roles?.[stage]?.adapter;
  return adapter ? mapModelForProvider(adapter as AdapterName, model) : model;
}

export function modelForTask(config: PipelineConfig, stage: PipelineStage, task: TaskItem): string | undefined {
  const profile = profileForTask(config, task);
  return compatibleStageModel(config, stage, profile?.roles?.[stage])
    ?? compatibleStageModel(config, stage, config.roles?.[stage]?.model);
}

export function effortForTask(config: PipelineConfig, task: TaskItem): 'low' | 'medium' | 'high' | undefined {
  return profileForTask(config, task)?.effort;
}

// ============================================
// OpenSwarm - Scheduler priority-council bridge (AGT-4132)
// ============================================

import type { TaskItem } from './decisionEngine.js';
import { loadRepoMetadata } from '../support/repoMetadata.js';
import { repositoryKey } from '../coordination/repositoryCell.js';
import {
  applyAdvisoryPriorityRanking,
  consumePriorityCouncilRanking,
  listPriorityCouncilRankingCandidates,
  priorityCouncilSchedulingSnapshotVersion,
  type PriorityCouncil,
  type PriorityCouncilOption,
} from '../coordination/priorityCouncil.js';

export interface PriorityCouncilRankingAccess {
  list(repositories: readonly string[], taskIds: readonly string[]): PriorityCouncil[];
  consume(input: Parameters<typeof consumePriorityCouncilRanking>[0]): ReturnType<typeof consumePriorityCouncilRanking>;
}

export interface AppliedPriorityCouncilRanking {
  tasks: TaskItem[];
  applied: boolean;
  councilId?: string;
  reason: 'applied' | 'none' | 'manual-only' | 'stale-snapshot' | 'cas-rejected' | 'cohort-mismatch';
}

const DEFAULT_ACCESS: PriorityCouncilRankingAccess = {
  list: (repositories, taskIds) => listPriorityCouncilRankingCandidates(repositories, taskIds),
  consume: (input) => consumePriorityCouncilRanking(input),
};

function taskId(task: TaskItem): string {
  return task.issueId || task.id;
}

function currentOption(
  option: PriorityCouncilOption,
  task: TaskItem,
  downstream: ReadonlyMap<string, number>,
): PriorityCouncilOption {
  return {
    ...option,
    schedulingFacts: {
      priority: task.priority,
      downstreamCount: downstream.get(taskId(task)) ?? 0,
      blockedBy: [...new Set(task.blockedBy ?? [])].sort((a, b) => a.localeCompare(b)),
      ...(task.topoRank === undefined ? {} : { topoRank: task.topoRank }),
      ...(task.dueDate === undefined ? {} : { dueDate: task.dueDate }),
      ...(task.linearState === undefined ? {} : { linearState: task.linearState }),
    },
  };
}

/** Resolve task ids only through explicit repository paths or openswarm.json. */
export async function resolvePriorityCouncilRepositoryScopes(
  tasks: readonly TaskItem[],
  allowedProjects: readonly string[],
): Promise<Map<string, string>> {
  const byProjectId = new Map<string, string>();
  const ambiguousProjectIds = new Set<string>();
  await Promise.all([...new Set(allowedProjects)].map(async (projectPath) => {
    try {
      const metadata = await loadRepoMetadata(projectPath);
      const projectId = metadata?.linear?.projectId;
      if (!projectId) return;
      const repoKey = repositoryKey(undefined, projectPath);
      const previous = byProjectId.get(projectId);
      if (previous && previous !== repoKey) {
        ambiguousProjectIds.add(projectId);
        byProjectId.delete(projectId);
      } else if (!ambiguousProjectIds.has(projectId)) {
        byProjectId.set(projectId, repoKey);
      }
    } catch {
      // Missing/unreadable metadata means no automatic council authority.
    }
  }));

  const scopes = new Map<string, string>();
  for (const task of tasks) {
    const scope = task.projectPath
      ? repositoryKey(undefined, task.projectPath)
      : task.linearProject?.id ? byProjectId.get(task.linearProject.id) : undefined;
    if (scope) scopes.set(taskId(task), scope);
  }
  return scopes;
}

/**
 * Apply at most one newest durable decision to the already eligible/sorted
 * cohort. No tracker call occurs here. Any missing facts, stale state, CAS
 * rejection, partial cohort, or malformed authority returns the baseline byte
 * for byte; normal readiness/dependency/lease checks retain full authority.
 */
export function applyDurablePriorityCouncilRanking(
  eligibleTasks: readonly TaskItem[],
  baseline: readonly TaskItem[],
  downstream: ReadonlyMap<string, number>,
  repositoryByTaskId: ReadonlyMap<string, string>,
  access: PriorityCouncilRankingAccess = DEFAULT_ACCESS,
): AppliedPriorityCouncilRanking {
  const original = [...baseline];
  if (eligibleTasks.length < 2 || baseline.length < 2) {
    return { tasks: original, applied: false, reason: 'none' };
  }
  const byId = new Map<string, TaskItem>();
  for (const task of eligibleTasks) {
    const key = taskId(task);
    if (byId.has(key)) return { tasks: original, applied: false, reason: 'cohort-mismatch' };
    byId.set(key, task);
  }
  let council: PriorityCouncil | undefined;
  try {
    council = access.list([...new Set(repositoryByTaskId.values())], [...byId.keys()])[0];
  } catch {
    return { tasks: original, applied: false, reason: 'none' };
  }
  if (!council) return { tasks: original, applied: false, reason: 'none' };

  // Linear issue ids are globally scoped. A local tracker must first provide a
  // repository-scoped task identity before it can safely use cross-repo lookup.
  const cohort = council.options.map((option) => byId.get(option.taskId));
  if (council.options.some((option, index) => {
    const task = cohort[index];
    return !task
      || task.source !== 'linear'
      || task.issueId !== option.taskId
      || repositoryByTaskId.get(option.taskId) !== council.repository;
  })) {
    return { tasks: original, applied: false, councilId: council.id, reason: 'cohort-mismatch' };
  }
  if (council.options.some((option) => option.schedulingFacts === undefined)) {
    return { tasks: original, applied: false, councilId: council.id, reason: 'manual-only' };
  }
  const currentOptions = council.options.map((option, index) =>
    currentOption(option, cohort[index]!, downstream));
  let currentVersion: string | undefined;
  try {
    currentVersion = priorityCouncilSchedulingSnapshotVersion(currentOptions);
  } catch {
    return { tasks: original, applied: false, councilId: council.id, reason: 'stale-snapshot' };
  }
  if (!currentVersion || currentVersion !== council.snapshotVersion) {
    return { tasks: original, applied: false, councilId: council.id, reason: 'stale-snapshot' };
  }

  let signal: ReturnType<typeof consumePriorityCouncilRanking>['signal'];
  try {
    signal = access.consume({
      repository: council.repository,
      councilId: council.id,
      expectedCouncilVersion: council.version,
      currentSnapshotVersion: currentVersion,
      consumer: 'autonomous-scheduler',
      consumerTaskId: 'decision-engine',
      consumerRole: 'scheduler',
    }).signal;
  } catch {
    return { tasks: original, applied: false, councilId: council.id, reason: 'cas-rejected' };
  }
  const applied = applyAdvisoryPriorityRanking(original, signal, taskId);
  if (!applied.applied) {
    return { tasks: original, applied: false, councilId: council.id, reason: 'cohort-mismatch' };
  }
  return { tasks: applied.tasks, applied: true, councilId: council.id, reason: 'applied' };
}

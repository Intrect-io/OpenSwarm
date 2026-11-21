// Created: 2026-10-22
// Purpose: decide whether the daemon may start work on an issue at all, before anything is claimed (AGT-4784)
// Dependencies: agentEligibility (label rule), decisionEngine (state rule)
// Test Status: readinessGate.test.ts

import { isActionableLinearState } from '../orchestration/decisionEngine.js';
import { isScopeDeclined, type DraftScopeVerdict } from '../agents/draftScope.js';
import { humanOwnedReason } from './agentEligibility.js';
import { resolveOwningProject } from '../support/projectGoal.js';

// On 2026-10-20 the daemon opened sessions on 52 cgf-portal issues in one night. Nine carried the
// label that marks them out of the paid scope, four said in their own title that a decision was
// pending, one was a production deploy, and the Backlog was treated as a queue. Each rule that would
// have stopped them already existed somewhere (R5's "Backlog is parked", the skip labels of AGT-4682,
// the draft's scope verdict of AGT-4662); none of them ran in front of the claim, and the default
// switched the Backlog rule off. This is the one place that asks the three questions in order.

export type ReadinessTask = {
  issueIdentifier?: string;
  id?: string;
  linearState?: string;
  labels?: readonly string[];
  title: string;
  hasChildren?: boolean;
  /** The operator chose this issue by hand: choosing it is the decision. */
  explicitDispatch?: boolean;
};

export interface ReadinessOptions {
  /** Labels that mark work outside what the daemon may do for this project. */
  exclusionLabels?: readonly string[];
  /**
   * The owning project's own exclusion labels (`projectAgents[].skipLabels`), merged with
   * `exclusionLabels`. Async because owning a task can take a path lookup, so the async partitions
   * resolve it (`resolveProjectExclusionLabels`) and hand the sync gate `exclusionLabelsFor`.
   */
  projectExclusionLabels?: (task: ReadinessTask) => Promise<readonly string[]>;
  /** Per-task extra exclusion labels, already resolved. */
  exclusionLabelsFor?: (task: ReadinessTask) => readonly string[] | undefined;
  /**
   * A grooming verdict for the issue, when one exists. `actionable` clears it; anything else
   * (`human_action_only`, `decision_pending`, ...) blocks. Injected so the gate is tested for
   * *consulting* it before the claim, not for the model that produced it.
   */
  verdict?: string;
  /** Opt in to treating the Backlog as a queue. Default off: moving an issue to Todo is the "ready" signal. */
  includeBacklog?: boolean;
}

export interface ReadinessDecision {
  claim: boolean;
  /** Why not (`state:Backlog`, `label:x`, `verdict:decision_pending`), or `ready`. */
  reason: string;
}

/**
 * Whether the daemon may claim this issue. Order is cheapest first and each answer is final:
 * the tracker state, then a person's exclusion label, then the grooming verdict.
 *
 * Todo is the dispatch state. In Progress and In Review pass: the daemon resumes its own runs
 * there and cannot tell them from a person's work without the ledger, so they keep today's
 * behaviour. An unknown state also passes (`isActionableLinearState` — "don't gate on a guess").
 */
export function evaluateReadiness(task: ReadinessTask, options: ReadinessOptions = {}): ReadinessDecision {
  if (task.explicitDispatch) return { claim: true, reason: 'explicit_dispatch' };

  if (!isActionableLinearState(task.linearState, options.includeBacklog === true)) {
    return { claim: false, reason: `state:${task.linearState}` };
  }

  const labelReason = humanOwnedReason(
    { title: task.title, labels: [...(task.labels ?? [])], hasChildren: false },
    { labels: [...(options.exclusionLabels ?? []), ...(options.exclusionLabelsFor?.(task) ?? [])], titleTags: [], epics: false },
  );
  if (labelReason) return { claim: false, reason: labelReason };

  if (options.verdict !== undefined && options.verdict !== 'actionable') {
    return { claim: false, reason: `verdict:${options.verdict}` };
  }
  return { claim: true, reason: 'ready' };
}

export interface ReadinessPartition<T> {
  ready: T[];
  /** Held issue keys grouped by reason, for one aggregated log line per reason. */
  held: Map<string, string[]>;
}

export function partitionByReadiness<T extends ReadinessTask>(
  tasks: readonly T[],
  options: ReadinessOptions = {},
): ReadinessPartition<T> {
  const ready: T[] = [];
  const held = new Map<string, string[]>();
  for (const task of tasks) {
    const decision = evaluateReadiness(task, options);
    if (decision.claim) {
      ready.push(task);
      continue;
    }
    const keys = held.get(decision.reason) ?? [];
    keys.push(task.issueIdentifier ?? task.id ?? '?');
    held.set(decision.reason, keys);
  }
  return { ready, held };
}

/** One line per reason: `not ready (state:Backlog) 3: AX-1, AX-2, AX-3`. */
export function formatReadinessSummary(held: ReadonlyMap<string, string[]>, maxListed = 8): string[] {
  return [...held.entries()].map(([reason, keys]) => {
    const shown = keys.slice(0, maxListed).join(', ');
    const more = keys.length > maxListed ? ` +${keys.length - maxListed} more` : '';
    return `  ⏭ not ready (${reason}) ${keys.length}: ${shown}${more}`;
  });
}

/**
 * The verdict a draft analysis carries, in the gate's vocabulary, for a project with a standing goal:
 * the declined scope kind, or undefined when the draft says nothing against the issue. Only a
 * confident, evidenced verdict counts (`isScopeDeclined`). The pre-claim hold asks every project
 * for a verdict and reads it through `draftScopeVerdict` (preClaimHold.ts) instead (AGT-4784).
 */
export function verdictFromDraft(
  draft: { scope?: DraftScopeVerdict } | undefined,
  projectHasGoal: boolean,
): string | undefined {
  if (!projectHasGoal || !draft) return undefined;
  return isScopeDeclined(draft.scope) ? draft.scope.kind : undefined;
}

type ProjectSkipLike = { projectPath: string; linearProjectId?: string; skipLabels?: string[] };
type OwnedTask = ReadinessTask & { projectPath?: string; linearProject?: { id: string } };

const normLabel = (label: string) => label.trim().toLowerCase();

/**
 * The per-project exclusion labels hook (`projectAgents[].skipLabels`), or undefined when no project
 * sets any. A fetched Linear task carries no `projectPath`, so the owning project is found by its
 * `linearProjectId` first and then by the runner's own path resolution, as `definitionOfReadyHooks` does.
 */
export function projectSkipLabelsHook<T extends OwnedTask>(
  projectAgents: ReadonlyArray<ProjectSkipLike> | undefined,
  resolveProjectPath?: (task: T) => Promise<string | null | undefined>,
): ((task: ReadinessTask) => Promise<readonly string[]>) | undefined {
  if (!projectAgents?.some((agent) => agent.skipLabels?.length)) return undefined;
  const listed = new Set(projectAgents.flatMap((agent) => agent.skipLabels ?? []).map(normLabel));
  return async (readinessTask) => {
    const task = readinessTask as T;
    // Owning a task can read openswarm.json per project: only look when one of its labels is listed somewhere.
    if (!(task.labels ?? []).some((label) => listed.has(normLabel(label)))) return [];
    const byLinearId = task.linearProject?.id
      ? projectAgents.find((agent) => agent.linearProjectId === task.linearProject?.id)
      : undefined;
    if (byLinearId) return byLinearId.skipLabels ?? [];
    const path = task.projectPath ?? (await resolveProjectPath?.(task).catch(() => null)) ?? '';
    return path ? resolveOwningProject(projectAgents, path)?.skipLabels ?? [] : [];
  };
}

/** Resolve `projectExclusionLabels` once per task into the sync `exclusionLabelsFor` the gate reads. */
export async function resolveProjectExclusionLabels<T extends ReadinessTask>(
  tasks: readonly T[],
  options: ReadinessOptions,
): Promise<ReadinessOptions> {
  const hook = options.projectExclusionLabels;
  if (!hook) return options;
  const byTask = new Map<ReadinessTask, readonly string[]>();
  for (const task of tasks) byTask.set(task, await hook(task));
  return { ...options, exclusionLabelsFor: (task) => [...(options.exclusionLabelsFor?.(task) ?? []), ...(byTask.get(task) ?? [])] };
}


/**
 * Issue ids (`issueId || id`) of the tasks carrying a global exclusion label or their owning
 * project's, for the sweeps that move issues after the claim (stalled In Progress, merged
 * publications). A project lookup that throws counts as excluded: fail closed (AGT-4784).
 */
export async function exclusionLabelledIds<T extends ReadinessTask & { issueId?: string }>(
  tasks: readonly T[],
  exclusionLabels: readonly string[] | undefined,
  projectExclusionLabels?: (task: ReadinessTask) => Promise<readonly string[]>,
): Promise<ReadonlySet<string>> {
  const global = new Set((exclusionLabels ?? []).map(normLabel).filter(Boolean));
  const excluded = new Set<string>();
  for (const task of tasks) {
    const issueId = task.issueId || task.id;
    const labels = (task.labels ?? []).map(normLabel).filter(Boolean);
    if (!issueId || labels.length === 0) continue;
    if (labels.some((label) => global.has(label))) {
      excluded.add(issueId);
      continue;
    }
    if (!projectExclusionLabels) continue;
    let projectLabels: Set<string>;
    try {
      projectLabels = new Set((await projectExclusionLabels(task)).map(normLabel).filter(Boolean));
    } catch {
      excluded.add(issueId);
      continue;
    }
    if (labels.some((label) => projectLabels.has(label))) excluded.add(issueId);
  }
  return excluded;
}

/** Global exclusion labels plus the skipLabels of the project owning `projectPath`, for grooming. */
export function exclusionLabelsForProject(
  globalLabels: readonly string[] | undefined,
  projectAgents: ReadonlyArray<ProjectSkipLike> | undefined,
  projectPath: string | undefined,
): string[] {
  const owner = projectPath ? resolveOwningProject(projectAgents, projectPath) : undefined;
  return [...(globalLabels ?? []), ...(owner?.skipLabels ?? [])];
}

/** The sweeps' exclusion check in one call: global skip labels plus each task's project skipLabels (AGT-4784). */
export async function exclusionCheck<T extends ReadinessTask & { issueId?: string }>(
  tasks: readonly T[],
  skip: { labels?: readonly string[] } | undefined,
  projectAgents: ReadonlyArray<ProjectSkipLike> | undefined,
  resolveProjectPath?: (task: T) => Promise<string | null | undefined>,
): Promise<(issueId: string) => boolean> {
  const excluded = await exclusionLabelledIds(tasks, skip?.labels, projectSkipLabelsHook(projectAgents, resolveProjectPath));
  return (issueId) => excluded.has(issueId);
}

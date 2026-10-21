// Created: 2026-10-22
// Purpose: decide whether the daemon may start work on an issue at all, before anything is claimed (AGT-4784)
// Dependencies: agentEligibility (label rule), decisionEngine (state rule)
// Test Status: readinessGate.test.ts

import { isActionableLinearState } from '../orchestration/decisionEngine.js';
import { isScopeDeclined, type DraftScopeVerdict } from '../agents/draftScope.js';
import { humanOwnedReason } from './agentEligibility.js';

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
    { labels: [...(options.exclusionLabels ?? [])], titleTags: [], epics: false },
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
 * The verdict a draft analysis carries, in the gate's vocabulary: the declined scope kind, or
 * undefined when the draft says nothing against the issue. Only a project with a standing goal
 * asks the drafter for a scope verdict (`scopePromptParts`), and only a confident, evidenced one
 * counts (`isScopeDeclined`) — without both, nothing here can block.
 */
export function verdictFromDraft(
  draft: { scope?: DraftScopeVerdict } | undefined,
  projectHasGoal: boolean,
): string | undefined {
  if (!projectHasGoal || !draft) return undefined;
  return isScopeDeclined(draft.scope) ? draft.scope.kind : undefined;
}

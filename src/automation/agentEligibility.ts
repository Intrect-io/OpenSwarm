// Created: 2026-10-04
// Purpose: decide which tracker issues are not the swarm agent's work, so the heartbeat never picks them (AGT-4682)
// Dependencies: none
// Test Status: agentEligibility.test.ts

import type { TaskItem } from '../orchestration/decisionEngine.js';

/**
 * What a person, not the swarm, has to do. An issue is skipped when any rule matches:
 * a label (external decisions, an explicit opt-out), an epic (it only groups other issues),
 * or a title tag (`[인수]`, `[Docs]`, ...).
 */
export interface AgentSkipConfig {
  labels: string[];
  titleTags: string[];
  epics: boolean;
}

/**
 * `[UAT]` is not here on purpose: cgf-portal's `[UAT]` issues are mostly defect reports the
 * daemon fixes with real pull requests. It stays configurable for a project where it means
 * a hand-run acceptance step. `[EPIC]` is not here either: the decision engine's umbrella
 * rule (R2) already drops a title-tagged epic, and `epics` below adds the ones that only
 * show up as an issue with sub-issues.
 */
export const DEFAULT_AGENT_SKIP: AgentSkipConfig = {
  labels: ['swarm:skip'],
  titleTags: ['인수', '확인 원장', 'Docs'],
  epics: true,
};

type EligibilityTask = Pick<TaskItem, 'title' | 'labels' | 'hasChildren' | 'explicitDispatch'>;

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `[tag]`, `[tag][other]`, `[tag: x]`, `[tag/x]` — the tag opens a bracket group of the title. */
function hasTitleTag(title: string, tag: string): boolean {
  return new RegExp(`\\[\\s*${escapeForRegExp(tag.trim())}\\s*(?:[\\]:/·-]|$)`, 'i').test(title);
}

/**
 * Why a person owns this issue, or null when the swarm may take it. A task the operator
 * dispatched by hand is never skipped: choosing it is the decision.
 */
export function humanOwnedReason(task: EligibilityTask, config: AgentSkipConfig = DEFAULT_AGENT_SKIP): string | null {
  if (task.explicitDispatch) return null;
  const labels = new Set((task.labels ?? []).map((label) => label.trim().toLowerCase()));
  for (const label of config.labels) {
    if (labels.has(label.trim().toLowerCase())) return `label:${label}`;
  }
  if (config.epics && task.hasChildren) return 'epic';
  for (const tag of config.titleTags) {
    if (tag.trim() && hasTitleTag(task.title, tag)) return `tag:${tag}`;
  }
  return null;
}

export interface EligibilityPartition<T extends EligibilityTask> {
  eligible: T[];
  /** Skipped issue keys grouped by reason, for one aggregated log line per reason. */
  skipped: Map<string, string[]>;
}

export function partitionHumanOwned<T extends EligibilityTask & { issueIdentifier?: string; id: string }>(
  tasks: readonly T[],
  config: AgentSkipConfig = DEFAULT_AGENT_SKIP,
): EligibilityPartition<T> {
  const eligible: T[] = [];
  const skipped = new Map<string, string[]>();
  for (const task of tasks) {
    const reason = humanOwnedReason(task, config);
    if (!reason) {
      eligible.push(task);
      continue;
    }
    const keys = skipped.get(reason) ?? [];
    keys.push(task.issueIdentifier ?? task.id);
    skipped.set(reason, keys);
  }
  return { eligible, skipped };
}

/** One line per reason: `not agent work (label:swarm:skip): AX-1, AX-2`. */
export function formatSkipSummary(skipped: ReadonlyMap<string, string[]>, maxListed = 8): string[] {
  return [...skipped.entries()].map(([reason, keys]) => {
    const shown = keys.slice(0, maxListed).join(', ');
    const more = keys.length > maxListed ? ` +${keys.length - maxListed} more` : '';
    return `  ⏭ not agent work (${reason}) ${keys.length}: ${shown}${more}`;
  });
}

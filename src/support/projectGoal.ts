// Created: 2026-10-03
// Purpose: per-project standing goal — resolve it from config and format the one block every stage prompt carries (AGT-4662)
// Dependencies: node:os, node:path

import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';

/** Upper bound on a configured goal; a goal is direction, not a spec document. */
export const MAX_PROJECT_GOAL_CHARS = 4000;

interface GoalBearingProject {
  projectPath: string;
  goal?: string;
}

function projectRoot(path: string): string {
  const expanded = path === '~' || path.startsWith('~/') ? homedir() + path.slice(1) : path;
  const resolved = resolve(expanded);
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

/**
 * The goal configured for the project that owns `projectPath`, or undefined.
 *
 * `projectPath` may be a task worktree nested under the project (the pipeline
 * runs in `<project>/worktree/<id>`), so a project owns every path beneath it.
 * When projects nest, the most specific one wins. A project without a goal does
 * not fall through to an enclosing project's goal: that would hand a repo the
 * direction written for its parent.
 */
export function resolveProjectGoal(
  agents: ReadonlyArray<GoalBearingProject> | undefined,
  projectPath: string,
): string | undefined {
  if (!agents?.length) return undefined;
  const target = projectRoot(projectPath);
  let owner: GoalBearingProject | undefined;
  let ownerRoot = '';
  for (const agent of agents) {
    const root = projectRoot(agent.projectPath);
    const owns = target === root || target.startsWith(root + sep);
    if (owns && root.length >= ownerRoot.length) {
      owner = agent;
      ownerRoot = root;
    }
  }
  const goal = owner?.goal?.trim();
  if (!goal) return undefined;
  return goal.length > MAX_PROJECT_GOAL_CHARS ? `${goal.slice(0, MAX_PROJECT_GOAL_CHARS)}…` : goal;
}

/**
 * The block the draft, worker, reviewer and planner prompts all carry, so every
 * stage reads the same words. Empty when there is no goal: a project that sets
 * none must get byte-identical prompts to before this existed.
 */
export function formatProjectGoalSection(goal: string | undefined): string {
  const text = goal?.trim();
  if (!text) return '';
  return '\n\n## Standing project goal\n'
    + 'The operator set this goal for every task in this project. It is binding direction for what to build, '
    + 'in what order, and how far to take it. The task text still defines the specific change; if the two '
    + 'seem to pull apart, serve the goal and say so.\n\n'
    + `${text}\n`;
}

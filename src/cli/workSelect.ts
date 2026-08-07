// ============================================
// OpenSwarm - `openswarm work` issue selection (INT-3387)
// ============================================
//
// Pure helpers for the interactive issue picker: filter the team-wide Linear
// fetch down to this repo's project, format one checkbox row per issue, and
// run the multi-select prompt. The prompt itself is injectable so tests never
// need a TTY.

import type { LinearIssueInfo } from '../core/types.js';
import { truncateLine } from './reviewProgress.js';

/** States the picker offers for deployment. `In Progress` resumes preserved work. */
export const WORK_SELECTABLE_STATES = ['Todo', 'Backlog', 'In Progress'] as const;

/**
 * States a directly-addressed issue is refused in: completed or under review
 * work must not be silently redone, and a cancelled issue is not work at all.
 */
export const WORK_SKIP_STATES = ['Done', 'In Review', 'Canceled', 'Cancelled'] as const;

/**
 * Keep only this repo's actionable issues, ordered by priority (Linear's 0 =
 * "no priority" sorts last, mirroring linear.ts) then by identifier.
 */
export function filterRepoIssues(issues: LinearIssueInfo[], projectId: string): LinearIssueInfo[] {
  return issues
    .filter((issue) => issue.project?.id === projectId)
    .filter((issue) => (WORK_SELECTABLE_STATES as readonly string[]).includes(issue.state))
    .sort((a, b) => {
      const pa = a.priority === 0 ? 999 : a.priority;
      const pb = b.priority === 0 ? 999 : b.priority;
      if (pa !== pb) return pa - pb;
      return a.identifier.localeCompare(b.identifier, undefined, { numeric: true });
    });
}

/** One checkbox row: `[INT-123] P1 Title — Todo`, truncated to a column budget. */
export function formatIssueChoice(issue: LinearIssueInfo, width = 100): string {
  const priority = issue.priority > 0 ? `P${issue.priority} ` : '';
  return truncateLine(`[${issue.identifier}] ${priority}${issue.title} — ${issue.state}`, width);
}

export interface SelectIssuesDeps {
  /** Multi-select prompt returning the chosen issue ids (default: @inquirer/prompts checkbox). */
  prompt?: (options: {
    message: string;
    choices: Array<{ name: string; value: string }>;
    pageSize?: number;
  }) => Promise<string[]>;
}

/**
 * Interactive multi-select over the filtered issues. Throws @inquirer's
 * ExitPromptError on Ctrl-C — the caller treats it as a quiet exit.
 */
export async function selectIssuesInteractive(
  issues: LinearIssueInfo[],
  deps: SelectIssuesDeps = {},
): Promise<LinearIssueInfo[]> {
  const prompt = deps.prompt ?? (async (options) => {
    const { checkbox } = await import('@inquirer/prompts');
    return checkbox<string>(options);
  });
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  const pickedIds = await prompt({
    message: 'Select issues to deploy agents on:',
    choices: issues.map((issue) => ({ name: formatIssueChoice(issue), value: issue.id })),
    pageSize: 15,
  });
  return pickedIds
    .map((id) => byId.get(id))
    .filter((issue): issue is LinearIssueInfo => !!issue);
}

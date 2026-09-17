// ============================================
// OpenSwarm — Done means merged (AGT-4409)
// ============================================
//
// cgf-portal 2026-09-17: issues went to Done the moment their PR was opened —
// 42 minutes before a human merged one, and while others sat REVISE/REJECT
// or were later closed. A person reverted fifteen. The publication now moves
// the issue to In Review, and this sweep moves it on: merged → Done; closed
// without merging → Backlog, with the reason on the card. An issue whose
// description still has unchecked boxes stays In Review after the merge, once
// told so — the operator's completion criteria are theirs to tick.
import type { TaskItem } from '../orchestration/decisionEngine.js';
import type { PRLifecycle } from '../github/github.js';

export interface MergedPublicationCandidate {
  task: TaskItem;
  prUrl: string;
}

export interface MergedPublicationContext {
  /** The PR this daemon published for the issue, if any. */
  publishedPrUrl: (issueId: string) => string | undefined;
  /** Still queued or running here — its state is in motion, leave it. */
  isSchedulerOwned: (issueId: string) => boolean;
  /** Bound the gh calls per sweep. */
  limit?: number;
}

/** In Review issues whose PR this daemon published — the only ones it may move. */
export function planMergedPublicationChecks(
  tasks: readonly TaskItem[],
  context: MergedPublicationContext,
): MergedPublicationCandidate[] {
  const limit = context.limit ?? 20;
  const candidates: MergedPublicationCandidate[] = [];
  for (const task of tasks) {
    if (candidates.length >= limit) break;
    if (task.linearState !== 'In Review') continue;
    const issueId = task.issueId || task.id;
    if (context.isSchedulerOwned(issueId)) continue;
    const prUrl = context.publishedPrUrl(issueId);
    if (!prUrl) continue;
    candidates.push({ task, prUrl });
  }
  return candidates;
}

/** `- [ ]` boxes in the description: the operator's completion criteria, unticked. */
export function uncheckedCriteria(description: string | undefined): number {
  if (!description) return 0;
  return (description.match(/^\s*[-*]\s+\[ \]/gm) ?? []).length;
}

export type MergedPublicationDecision =
  | { action: 'done'; comment: string }
  | { action: 'await-criteria'; marker: string; comment: string }
  | { action: 'backlog'; comment: string }
  | { action: 'none' };

export function decideMergedPublication(pr: PRLifecycle, prUrl: string, description: string | undefined): MergedPublicationDecision {
  if (pr.state === 'MERGED') {
    const unchecked = uncheckedCriteria(description);
    const merged = `${prUrl} merged${pr.mergedAt ? ` at ${pr.mergedAt}` : ''}${pr.mergeCommitOid ? ` (${pr.mergeCommitOid.slice(0, 7)})` : ''}`;
    if (unchecked > 0) {
      return {
        action: 'await-criteria',
        marker: `merged-await-criteria:${pr.repo}#${pr.number}`,
        comment: `🧭 **[OpenSwarm] PR merged, completion criteria open**\n\n${merged}. ${unchecked} unchecked box(es) remain in this issue's description, so it stays In Review — tick them (or move the issue) when the criteria are met.`,
      };
    }
    return { action: 'done', comment: `🧭 **[OpenSwarm] Done — pull request merged**\n\n${merged}.` };
  }
  if (pr.state === 'CLOSED') {
    return {
      action: 'backlog',
      comment: `🧭 **[OpenSwarm] Pull request closed without merging**\n\n${prUrl} was closed. The issue goes back to Backlog; reopen it as Todo to have the work redone, or close it if the change is no longer wanted.`,
    };
  }
  return { action: 'none' };
}

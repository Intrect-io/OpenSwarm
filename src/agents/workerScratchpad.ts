/**
 * Which scratchpad a worker writes to, and how its notes come back.
 *
 * Kept out of pairPipeline.ts so the composition has somewhere to grow: that
 * file sits ten lines under the 1500-line ceiling the pre-commit hook enforces.
 */
import { renderNotesForPrompt, scratchpadEnabled } from '../support/scratchpad.js';
import { taskAttributionKey } from '../orchestration/decisionEngine.js';
import type { TaskItem } from '../orchestration/decisionEngine.js';

type ScratchpadTask = Pick<TaskItem, 'id' | 'issueId' | 'issueIdentifier'>;

/**
 * Keyed by the task, not the attempt.
 *
 * A note is worth keeping precisely because the next try should not repeat the
 * work that produced it, and "the next try" is often a whole new attempt hours
 * later — AX-1556 reached attempt 7. The same key as the cost ledger uses, so
 * a person reading one can find the other (AGT-4445).
 */
export function workerScratchpadRunId(task: ScratchpadTask): string | undefined {
  return scratchpadEnabled() ? taskAttributionKey(task) : undefined;
}

/**
 * The agent's own notes, as a feedback section.
 *
 * This goes in ahead of the reviewer's feedback on purpose: the notes are the
 * frame the agent reads everything else in, and a reviewer's demand is easier
 * to judge against what you already established than the other way round.
 */
export async function scratchNotesSection(task: ScratchpadTask): Promise<string | undefined> {
  const runId = workerScratchpadRunId(task);
  return runId ? renderNotesForPrompt(runId) : undefined;
}

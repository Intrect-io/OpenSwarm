// ============================================
// OpenSwarm - Durable authoritative operator guidance
// ============================================

import { getCoordinationStore } from './coordinationStore.js';
import type { ResolvedHumanAnswer } from './coordinationTrace.js';

const MAX_PROMPT_DECISIONS = 20;

export function formatAuthoritativeOperatorFeedback(
  answers: readonly ResolvedHumanAnswer[],
): string | undefined {
  // Automated advisor answers are advice, not operator decisions, and this
  // text is injected as authoritative operator feedback. An agent that needs
  // the advice again gets it from `ask_human`, marked as automated (AGT-4516).
  const decisions = answers.filter((entry) => entry.answeredByRole !== 'advisor');
  if (decisions.length === 0) return undefined;
  const selected = decisions.slice(-MAX_PROMPT_DECISIONS);
  const lines: string[] = [];
  if (decisions.length > selected.length) {
    lines.push(`[${decisions.length - selected.length} older resolved decisions omitted; newest ${selected.length} shown]`, '');
  }
  selected.forEach((entry, index) => {
    lines.push(`Decision ${index + 1}:`);
    for (const question of entry.questions) lines.push(`Question: ${question}`);
    lines.push(`Operator answer: ${entry.answer}`);
    lines.push(`Correlation IDs: ${entry.correlationIds.join(', ')}`);
    if (index < selected.length - 1) lines.push('');
  });
  return lines.join('\n');
}

/** Reload on every execution so retries and daemon restarts cannot use stale issue text. */
export function loadAuthoritativeOperatorFeedback(taskId: string): string | undefined {
  return formatAuthoritativeOperatorFeedback(
    getCoordinationStore().resolvedHumanAnswers(taskId),
  );
}

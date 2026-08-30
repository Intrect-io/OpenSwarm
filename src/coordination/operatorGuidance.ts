// ============================================
// OpenSwarm - Durable authoritative operator guidance
// ============================================

import { getCoordinationStore } from './coordinationStore.js';
import type { ResolvedHumanAnswer } from './coordinationTrace.js';

const MAX_PROMPT_DECISIONS = 20;

export function formatAuthoritativeOperatorFeedback(
  answers: readonly ResolvedHumanAnswer[],
): string | undefined {
  if (answers.length === 0) return undefined;
  const selected = answers.slice(-MAX_PROMPT_DECISIONS);
  const lines: string[] = [];
  if (answers.length > selected.length) {
    lines.push(`[${answers.length - selected.length} older resolved decisions omitted; newest ${selected.length} shown]`, '');
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

// ============================================
// OpenSwarm - Discord chat history prompt budget (AGT-3435)
// ============================================

/**
 * Hard budget, in characters, for the past-history part of a chat prompt.
 * HISTORY_LIMIT caps the entry count, but each entry carries a full response,
 * so 30 long replies could still push the prompt past the model's context.
 * The newest entries win; an entry that alone exceeds the budget is clipped.
 */
export const HISTORY_CONTEXT_CHAR_BUDGET = 24_000;
const HISTORY_ENTRY_CLIPPED_SUFFIX = ' …[clipped]';
const HISTORY_SEPARATOR = '\n\n';

/**
 * Keep the newest formatted entries whose joined length fits `budget`.
 * When even the newest entry is too long it is clipped rather than dropped,
 * so the model still sees the last exchange.
 */
export function fitHistoryToBudget(formatted: string[], budget: number): string {
  if (budget <= 0 || formatted.length === 0) return '';
  const kept: string[] = [];
  let used = 0;
  for (let i = formatted.length - 1; i >= 0; i--) {
    const entry = formatted[i];
    const cost = entry.length + (kept.length > 0 ? HISTORY_SEPARATOR.length : 0);
    if (used + cost <= budget) {
      kept.push(entry);
      used += cost;
      continue;
    }
    if (kept.length === 0) {
      const room = Math.max(0, budget - HISTORY_ENTRY_CLIPPED_SUFFIX.length);
      kept.push(`${entry.slice(0, room)}${HISTORY_ENTRY_CLIPPED_SUFFIX}`.slice(0, budget));
    }
    break;
  }
  return kept.reverse().join(HISTORY_SEPARATOR);
}

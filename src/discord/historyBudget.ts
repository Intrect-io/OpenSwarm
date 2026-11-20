// ============================================
// OpenSwarm - Discord chat history prompt budget (AGT-3435)
// ============================================

/**
 * Hard budget for the past-history part of a chat prompt. It counts
 * characters (UTF-16 code units, i.e. `String.length`), not model tokens:
 * a cheap, tokenizer-free upper bound that keeps the prompt well inside the
 * context window for any language.
 * HISTORY_LIMIT caps the entry count, but each entry carries a full response,
 * so 30 long replies could still push the prompt past the model's context.
 * The newest entries win; an entry that alone exceeds the budget is clipped.
 */
export const HISTORY_CONTEXT_CHAR_BUDGET = 24_000;
const HISTORY_ENTRY_CLIPPED_SUFFIX = ' …[clipped]';
const HISTORY_SEPARATOR = '\n\n';

const GRAPHEME_SEGMENTER = typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;
/** How far back from the cut to look for a grapheme boundary (longest ZWJ sequences fit easily). */
const GRAPHEME_LOOKBACK = 64;

/**
 * The longest prefix of `text` of at most `maxUnits` UTF-16 units that ends on
 * a grapheme boundary, so a surrogate pair or a ZWJ emoji sequence is never
 * split. Only a short window before the cut is segmented, not the whole entry.
 */
function clipAtGrapheme(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  if (maxUnits <= 0) return '';
  const from = Math.max(0, maxUnits - GRAPHEME_LOOKBACK);
  let end = from;
  if (GRAPHEME_SEGMENTER) {
    // Segment one unit past the cut so a grapheme that straddles it is seen whole.
    for (const { index, segment } of GRAPHEME_SEGMENTER.segment(text.slice(from, maxUnits + GRAPHEME_LOOKBACK))) {
      if (from + index + segment.length > maxUnits) break;
      end = from + index + segment.length;
    }
  } else {
    end = maxUnits;
  }
  // Never end on a lone high surrogate (no segmenter, or a degenerate window).
  const code = text.charCodeAt(end - 1);
  if (end > 0 && code >= 0xd800 && code <= 0xdbff) end -= 1;
  return text.slice(0, end);
}

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
      const clipped = room > 0 ? `${clipAtGrapheme(entry, room)}${HISTORY_ENTRY_CLIPPED_SUFFIX}` : '';
      kept.push(clipped.length <= budget ? clipped : clipAtGrapheme(clipped, budget));
    }
    break;
  }
  return kept.reverse().join(HISTORY_SEPARATOR);
}

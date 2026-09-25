// ============================================
// OpenSwarm — aggregate budget for the data sections of an assembled prompt (AGT-4151)
// ============================================
//
// Every untrusted item that goes into a worker prompt is capped on its own
// (`MAX_PROMPT_DATA_CHARS` in the locale files), and every collection is capped
// at `MAX_PROMPT_COLLECTION_ITEMS`. Neither bounds the prompt: a run carrying
// registry briefs, repo memories, sibling work and a long DoD composes them
// without a ceiling, and a prompt big enough to crowd out its own instructions
// degrades the run instead of failing it. This module is the ceiling. The
// locale files build the prompt as named sections and hand them here; what
// comes back fits the budget, and says so when something was withheld.

/**
 * Character budget for the data sections of one worker prompt — everything
 * between the `# Worker Agent` heading and the static rules. Measured on the
 * deployed daemon (usage ledger, 2026-09-15..17, first worker call per task):
 * whole initial prompts run 40k–63k tokens including the system prompt and the
 * instruction capsule, so this leaves ordinary runs untouched and binds only
 * when a collection explodes.
 */
export const WORKER_PROMPT_BUDGET_CHARS = 120_000;

/** Space kept back for the notice that tells the model what was withheld. */
const NOTICE_RESERVE_CHARS = 1_000;

export interface PromptSection {
  /** Stable name, used in the eviction order and in the notice. */
  id: string;
  text: string;
  /**
   * Whether the whole section may be dropped when the budget binds. Binding
   * material (the task itself, operator decisions, the edit boundary, the
   * DoD) is not evictable; it is only ever truncated, and only after every
   * evictable section is gone.
   */
  evictable: boolean;
}

export interface BudgetedPrompt {
  /** The surviving sections in their original order, notice included. */
  text: string;
  /** Ids of sections dropped whole, in the order they were dropped. */
  dropped: string[];
  /** Ids of non-evictable sections cut short, in the order they were cut. */
  truncated: string[];
}

export interface FitOptions {
  /**
   * Which evictable sections go first when the budget binds — most
   * disposable first. A section absent from this list is never dropped whole
   * even if it says `evictable`.
   */
  evictionOrder: readonly string[];
  budget?: number;
  /** Renders the withheld-context notice; called only when something was. */
  notice: (dropped: readonly string[], truncated: readonly string[]) => string;
  /** Marker appended to a truncated section so the cut is visible in place. */
  truncationMarker: string;
}

function joinSections(sections: readonly PromptSection[]): string {
  return sections.map((section) => section.text).join('\n');
}

/**
 * Fit the sections to the budget.
 *
 * Deterministic, in this order: (1) if everything fits, nothing changes and no
 * notice is added; (2) evictable sections are dropped whole, most disposable
 * first, until the rest plus the notice fit; (3) if the non-evictable material
 * alone still exceeds the budget, sections are cut from the LAST one backwards
 * — the prompt template puts the task and operator decisions first, so what
 * gets cut is the tail (DoD list, edit boundary) rather than the task itself.
 * The returned text never exceeds the budget.
 */
export function fitPromptSections(sections: readonly PromptSection[], options: FitOptions): BudgetedPrompt {
  const budget = options.budget ?? WORKER_PROMPT_BUDGET_CHARS;
  const kept = sections.filter((section) => section.text.length > 0);
  const size = (): number => joinSections(kept).length;
  if (size() <= budget) return { text: joinSections(kept), dropped: [], truncated: [] };

  const dropped: string[] = [];
  const truncated: string[] = [];
  const room = budget - NOTICE_RESERVE_CHARS;
  for (const id of options.evictionOrder) {
    if (size() <= room) break;
    const index = kept.findIndex((section) => section.id === id && section.evictable);
    if (index < 0) continue;
    kept.splice(index, 1);
    dropped.push(id);
  }

  for (let index = kept.length - 1; index >= 0 && size() > room; index -= 1) {
    const section = kept[index];
    const excess = size() - room;
    const keep = Math.max(0, section.text.length - excess - options.truncationMarker.length);
    kept[index] = { ...section, text: `${section.text.slice(0, keep)}${options.truncationMarker}` };
    truncated.push(section.id);
  }

  let notice = options.notice(dropped, truncated);
  if (notice.length > NOTICE_RESERVE_CHARS) notice = notice.slice(0, NOTICE_RESERVE_CHARS);
  const text = `${joinSections(kept)}\n${notice}`;
  return { text: text.slice(0, budget), dropped, truncated };
}

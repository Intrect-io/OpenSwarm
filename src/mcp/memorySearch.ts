// Created: 2026-11-15
// Purpose: search_memory request handling for the memory MCP server, with a deadline and a concurrency cap (AGT-4875)
// Dependencies: zod
// Test Status: memorySearch.test.ts

import { z } from 'zod';

export const SearchArgumentsSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

/** Wall-clock ceiling for a single search — hung embeddings must not pin the MCP process. */
export const SEARCH_TIMEOUT_MS = 60_000;

/**
 * At most this many searches run at once. Each one loads embeddings and scans the
 * repo's memory, so a burst of calls from one agent used to fan out without bound.
 */
export const MAX_CONCURRENT_SEARCHES = 2;

// A type alias (not an interface) so it satisfies the MCP SDK result index signature.
export type MemorySearchResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: true;
};

export interface MemorySearchHandlerOptions {
  /**
   * Runs one search. The signal aborts when the call hits its deadline or the MCP
   * request is cancelled; a search that cannot be cancelled may ignore it.
   */
  search: (cwd: string, query: string, limit: number, signal: AbortSignal) => Promise<string>;
  cwd: () => string;
  timeoutMs?: number;
  maxConcurrent?: number;
  /**
   * Ceiling on running plus orphaned searches (an orphan is one that hit its
   * deadline or was cancelled but has not settled yet). Default: 2x maxConcurrent.
   */
  hardCap?: number;
}

/**
 * Build the search_memory handler.
 *
 * Over-limit policy: a call that finds every slot taken is rejected at once with a
 * "busy" tool error instead of waiting. Waiting would need its own queue bound and
 * timeout, and a CLI agent handles a tool error by retrying or moving on, which is
 * the cheaper outcome for a recall hint.
 *
 * A slot is returned when the call finishes, fails, hits its deadline or its request
 * is aborted. After a deadline or abort the underlying search may keep running in
 * the background, so it is counted as orphaned until it settles; new calls are
 * rejected busy while running + orphaned reaches the hard cap, so hung searches
 * cannot pile up real work without bound.
 */
export function createMemorySearchHandler(options: MemorySearchHandlerOptions) {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_CONCURRENT_SEARCHES);
  const hardCap = Math.max(maxConcurrent, options.hardCap ?? maxConcurrent * 2);
  let active = 0;
  let orphaned = 0;

  const handler = async (rawArgs: unknown, requestSignal?: AbortSignal): Promise<MemorySearchResult> => {
    let args: z.infer<typeof SearchArgumentsSchema>;
    try {
      args = SearchArgumentsSchema.parse(rawArgs ?? {});
    } catch (err) {
      return failure(err);
    }
    if (requestSignal?.aborted) return failure(new Error('search_memory cancelled'));
    if (active >= maxConcurrent || active + orphaned >= hardCap) {
      return {
        content: [{
          type: 'text',
          text: `search_memory busy: ${active}/${maxConcurrent} searches running, ${orphaned} abandoned still settling — retry shortly`,
        }],
        isError: true,
      };
    }
    active += 1;
    const controller = new AbortController();
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    let onRequestAbort: (() => void) | null = null;
    let interrupted = false;
    let searchPromise: Promise<string> | null = null;
    try {
      const interrupt = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => { interrupted = true; reject(new Error(`search_memory timed out after ${timeoutMs}ms`)); },
          timeoutMs,
        );
        if (requestSignal) {
          onRequestAbort = () => { interrupted = true; reject(new Error('search_memory cancelled')); };
          requestSignal.addEventListener('abort', onRequestAbort, { once: true });
        }
      });
      // searchRepoMemoryText (repoKnowledge.ts) does not take a signal yet, so in
      // production the abort is advisory and the orphan count is what bounds work.
      searchPromise = options.search(options.cwd(), args.query, args.limit, controller.signal);
      const text = await Promise.race([searchPromise, interrupt]);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return failure(err);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      if (requestSignal && onRequestAbort) requestSignal.removeEventListener('abort', onRequestAbort);
      active -= 1;
      if (interrupted && searchPromise) {
        // The race was lost to the deadline or a cancel: the search may still be
        // running, so count it as orphaned until the underlying promise settles.
        controller.abort();
        orphaned += 1;
        searchPromise.then(
          () => { orphaned -= 1; },
          () => { orphaned -= 1; },
        );
      }
    }
  };

  // Getters, not Object.assign: assign would copy the value once.
  return Object.defineProperties(handler, {
    /** Searches currently holding a slot. */
    running: { get: () => active, enumerable: true },
    /** Searches that lost their slot to a deadline or cancel but have not settled. */
    orphaned: { get: () => orphaned, enumerable: true },
  }) as typeof handler & { readonly running: number; readonly orphaned: number };
}

function failure(err: unknown): MemorySearchResult {
  return {
    content: [{ type: 'text', text: `search_memory failed: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

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
  search: (cwd: string, query: string, limit: number) => Promise<string>;
  cwd: () => string;
  timeoutMs?: number;
  maxConcurrent?: number;
}

/**
 * Build the search_memory handler.
 *
 * Over-limit policy: a call that finds every slot taken is rejected at once with a
 * "busy" tool error instead of waiting. Waiting would need its own queue bound and
 * timeout, and a CLI agent handles a tool error by retrying or moving on, which is
 * the cheaper outcome for a recall hint.
 *
 * A slot is returned when the call finishes, fails or hits its deadline. After a
 * deadline the underlying search cannot be cancelled and may still finish in the
 * background; the slot is returned anyway so a hung embedding cannot hold the
 * server busy forever (same rule as AGT-3495).
 */
export function createMemorySearchHandler(options: MemorySearchHandlerOptions) {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const maxConcurrent = Math.max(1, options.maxConcurrent ?? MAX_CONCURRENT_SEARCHES);
  let active = 0;

  const handler = async (rawArgs: unknown): Promise<MemorySearchResult> => {
    let args: z.infer<typeof SearchArgumentsSchema>;
    try {
      args = SearchArgumentsSchema.parse(rawArgs ?? {});
    } catch (err) {
      return failure(err);
    }
    if (active >= maxConcurrent) {
      return {
        content: [{
          type: 'text',
          text: `search_memory busy: ${active}/${maxConcurrent} searches already running — retry shortly`,
        }],
        isError: true,
      };
    }
    active += 1;
    let deadlineTimer: ReturnType<typeof setTimeout> | null = null;
    try {
      const deadline = new Promise<never>((_, reject) => {
        deadlineTimer = setTimeout(
          () => reject(new Error(`search_memory timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });
      const text = await Promise.race([options.search(options.cwd(), args.query, args.limit), deadline]);
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return failure(err);
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      active -= 1;
    }
  };

  // A getter, not Object.assign: assign would copy the value once.
  return Object.defineProperty(handler, 'running', {
    /** Searches currently holding a slot. */
    get: () => active,
    enumerable: true,
  }) as typeof handler & { readonly running: number };
}

function failure(err: unknown): MemorySearchResult {
  return {
    content: [{ type: 'text', text: `search_memory failed: ${err instanceof Error ? err.message : String(err)}` }],
    isError: true,
  };
}

#!/usr/bin/env node
// ============================================
// OpenSwarm — Memory MCP server (stdio)
// ============================================
//
// Exposes repo-scoped memory search to CLI-delegated agents (codex exec,
// claude -p) that run their own harness and therefore can't see OpenSwarm's
// in-loop `search_memory` tool. The native agentic loop already has the tool
// in-process; this is the bridge for the CLI adapters.
//
// Launched by the codex/claude adapters (see src/adapters/memoryMcp.ts) with the
// worker's project directory as cwd, so process.cwd() → repoKey scopes results to
// the right repo. The embedding model loads lazily, only on the first call.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { searchRepoMemoryText } from '../memory/repoKnowledge.js';
import { z } from 'zod';

const MAX_CONCURRENT_SEARCHES = 4;
const SEARCH_DEADLINE_MS = 10_000;

// Simple semaphore to bound concurrent memory searches
let activeSearches = 0;
const searchQueue: Array<() => void> = [];

async function acquireSearchSlot(): Promise<void> {
  if (activeSearches < MAX_CONCURRENT_SEARCHES) {
    activeSearches++;
    return;
  }
  return new Promise<void>((resolve) => {
    searchQueue.push(resolve);
  });
}

function releaseSearchSlot(): void {
  activeSearches--;
  if (searchQueue.length > 0) {
    const next = searchQueue.shift();
    next?.();
  }
}

const SearchArgumentsSchema = z.object({
  query: z.string().trim().min(1).max(2_000),
  limit: z.number().int().min(1).max(10).default(5),
}).strict();

// MCP stdio reserves stdout for protocol frames. Keep all console.log output on
// stderr for this process lifetime instead of patching/restoring it per request.
console.log = (...args: unknown[]) => console.error(...args);

const SEARCH_TOOL = {
  name: 'search_memory',
  description:
    "Search this repository's accumulated knowledge from past tasks — successful approaches (patterns) " +
    'and reviewer pitfalls (constraints) — by semantic query. Call this BEFORE implementing to reuse what ' +
    'worked here and avoid known mistakes. Scoped to the current repository automatically.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to recall, e.g. "how auth migrations were handled"' },
      limit: { type: 'number', description: 'Max results (1-10). Default: 5' },
    },
    required: ['query'],
  },
} as const;

async function main(): Promise<void> {
  const server = new Server(
    { name: 'openswarm-memory', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [SEARCH_TOOL],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'search_memory') {
      return {
        content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }],
        isError: true,
      };
    }
    try {
      const args = SearchArgumentsSchema.parse(request.params.arguments ?? {});
      await acquireSearchSlot();
      let text: string;
      try {
        const searchPromise = searchRepoMemoryText(args.query, args.limit);
        const deadlinePromise = new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Memory search timed out')), SEARCH_DEADLINE_MS)
        );
        text = await Promise.race([searchPromise, deadlinePromise]);
      } finally {
        releaseSearchSlot();
      }
      return { content: [{ type: 'text', text }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `search_memory failed: ${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[memoryServer] fatal:', err);
  process.exit(1);
});
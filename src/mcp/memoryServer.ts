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
import { createMemorySearchHandler } from './memorySearch.js';

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

  // Deadline and concurrency cap live in memorySearch.ts (AGT-4875).
  const searchMemory = createMemorySearchHandler({ search: searchRepoMemoryText, cwd: () => process.cwd() });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [SEARCH_TOOL] }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    if (req.params.name !== 'search_memory') {
      return { content: [{ type: 'text', text: `Unknown tool: ${req.params.name}` }], isError: true };
    }
    return searchMemory(req.params.arguments);
  });

  await server.connect(new StdioServerTransport());
}

main().catch((err) => {
  console.error('[memoryServer] fatal:', err);
  process.exit(1);
});

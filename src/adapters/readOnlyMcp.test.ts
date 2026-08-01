// ============================================
// OpenSwarm — read-only runs must not connect MCP servers
// Purpose: guard the INT-3189 hole where resolving MCP tools spawned an
//          attacker-authored command before the read-only filter ever ran.
// Test Status: npm run test -- src/adapters/readOnlyMcp.test.ts
// ============================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveMcpToolsMock = vi.hoisted(() => vi.fn(async () => []));
vi.mock('../mcp/mcpClient.js', () => ({ resolveMcpTools: resolveMcpToolsMock }));

const runAgenticLoopMock = vi.hoisted(() =>
  vi.fn(async () => ({
    text: '{}',
    toolCallCount: 0,
    apiCallCount: 1,
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    durationMs: 1,
    executedCommands: [],
  })),
);
vi.mock('./agenticLoop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./agenticLoop.js')>();
  return { ...actual, runAgenticLoop: runAgenticLoopMock };
});

import { OpenRouterCliAdapter } from './openrouter.js';
import { AtlasCloudCliAdapter } from './atlascloud.js';
import { GptCliAdapter } from './gpt.js';
import { LocalModelAdapter } from './local.js';

// Each adapter needs its own credential/endpoint to reach the MCP step at all.
const ADAPTERS = [
  { name: 'openrouter', make: () => new OpenRouterCliAdapter(), env: { OPENROUTER_API_KEY: 'test-key' } },
  { name: 'atlascloud', make: () => new AtlasCloudCliAdapter(), env: { ATLASCLOUD_API_KEY: 'test-key' } },
  { name: 'gpt', make: () => new GptCliAdapter(), env: { OPENAI_API_KEY: 'test-key' } },
  { name: 'local', make: () => new LocalModelAdapter(), env: { LOCAL_LLM_URL: 'http://127.0.0.1:1234/v1' } },
];

describe('read-only runs never resolve MCP tools (INT-3189)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resolveMcpToolsMock.mockClear();
    runAgenticLoopMock.mockClear();
  });

  afterEach(() => {
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  for (const { name, make, env } of ADAPTERS) {
    it(`${name}: does not connect MCP servers when readOnly is set`, async () => {
      // Resolving is connecting. The registry merges `mcp.servers` from whatever
      // config is discovered in cwd, and the stdio transport spawns each
      // server's command with secrets expanded into its environment. During a CI
      // review the cwd is the checkout under review, so that config belongs to
      // the author of the diff — filtering the tools afterwards is far too late,
      // the process has already run.
      Object.assign(process.env, env);
      const adapter = make();
      await adapter.run?.({ prompt: 'review this', cwd: process.cwd(), model: 'm', readOnly: true }).catch(() => {});

      expect(resolveMcpToolsMock).not.toHaveBeenCalled();
      const passed = runAgenticLoopMock.mock.calls[0]?.[0];
      expect(passed?.readOnly).toBe(true);
      expect(passed?.mcpTools).toBeUndefined();
    });

    it(`${name}: still resolves MCP tools for an ordinary run`, async () => {
      Object.assign(process.env, env);
      const adapter = make();
      await adapter.run?.({ prompt: 'do work', cwd: process.cwd(), model: 'm' }).catch(() => {});

      expect(resolveMcpToolsMock).toHaveBeenCalledTimes(1);
    });
  }
});

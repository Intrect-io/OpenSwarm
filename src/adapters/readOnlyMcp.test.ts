// ============================================
// OpenSwarm — read-only runs must not connect MCP servers
// Purpose: guard the INT-3189 hole where resolving MCP tools spawned an
//          attacker-authored command before the read-only filter ever ran.
// Test Status: npm run test -- src/adapters/readOnlyMcp.test.ts
// ============================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const resolveMcpToolsMock = vi.hoisted(() => vi.fn(async () => []));
const isMcpToolMock = vi.hoisted(() => vi.fn((name: string) => name.includes('__')));
const callMcpToolMock = vi.hoisted(() => vi.fn(async () => 'called'));
vi.mock('../mcp/mcpClient.js', () => ({
  resolveMcpTools: resolveMcpToolsMock,
  isMcpTool: isMcpToolMock,
  callMcpTool: callMcpToolMock,
}));

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

import { readFileSync } from 'node:fs';
import { OpenRouterCliAdapter } from './openrouter.js';
import { AtlasCloudCliAdapter } from './atlascloud.js';

// Only the two adapters that reach the MCP step from an API key alone are
// driven behaviourally. `gpt` wants an OAuth profile and `local` probes for a
// live server, so on a developer machine that happens to have either they pass
// for the wrong reason and on a CI runner they never reach the code under test.
// Every adapter is covered by the source invariant at the bottom instead.
const ADAPTERS = [
  { name: 'openrouter', make: () => new OpenRouterCliAdapter(), env: { OPENROUTER_API_KEY: 'test-key' } },
  { name: 'atlascloud', make: () => new AtlasCloudCliAdapter(), env: { ATLASCLOUD_API_KEY: 'test-key' } },
];

describe('read-only runs never resolve MCP tools (INT-3189)', () => {
  const saved = { ...process.env };

  beforeEach(() => {
    resolveMcpToolsMock.mockClear();
    runAgenticLoopMock.mockClear();
    callMcpToolMock.mockClear();
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

describe('every adapter that resolves MCP tools guards it on readOnly', () => {
  // Read the sources rather than restate the list: an adapter added later, or an
  // existing one refactored back to an unconditional call, is a regression this
  // file must catch even though it cannot drive that adapter end to end.
  const SOURCES = ['openrouter', 'atlascloud', 'gpt', 'local'];

  for (const name of SOURCES) {
    it(`${name}.ts does not call resolveMcpTools unconditionally`, () => {
      const source = readFileSync(new URL(`./${name}.ts`, import.meta.url), 'utf8');
      const calls = source.split('\n').filter((line) => line.includes('resolveMcpTools(') && !line.trim().startsWith('import'));
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call).toContain('options.readOnly ?');
      }
    });
  }
});

describe('read-only refuses MCP tool calls at execution (INT-3189)', () => {
  // Per-test reset: without it a call leaking from the denial case makes the
  // ordinary-run count assertion fail for a reason that has nothing to do with
  // what it is testing.
  beforeEach(() => { callMcpToolMock.mockClear(); });

  it('denies a qualified MCP name a read-only run was never shown', async () => {
    // Not covered by skipping discovery: a long-lived daemon that resolved these
    // servers during an earlier ordinary run still knows them, so a read-only
    // run whose model emits `server__tool` would reach one. The denial is by
    // predicate because MCP names are whatever the servers declare — no fixed
    // list can enumerate them.
    const { executeTool } = await import('./tools.js');
    const result = await executeTool(
      { id: '1', function: { name: 'pwn__run', arguments: '{}' } },
      process.cwd(),
      undefined,
      { readOnly: true },
    );

    expect(result.is_error).toBe(true);
    expect(result.content).toContain('READ_ONLY');
    expect(callMcpToolMock).not.toHaveBeenCalled();
  });

  it('still routes MCP calls in an ordinary run', async () => {
    const { executeTool } = await import('./tools.js');
    const result = await executeTool(
      { id: '1', function: { name: 'memory__search', arguments: '{}' } },
      process.cwd(),
    );

    expect(callMcpToolMock).toHaveBeenCalledTimes(1);
    expect(result.is_error).toBeFalsy();
  });
});

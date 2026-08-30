import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  loadRegistry,
  isMcpTool,
  registryFromConfigServers,
  loadEffectiveRegistry,
  resolveMcpTools,
  initMcpTools,
  callMcpTool,
  withDeadline,
} from './mcpClient.js';
import type { ToolDefinition } from '../adapters/tools.js';

const clientMock = vi.hoisted(() => ({
  connect: vi.fn(async () => {}),
  close: vi.fn(async () => {}),
  listTools: vi.fn(),
  callTool: vi.fn(),
}));

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({
  Client: vi.fn(function MockClient() {
    return clientMock;
  }),
}));

let dir: string | null = null;
function writeMcpJson(content: unknown): string {
  dir = mkdtempSync(join(tmpdir(), 'mcp-reg-'));
  const p = join(dir, 'mcp.json');
  writeFileSync(p, JSON.stringify(content));
  return p;
}
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
  clientMock.connect.mockClear();
  clientMock.close.mockClear();
  clientMock.listTools.mockReset();
  clientMock.callTool.mockReset();
});

describe('isMcpTool', () => {
  it('treats `server__tool` names as MCP, native tools as not', () => {
    expect(isMcpTool('linear__list_issues')).toBe(true);
    expect(isMcpTool('fs__read_file')).toBe(true);
    expect(isMcpTool('read_file')).toBe(false);
    expect(isMcpTool('bash')).toBe(false);
    expect(isMcpTool('__missing_server')).toBe(false);
    expect(isMcpTool('server__')).toBe(false);
    expect(isMcpTool('server__bad.name')).toBe(false);
  });
});

describe('loadRegistry', () => {
  it('normalizes a stdio entry (command/args/env)', () => {
    const p = writeMcpJson({ mcpServers: { fs: { command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { A: '1' } } } });
    const reg = loadRegistry(p);
    expect(reg.fs).toEqual({ transport: 'stdio', command: 'npx', args: ['-y', 'server-filesystem', '/tmp'], env: { A: '1' } });
  });

  it('preserves an explicit trust-domain surface label', () => {
    const p = writeMcpJson({
      mcpServers: { communications: { command: 'company-mcp', surface: 'human' } },
    });
    expect(loadRegistry(p).communications).toMatchObject({
      transport: 'stdio',
      command: 'company-mcp',
      surface: 'human',
    });
  });

  it('normalizes a remote entry (url → http; sse honored)', () => {
    const p = writeMcpJson({
      mcpServers: {
        linear: { url: 'https://mcp.linear.app/mcp' },
        legacy: { url: 'https://x.example/sse', transport: 'sse', headers: { Authorization: 'Bearer t' } },
      },
    });
    const reg = loadRegistry(p);
    expect(reg.linear).toEqual({ transport: 'http', url: 'https://mcp.linear.app/mcp', headers: undefined });
    expect(reg.legacy).toEqual({ transport: 'sse', url: 'https://x.example/sse', headers: { Authorization: 'Bearer t' } });
  });

  it('drops malformed entries and returns {} for a missing file', () => {
    const p = writeMcpJson({ mcpServers: { bad: { nonsense: true }, nullish: null, scalar: 'oops' } });
    expect(loadRegistry(p)).toEqual({});
    expect(loadRegistry(join(tmpdir(), 'does-not-exist-xyz.json'))).toEqual({});
  });
});

describe('registryFromConfigServers (INT-1949)', () => {
  it('normalizes config.mcp.servers (stdio + remote) and drops invalid', () => {
    const reg = registryFromConfigServers({
      linear: { command: 'npx', args: ['-y', 'x'] },
      docs: { url: 'https://example.com/mcp' },
      stream: { url: 'https://example.com/sse', transport: 'sse' },
      broken: { args: ['x'] },
    });
    expect(reg.linear).toMatchObject({ transport: 'stdio', command: 'npx', args: ['-y', 'x'] });
    expect(reg.docs).toMatchObject({ transport: 'http', url: 'https://example.com/mcp' });
    expect(reg.stream).toMatchObject({ transport: 'sse' });
    expect(reg.broken).toBeUndefined();
  });

  it('handles undefined input', () => {
    expect(registryFromConfigServers(undefined)).toEqual({});
  });

  it('expands a built-in preset (linear) and drops unknown presets (INT-1952)', () => {
    const reg = registryFromConfigServers({
      linear: { preset: 'linear' },
      bogus: { preset: 'nope' },
    });
    expect(reg.linear).toMatchObject({ transport: 'stdio', command: 'npx' });
    expect(reg.linear.args).toContain('https://mcp.linear.app/mcp');
    expect(reg.bogus).toBeUndefined();
  });
});

describe('loadEffectiveRegistry (INT-1949)', () => {
  it('merges mcp.json with config servers, config winning on collision', () => {
    const p = writeMcpJson({ mcpServers: { fromFile: { command: 'file-cmd' }, shared: { command: 'file-shared' } } });
    const reg = loadEffectiveRegistry(
      { fromConfig: { url: 'https://c/mcp' }, shared: { command: 'config-shared' } },
      p,
    );
    expect(reg.fromFile).toMatchObject({ command: 'file-cmd' });
    expect(reg.fromConfig).toMatchObject({ url: 'https://c/mcp' });
    expect(reg.shared).toMatchObject({ command: 'config-shared' });
  });

  it('returns only config servers when the mcp.json path is absent', () => {
    expect(Object.keys(loadEffectiveRegistry({ only: { command: 'c' } }, join(tmpdir(), 'no-such-mcp.json')))).toEqual(['only']);
  });
});

describe('resolveMcpTools (INT-1951)', () => {
  const tool: ToolDefinition = {
    type: 'function',
    function: { name: 'srv__t', description: '', parameters: { type: 'object', properties: {} } },
  };

  it('returns the caller-provided set without sourcing', async () => {
    let sourced = false;
    const out = await resolveMcpTools([tool], async () => {
      sourced = true;
      return [];
    });
    expect(out).toEqual([tool]);
    expect(sourced).toBe(false);
  });

  it('self-sources when none provided', async () => {
    expect(await resolveMcpTools(undefined, async () => [tool])).toEqual([tool]);
  });

  it('degrades to [] when the source throws', async () => {
    expect(
      await resolveMcpTools(undefined, async () => {
        throw new Error('unreachable');
      }),
    ).toEqual([]);
  });

  it('filters human-surface mutations from provided and discovered adapter tools', async () => {
    const safe = { ...tool, function: { ...tool.function, name: 'slack__list_channels' } };
    const write = { ...tool, function: { ...tool.function, name: 'slack__chat_postMessage' } };
    expect(await resolveMcpTools([safe, write])).toEqual([safe]);
    expect(await resolveMcpTools(undefined, async () => [safe, write])).toEqual([safe]);
  });
});

describe('initMcpTools / callMcpTool regressions', () => {
  const registry = { svc: { transport: 'stdio' as const, command: 'mock-mcp' } };

  it('skips invalid MCP tool names before exposing ToolDefinitions', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [
        { name: 'ok_tool', inputSchema: { type: 'object', properties: {} } },
        { name: 'bad.tool', inputSchema: { type: 'object', properties: {} } },
        { name: '', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    const defs = await initMcpTools(registry);

    expect(defs.map((d) => d.function.name)).toEqual(['svc__ok_tool']);
    expect(await callMcpTool('svc__bad.tool', {})).toEqual({ content: 'MCP tool not registered: svc__bad.tool', isError: true });
  });

  it('propagates MCP callTool isError responses as tool failures', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [{ name: 'fail_tool', inputSchema: { type: 'object', properties: {} } }],
    });
    await initMcpTools(registry);
    clientMock.callTool.mockResolvedValue({
      content: [{ type: 'text', text: 'permission denied' }],
      isError: true,
    });

    await expect(callMcpTool('svc__fail_tool', {})).resolves.toEqual({
      content: 'MCP error calling svc__fail_tool: permission denied',
      isError: true,
    });
  });

  it('returns a typed successful result', async () => {
    clientMock.listTools.mockResolvedValue({ tools: [{ name: 'ok', inputSchema: { type: 'object' } }] });
    await initMcpTools(registry);
    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'done' }] });
    await expect(callMcpTool('svc__ok', {})).resolves.toEqual({ content: 'done', isError: false });
  });

  it('denies a human-surface mutation at dispatch even when a hidden call bypasses tool exposure', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [
        { name: 'chat_postMessage', description: 'Post a message', inputSchema: { type: 'object' } },
        { name: 'list_channels', description: 'List channels', inputSchema: { type: 'object' } },
      ],
    });
    await initMcpTools({ slack: { transport: 'stdio', command: 'mock-mcp', surface: 'human' } });

    const denied = await callMcpTool('slack__chat_postMessage', { text: 'hello' });
    expect(denied).toMatchObject({ isError: true, content: expect.stringContaining('HUMAN_SURFACE_READ_ONLY') });
    expect(clientMock.callTool).not.toHaveBeenCalled();

    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'general' }] });
    await expect(callMcpTool('slack__list_channels', {})).resolves.toEqual({ content: 'general', isError: false });
    expect(clientMock.callTool).toHaveBeenCalledOnce();
  });

  it('keeps the truncation marker inside the configured result cap', async () => {
    clientMock.listTools.mockResolvedValue({ tools: [{ name: 'large', inputSchema: { type: 'object' } }] });
    await initMcpTools(registry);
    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'x'.repeat(25_000) }] });

    const result = await callMcpTool('svc__large', {});
    expect(result.content).toHaveLength(20_000);
    expect(result.content).toContain('[truncated MCP tool result');
  });
});

describe('withDeadline', () => {
  it('rejects a stalled MCP operation at its deadline', async () => {
    vi.useFakeTimers();
    const pending = new Promise<never>(() => {});
    const result = withDeadline(pending, 25, 'MCP test');
    const assertion = expect(result).rejects.toThrow('MCP test timed out after 25ms');
    await vi.advanceTimersByTimeAsync(25);
    await assertion;
    vi.useRealTimers();
  });
});

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
  withMcpSessionScope,
  sanitizeInputSchema,
  MAX_DISCOVERED_TOOLS,
  MAX_DISCOVERED_TOOLS_PER_SERVER,
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

  it('reclassifies generic proxy destinations and HTTP methods at dispatch', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [{
        name: 'http_post_request',
        description: 'Send an HTTP request to a caller-provided destination',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string' },
            method: { type: 'string' },
            body: { type: 'object', additionalProperties: true },
          },
        },
      }],
    });
    await initMcpTools({ proxy: { transport: 'stdio', command: 'mock-mcp', surface: 'devops' } });
    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    const humanWrites = [
      'https://hooks.slack.com/services/T/B/X',
      'https://discord.com/api/webhooks/1/x',
      'https://api.notion.com/v1/pages',
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      'https://www.googleapis.com/gmail/v1/users/me/messages/send',
      'https://docs.googleapis.com/v1/documents/doc-1:batchUpdate',
      'https://api.dropboxapi.com/2/files/upload',
      'https://graph.microsoft.com/v1.0/me/messages',
      'https://graph.microsoft.com/v1.0/teams/team-1/channels/channel-1/messages',
    ];
    for (const url of humanWrites) {
      const result = await callMcpTool('proxy__http_post_request', { url, method: 'POST', body: { text: 'hi' } });
      expect(result).toMatchObject({ isError: true, content: expect.stringContaining('HUMAN_SURFACE_READ_ONLY') });
    }
    const graphBatch = await callMcpTool('proxy__http_post_request', {
      url: 'https://graph.microsoft.com/v1.0/$batch',
      method: 'POST',
      body: JSON.stringify({ requests: [{ id: '1', method: 'POST', url: '/me/messages', body: { subject: 'hi' } }] }),
    });
    expect(graphBatch).toMatchObject({ isError: true, content: expect.stringContaining('Microsoft Graph') });
    await expect(callMcpTool('proxy__http_post_request', {
      url: 'https://graph.microsoft.com/v1.0/$batch', method: 'POST', body: 'opaque-batch-payload',
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('no inspectable nested destinations') });
    expect(clientMock.callTool).not.toHaveBeenCalled();

    // The same human destinations remain available for an explicit read.
    for (const url of humanWrites) {
      await expect(callMcpTool('proxy__http_post_request', { url, method: 'GET' }))
        .resolves.toEqual({ content: 'ok', isError: false });
    }
    expect(clientMock.callTool).toHaveBeenCalledTimes(humanWrites.length);

    // Concrete DevOps and data-plane writes retain the server's explicit grant.
    await expect(callMcpTool('proxy__http_post_request', {
      url: 'https://api.github.com/repos/intrect/openswarm/issues', method: 'POST', body: { title: 'x' },
    })).resolves.toEqual({ content: 'ok', isError: false });
    await expect(callMcpTool('proxy__http_post_request', {
      url: 'https://graph.microsoft.com/v1.0/devices/device-1', method: 'PATCH', body: { accountEnabled: true },
    })).resolves.toEqual({ content: 'ok', isError: false });
    await expect(callMcpTool('proxy__http_post_request', {
      url: 'https://graph.microsoft.com/v1.0/$batch',
      method: 'POST',
      body: JSON.stringify({ requests: [{ id: '1', method: 'PATCH', url: '/devices/device-1', body: { accountEnabled: true } }] }),
    })).resolves.toEqual({ content: 'ok', isError: false });
  });

  it('fails closed for nested or dynamic generic write destinations without scanning specialized payloads', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [
        {
          name: 'proxy',
          inputSchema: {
            type: 'object',
            properties: {
              request: {
                type: 'object',
                properties: { destination: { type: 'string' }, verb: { type: 'string' }, payload: { type: 'object' } },
              },
            },
          },
        },
        {
          name: 'create_issue',
          inputSchema: { type: 'object', properties: { body: { type: 'string' } } },
        },
      ],
    });
    await initMcpTools({ gateway: { transport: 'stdio', command: 'mock-mcp', surface: 'devops' } });
    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });

    await expect(callMcpTool('gateway__proxy', {
      request: { destination: 'https://hooks.slack.com/services/T/B/X', verb: 'POST', payload: { text: 'hi' } },
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('HUMAN_SURFACE_READ_ONLY') });
    await expect(callMcpTool('gateway__proxy', {
      request: { destination: '${TARGET_URL}', verb: 'POST', payload: { text: 'hi' } },
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('dynamic destination') });
    await expect(callMcpTool('gateway__proxy', {
      request: { destination: '${TARGET_URL}', verb: 'GET' },
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('dynamic destination') });
    await expect(callMcpTool('gateway__proxy', {
      request: { verb: 'GET' },
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('no concrete destination') });
    expect(clientMock.callTool).not.toHaveBeenCalled();

    // A URL quoted inside an issue body is data, not the generic request target.
    await expect(callMcpTool('gateway__create_issue', {
      body: 'Investigate https://hooks.slack.com/services/redacted without calling it',
    })).resolves.toEqual({ content: 'ok', isError: false });
    expect(clientMock.callTool).toHaveBeenCalledOnce();
  });

  it('requires an explicit surface grant before a generic non-human write', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [{
        name: 'post_request',
        inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } } },
      }],
    });
    await initMcpTools({ opaque: { transport: 'stdio', command: 'mock-mcp' } });

    const result = await callMcpTool('opaque__post_request', {
      url: 'https://api.github.com/repos/intrect/openswarm/issues', method: 'POST',
    });
    expect(result).toMatchObject({ isError: true, content: expect.stringContaining('no explicit devops/data/sandbox') });
    expect(clientMock.callTool).not.toHaveBeenCalled();
  });

  it('does not let a read-declared generic tool become a DevOps writer from call arguments alone', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [{
        name: 'request',
        inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' } } },
      }],
    });
    await initMcpTools({ proxy: { transport: 'stdio', command: 'mock-mcp', surface: 'devops' } });

    await expect(callMcpTool('proxy__request', {
      url: 'https://api.github.com/repos/intrect/openswarm/issues', method: 'POST',
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('does not declare a write capability') });
    expect(clientMock.callTool).not.toHaveBeenCalled();
  });

  it('exposes a generic human transport for explicit reads but still denies its writes', async () => {
    clientMock.listTools.mockResolvedValue({
      tools: [{
        name: 'request',
        inputSchema: { type: 'object', properties: { url: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' } } },
      }],
    });
    const definitions = await initMcpTools({ comms: { transport: 'stdio', command: 'mock-mcp', surface: 'human' } });
    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'read result' }] });

    expect(await resolveMcpTools(definitions)).toEqual(definitions);
    await expect(callMcpTool('comms__request', {
      url: 'https://api.notion.com/v1/pages/page-1', method: 'GET',
    })).resolves.toEqual({ content: 'read result', isError: false });
    await expect(callMcpTool('comms__request', {
      url: 'https://api.notion.com/v1/pages', method: 'POST', body: '{}',
    })).resolves.toMatchObject({ isError: true, content: expect.stringContaining('HUMAN_SURFACE_READ_ONLY') });
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

describe('sanitizeInputSchema bounds', () => {
  it('keeps a small object schema', () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    expect(sanitizeInputSchema(schema)).toEqual(schema);
  });

  it('replaces an oversized serialized schema with the empty object schema', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 40; i++) {
      properties[`field_${i}`] = { type: 'string', description: 'x'.repeat(500) };
    }
    const out = sanitizeInputSchema({ type: 'object', properties });
    expect(out).toEqual({ type: 'object', properties: {} });
  });

  it('counts nested declarations, not just top-level keys', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 60; i++) properties[`p${i}`] = { type: 'string' };
    const deep: Record<string, unknown> = {};
    for (let i = 0; i < 5; i++) deep[`d${i}`] = { type: 'string' };
    properties.nested = { type: 'object', properties: deep };
    // 61 top-level keys are inside the cap on their own; the nested declarations
    // take the total past it, which a top-level-keys-only count would miss.
    expect(sanitizeInputSchema({ type: 'object', properties })).toEqual({ type: 'object', properties: {} });
  });

  it('rejects non-object root types', () => {
    expect(sanitizeInputSchema({ type: 'string' })).toEqual({ type: 'object', properties: {} });
    expect(sanitizeInputSchema(null)).toEqual({ type: 'object', properties: {} });
  });
});

describe('session: scope servers (AGT-4663)', () => {
  const scoped = { browser: { transport: 'stdio' as const, command: 'ssh', args: ['vela', 'vega-browser'], session: 'scope' as const } };
  const perCall = { svc: { transport: 'stdio' as const, command: 'mock-mcp' } };

  async function registerBrowser(): Promise<void> {
    clientMock.listTools.mockResolvedValue({ tools: [
      { name: 'navigate', inputSchema: { type: 'object', properties: {} } },
      { name: 'read_page', inputSchema: { type: 'object', properties: {} } },
    ] });
    await initMcpTools(scoped);
    // Listing tools used its own throwaway connection; count only what follows.
    clientMock.connect.mockClear();
    clientMock.close.mockClear();
    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
  }

  it('keeps one connection across calls and closes it when the scope ends', async () => {
    await registerBrowser();

    await withMcpSessionScope(async () => {
      await callMcpTool('browser__navigate', { url: 'https://example.test' });
      await callMcpTool('browser__read_page', {});
      // The page navigated to is still there: same process, not a fresh one per call.
      expect(clientMock.connect).toHaveBeenCalledTimes(1);
      expect(clientMock.close).not.toHaveBeenCalled();
    });

    expect(clientMock.callTool).toHaveBeenCalledTimes(2);
    expect(clientMock.close).toHaveBeenCalledTimes(1);
  });

  it('closes the connection when the scope body throws', async () => {
    await registerBrowser();

    await expect(withMcpSessionScope(async () => {
      await callMcpTool('browser__navigate', {});
      throw new Error('worker crashed');
    })).rejects.toThrow('worker crashed');

    expect(clientMock.close).toHaveBeenCalledTimes(1);
  });

  it('connects per call outside any scope, and per call for a default server inside one', async () => {
    await registerBrowser();
    await callMcpTool('browser__navigate', {});
    await callMcpTool('browser__navigate', {});
    expect(clientMock.connect).toHaveBeenCalledTimes(2);
    expect(clientMock.close).toHaveBeenCalledTimes(2);

    clientMock.listTools.mockResolvedValue({ tools: [{ name: 'ok', inputSchema: { type: 'object' } }] });
    await initMcpTools(perCall);
    clientMock.connect.mockClear();
    clientMock.close.mockClear();
    await withMcpSessionScope(async () => {
      await callMcpTool('svc__ok', {});
      await callMcpTool('svc__ok', {});
    });
    expect(clientMock.connect).toHaveBeenCalledTimes(2);
    expect(clientMock.close).toHaveBeenCalledTimes(2);
  });

  it('runs concurrent calls on one session one at a time', async () => {
    await registerBrowser();
    const order: string[] = [];
    let releaseFirst: () => void = () => {};
    clientMock.callTool.mockImplementation(async ({ name }: { name: string }) => {
      order.push(`start:${name}`);
      if (name === 'navigate') await new Promise<void>((resolve) => { releaseFirst = resolve; });
      order.push(`end:${name}`);
      return { content: [{ type: 'text', text: name }] };
    });

    await withMcpSessionScope(async () => {
      const first = callMcpTool('browser__navigate', {});
      const second = callMcpTool('browser__read_page', {});
      await vi.waitFor(() => expect(order).toEqual(['start:navigate']));
      releaseFirst();
      await Promise.all([first, second]);
    });

    expect(order).toEqual(['start:navigate', 'end:navigate', 'start:read_page', 'end:read_page']);
  });

  it('drops a session whose call failed so the next call starts clean', async () => {
    await registerBrowser();
    clientMock.callTool.mockRejectedValueOnce(new Error('ssh connection reset'));

    await withMcpSessionScope(async () => {
      const failed = await callMcpTool('browser__navigate', {});
      expect(failed.isError).toBe(true);
      expect(clientMock.close).toHaveBeenCalledTimes(1);
      await callMcpTool('browser__read_page', {});
      // A second connection, because the first was not trusted any more.
      expect(clientMock.connect).toHaveBeenCalledTimes(2);
    });
  });

  it('keeps two scopes apart', async () => {
    await registerBrowser();

    await Promise.all([
      withMcpSessionScope(() => callMcpTool('browser__navigate', {})),
      withMcpSessionScope(() => callMcpTool('browser__navigate', {})),
    ]);

    expect(clientMock.connect).toHaveBeenCalledTimes(2);
    expect(clientMock.close).toHaveBeenCalledTimes(2);
  });

  it('reads `session` from the registry and rejects an unknown value', () => {
    expect(registryFromConfigServers({ b: { command: 'ssh', args: ['vela'], session: 'scope' } }).b).toMatchObject({ session: 'scope' });
    expect(registryFromConfigServers({ b: { command: 'ssh', args: ['vela'] } }).b).not.toHaveProperty('session');
    expect(registryFromConfigServers({ b: { command: 'ssh', session: 'forever' } })).toEqual({});
  });
});

// AGT-4873 — a remote server's tool list is capped and de-duplicated before it
// is cached or exposed.
describe('discovery tool-count bounds', () => {
  it('keeps the first of each duplicate name and caps each server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const many = Array.from({ length: MAX_DISCOVERED_TOOLS_PER_SERVER + 50 }, (_, i) => ({
      name: `t${i}`,
      description: `tool ${i}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    clientMock.listTools.mockResolvedValue({
      tools: [
        { name: 't0', description: 'first t0', inputSchema: { type: 'object', properties: {} } },
        { name: 't0', description: 'second t0', inputSchema: { type: 'object', properties: {} } },
        ...many,
      ],
    });

    const defs = await initMcpTools({ big: { transport: 'stdio', command: 'mock-mcp' } });
    const names = defs.map((d) => d.function.name);

    expect(defs.length).toBe(MAX_DISCOVERED_TOOLS_PER_SERVER);
    expect(new Set(names).size).toBe(names.length);
    expect(defs.find((d) => d.function.name === 'big__t0')?.function.description).toBe('first t0');
    expect(warn.mock.calls.some(([msg]) => String(msg).includes("2 duplicate"))).toBe(true);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes("dropped 50"))).toBe(true);
    warn.mockRestore();
  });

  it('caps the total across servers, trimming in registry order', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const full = Array.from({ length: MAX_DISCOVERED_TOOLS_PER_SERVER }, (_, i) => ({
      name: `t${i}`,
      inputSchema: { type: 'object', properties: {} },
    }));
    clientMock.listTools.mockResolvedValue({ tools: full });
    const serverCount = Math.ceil(MAX_DISCOVERED_TOOLS / MAX_DISCOVERED_TOOLS_PER_SERVER) + 2;
    const registry = Object.fromEntries(
      Array.from({ length: serverCount }, (_, i) => [`s${i}`, { transport: 'stdio' as const, command: 'mock-mcp' }]),
    );

    const defs = await initMcpTools(registry);
    const names = defs.map((d) => d.function.name);

    expect(defs.length).toBe(MAX_DISCOVERED_TOOLS);
    expect(new Set(names).size).toBe(names.length);
    // The last server is the one trimmed, regardless of response order.
    expect(names.some((n) => n.startsWith(`s${serverCount - 1}__`))).toBe(false);
    expect(await callMcpTool(`s${serverCount - 1}__t0`, {})).toEqual({
      content: `MCP tool not registered: s${serverCount - 1}__t0`,
      isError: true,
    });
    expect(warn.mock.calls.some(([msg]) => String(msg).includes(`exceeded ${MAX_DISCOVERED_TOOLS}`))).toBe(true);
    warn.mockRestore();
  });
});

describe('discovery cross-server name collisions', () => {
  it('warns with both server names and routes the collided name to the kept server', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Server "a_" + tool "b" and server "a" + tool "_b" both qualify to "a___b".
    clientMock.listTools.mockResolvedValue({
      tools: [
        { name: 'b', inputSchema: { type: 'object', properties: {} } },
        { name: '_b', inputSchema: { type: 'object', properties: {} } },
      ],
    });

    const defs = await initMcpTools({
      a_: { transport: 'stdio', command: 'mock-mcp-first' },
      a: { transport: 'stdio', command: 'mock-mcp-second' },
    });
    const names = defs.map((d) => d.function.name);

    expect(names.filter((n) => n === 'a___b')).toHaveLength(1);
    expect(warn.mock.calls.some(([msg]) => {
      const text = String(msg);
      return text.includes('"a___b"') && text.includes('server "a"') && text.includes('server "a_"');
    })).toBe(true);

    clientMock.callTool.mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] });
    await expect(callMcpTool('a___b', {})).resolves.toEqual({ content: 'ok', isError: false });
    // Server "a_" was kept, so the call goes out under its own tool name "b".
    expect(clientMock.callTool).toHaveBeenCalledWith(expect.objectContaining({ name: 'b' }));
    warn.mockRestore();
  });
});

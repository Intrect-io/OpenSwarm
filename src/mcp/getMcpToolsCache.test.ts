// ============================================
// OpenSwarm - getMcpTools cache lifetime
// ============================================
//
// getMcpTools cached its first result for the life of the process. If a server
// was briefly unreachable during that call, its tools were absent from every
// later call — no retry, no expiry, nothing short of a manual resetMcpTools().
// A complete discovery should still be cached indefinitely; only an incomplete
// one gets a short lease.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

let home: string;

/** Load mcpClient with ~/.openswarm/mcp.json pointing at a temp registry. */
async function loadClient(servers: Record<string, unknown>) {
  home = mkdtempSync(join(tmpdir(), 'mcp-cache-'));
  mkdirSync(join(home, '.openswarm'), { recursive: true });
  writeFileSync(join(home, '.openswarm', 'mcp.json'), JSON.stringify({ mcpServers: servers }));

  vi.resetModules();
  const mockOs = async (importOriginal: () => Promise<typeof import('node:os')>) => {
    const actual = await importOriginal();
    return { ...actual, default: { ...actual, homedir: () => home }, homedir: () => home };
  };
  vi.doMock('node:os', mockOs);
  vi.doMock('os', mockOs);
  return await import('./mcpClient.js');
}

const stdio = (name: string) => ({ transport: 'stdio', command: 'node', args: [`${name}.js`] });
const oneTool = { tools: [{ name: 'ok', description: '', inputSchema: { type: 'object' } }] };

beforeEach(() => {
  clientMock.listTools.mockReset();
  clientMock.connect.mockClear();
});

afterEach(() => {
  if (home) rmSync(home, { recursive: true, force: true });
  vi.doUnmock('node:os');
  vi.doUnmock('os');
  vi.useRealTimers();
});

describe('getMcpTools caching', () => {
  it('does not re-discover after a complete discovery', async () => {
    const { getMcpTools } = await loadClient({ good: stdio('good') });
    clientMock.listTools.mockResolvedValue(oneTool);

    const first = await getMcpTools();
    const second = await getMcpTools();

    expect(first).toHaveLength(1);
    expect(second).toBe(first);
    expect(clientMock.listTools).toHaveBeenCalledTimes(1);
  });

  // The regression: an incomplete result was kept forever. It should be reused
  // briefly — so a repeated call does not hammer a dead server — and then tried
  // again.
  it('reuses an incomplete discovery only briefly', async () => {
    const { getMcpTools } = await loadClient({ flaky: stdio('flaky') });
    clientMock.listTools.mockRejectedValue(new Error('connection refused'));

    await getMcpTools();
    await getMcpTools();

    expect(clientMock.listTools).toHaveBeenCalledTimes(1);
  });

  it('re-discovers once the short lease expires, and the server can come back', async () => {
    const { getMcpTools } = await loadClient({ flaky: stdio('flaky') });
    clientMock.listTools.mockRejectedValueOnce(new Error('connection refused'));

    const beforeRecovery = await getMcpTools();
    expect(beforeRecovery).toHaveLength(0);

    // The server recovers, and enough time passes for another attempt.
    clientMock.listTools.mockResolvedValue(oneTool);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);

    const afterRecovery = await getMcpTools();

    expect(afterRecovery).toHaveLength(1);
    expect(clientMock.listTools).toHaveBeenCalledTimes(2);
  });

  it('stops re-discovering once a discovery finally completes', async () => {
    const { getMcpTools } = await loadClient({ flaky: stdio('flaky') });
    clientMock.listTools.mockRejectedValueOnce(new Error('down'));
    await getMcpTools();

    clientMock.listTools.mockResolvedValue(oneTool);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_000);
    await getMcpTools();          // recovers
    nowSpy.mockReturnValue(Date.now() + 600_000);
    await getMcpTools();          // must not discover again

    expect(clientMock.listTools).toHaveBeenCalledTimes(2);
  });

  // Unreachable servers are exactly the ones that take a long time to fail, so
  // a discovery can outlast the lease it is about to set. Measuring the lease
  // from when discovery *started* put the deadline in the past, and the next
  // call rediscovered immediately — the lease failed in the very case it
  // exists for.
  it('gives a full lease even when discovery outlasted it', async () => {
    const { getMcpTools } = await loadClient({ flaky: stdio('flaky') });
    const start = Date.now();
    let clock = start;
    vi.spyOn(Date, 'now').mockImplementation(() => clock);

    clientMock.listTools.mockImplementation(async () => {
      // The discovery itself takes longer than INCOMPLETE_DISCOVERY_RETRY_MS.
      clock = start + 120_000;
      throw new Error('timed out');
    });

    await getMcpTools();
    await getMcpTools();   // still inside the lease, must not rediscover

    expect(clientMock.listTools).toHaveBeenCalledTimes(1);
  });

  it('resetMcpTools forces a fresh discovery', async () => {
    const { getMcpTools, resetMcpTools } = await loadClient({ good: stdio('good') });
    clientMock.listTools.mockResolvedValue(oneTool);

    await getMcpTools();
    resetMcpTools();
    await getMcpTools();

    expect(clientMock.listTools).toHaveBeenCalledTimes(2);
  });
});
